import { MODEL_OUTPUT_TRUNCATED_NOTICE, type Model, type ModelStepInput, type AssistantStep } from '../types/model'
import type { ContentBlock, DocumentBlock, ImageBlock, Message, ToolCall } from '../types/message'
import { ensureToolResultPairing, normalizeMessagesForAPI } from '../proxy/messagePairing'
import { parseOpenAIToolArguments, stringifyOpenAIToolArguments } from '../proxy/toolArguments'
import type { AnthropicUsage } from '../proxy/types'
import { ESCALATED_MAX_TOKENS, type FetchLike } from '../proxy/ProxyModel'
import type { ProviderAuthStrategy } from './providerConfig'
import { fetchWithModelRetry, type ModelRetryOptions } from './fetchRetry'
import { buildAnthropicThinking, type ReasoningEffort } from './reasoningEffort'

export interface AnthropicMessagesModelConfig {
  baseUrl: string
  model: string
  apiKey?: string
  authToken?: string
  authStrategy?: ProviderAuthStrategy
  maxTokens?: number
  requestTimeoutMs?: number
  stream?: boolean
  /**
   * "深度思考/增强"档。⚠️注意:thinking 现已与 reasoningEffort **解耦**(对齐 cc,默认开)——本字段不再决定
   * 是否/如何思考(那由 buildAnthropicThinking 按模型 + env 判定),仅作为透传给上游 output_config.effort 的占位
   * (Anthropic 端点映射见任务 #68);OpenAI 兼容端点走 ProxyModel 的 reasoning_effort。保留字段供 modelFactory 透传。
   */
  reasoningEffort?: ReasoningEffort
  fetchImpl?: FetchLike
  /** 瞬时错误(429/5xx/网络抖动)重试退避;默认启用,可注入 sleep 供测试。 */
  retry?: Pick<ModelRetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep'>
  /**
   * 命中输出长度上限(stop_reason=max_tokens / model_context_window_exceeded)且【无 tool_calls】时,
   * 升 max_tokens 重试一次的目标值。默认 ESCALATED_MAX_TOKENS(64k,对齐 cc)。
   */
  escalatedMaxTokens?: number
}

interface AnthropicAccumulated {
  text: string
  thinking: string
  toolCalls: ToolCall[]
  stopReason?: string | null
  usage?: AnthropicUsage
}

type AnthropicImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
type AnthropicDocumentBlock = { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
type AnthropicToolResultContentBlock = { type: 'text'; text: string } | AnthropicImageBlock
type AnthropicRequestBlock =
  | { type: 'text'; text: string }
  | AnthropicImageBlock
  | AnthropicDocumentBlock
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicToolResultContentBlock[]; is_error?: boolean }

type AnthropicResponseContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }

interface AnthropicResponseJson {
  content?: AnthropicResponseContentBlock[]
  stop_reason?: string | null
  usage?: Partial<AnthropicUsage>
}

const DEFAULT_MAX_TOKENS = 4096
const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicMessagesModel implements Model {
  constructor(private readonly cfg: AnthropicMessagesModelConfig) {}

  async step(input: ModelStepInput): Promise<AssistantStep> {
    const messages = ensureToolResultPairing(normalizeMessagesForAPI(input.messages))
    const baseMaxTokens = this.cfg.maxTokens ?? DEFAULT_MAX_TOKENS
    const buildBody = (maxTokens: number) => {
      // thinking 默认开、与 reasoningEffort 解耦(掰回 cc claude.ts:1653-1736 的分叉):默认就发 thinking
      // (adaptive 模型→{type:'adaptive'};budget 模型→模型默认预算),仅等价 CLAUDE_CODE_DISABLE_THINKING /
      // ANTHROPIC_THINKING_MODE=off 时才不发。budget_tokens 随 maxTokens 夹紧,故在这里(拿到本次 maxTokens 后)算,
      // 升级重试的更大 maxTokens 也能给更大预算。
      const thinking = buildAnthropicThinking(this.cfg.model, maxTokens)
      return {
        model: this.cfg.model,
        max_tokens: maxTokens,
        stream: this.cfg.stream !== false,
        ...(thinking ? { thinking } : {}),
        ...(input.system ? { system: input.system } : {}),
        messages: messages.map(toAnthropicMessage),
        ...(input.tools.length > 0 ? { tools: input.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })) } : {}),
      }
    }

    // 首发带 onDelta:边流边逐 token 吐正文/推理增量(对齐 cc,与 ProxyModel 出口一致,让前端打字机)。
    let acc = await this.runOnce(buildBody(baseMaxTokens), input, input.onDelta)

    // 输出撞长度上限的恢复第一步(对齐 cc query.ts:1196-1229 escalate + utils/context.ts:32 ESCALATED_MAX_TOKENS=64k):
    // stop_reason=max_tokens / model_context_window_exceeded(cc claude.ts:2448-2461 把后者也并进同一"从断点续写"恢复路径)
    // 且【无 tool_calls】(纯长正文被切)时,把 max_tokens 从默认升到 escalatedMaxTokens 重试一次(每步至多一次)。
    // 有 tool_calls 则不重试——那批工具调用要交主循环配对执行(见 toAssistantStep 顺序),不能被截断吞掉;
    // 仍截断则由主循环走多轮"从断点续写"恢复(loop.ts,上限 3 次)。Math.max 防把已设的更高上限降回去。
    // 重试【不】再传 onDelta:整段会重发,重复吐正文增量会让前端打字机重影(对齐 ProxyModel)。
    if (isTruncatedStopReason(acc.stopReason) && acc.toolCalls.length === 0) {
      const escalated = Math.max(baseMaxTokens, this.cfg.escalatedMaxTokens ?? ESCALATED_MAX_TOKENS)
      acc = await this.runOnce(buildBody(escalated), input, undefined)
    }

    return toAssistantStep(acc)
  }

  /** 一次请求(带超时/可选瞬时重试)+ 读流累积。抽出来供输出上限升级重试复用。onDelta 逐 token 流式回调,升级重试时传 undefined。 */
  private async runOnce(body: unknown, input: ModelStepInput, onDelta: ModelStepInput['onDelta']): Promise<AnthropicAccumulated> {
    // 仅当显式配置 cfg.retry 时才做瞬时错误退避重试(默认不改 failover 时序,理由同 ProxyModel)。
    const doRequest = () => this.fetchWithTimeout(this.messagesEndpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    }, input.signal)
    const resp = this.cfg.retry
      ? await fetchWithModelRetry(doRequest, { signal: input.signal, ...this.cfg.retry })
      : await doRequest()

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`Anthropic 模型请求失败 ${resp.status}:${detail.slice(0, 500)}`)
    }

    return this.readResponse(resp, onDelta)
  }

  private messagesEndpoint(): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, '')
    return base.endsWith('/messages') ? base : `${base}/messages`
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    }

    const key = this.cfg.apiKey ?? ''
    const token = this.cfg.authToken ?? key
    switch (this.cfg.authStrategy) {
      case 'auth_token':
      case 'auth_token_empty_api_key':
        if (token) headers.authorization = `Bearer ${token}`
        break
      case 'dual_same_token':
        if (token) {
          headers['x-api-key'] = token
          headers.authorization = `Bearer ${token}`
        }
        break
      case 'dual_dummy':
        headers['x-api-key'] = 'dummy'
        headers.authorization = 'Bearer dummy'
        break
      case 'api_key':
      default:
        if (key) headers['x-api-key'] = key
        else if (this.cfg.authToken) headers.authorization = `Bearer ${this.cfg.authToken}`
        break
    }
    return headers
  }

  private async fetchWithTimeout(input: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const doFetch = this.cfg.fetchImpl ?? globalThis.fetch
    if (!this.cfg.requestTimeoutMs && !signal) return doFetch(input, init)
    if (!this.cfg.requestTimeoutMs) return doFetch(input, { ...init, signal })

    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs)
    try {
      return await doFetch(input, { ...init, signal: controller.signal })
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        throw new Error(signal?.aborted ? 'Anthropic 模型请求已中断' : `Anthropic 模型请求超时 ${this.cfg.requestTimeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async readResponse(resp: Response, onDelta?: ModelStepInput['onDelta']): Promise<AnthropicAccumulated> {
    const contentType = resp.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream') && resp.body) {
      return accumulateAnthropicStream(resp.body, onDelta)
    }
    // 非 SSE(完整 JSON 响应):无逐 token 增量可吐(与 ProxyModel 非流式分支一致),整段由 AssistantStep 收尾。
    const json = (await resp.json().catch(() => ({}))) as AnthropicResponseJson
    return anthropicJsonToAccumulated(json)
  }
}

function toAnthropicMessage(message: Message): { role: Message['role']; content: AnthropicRequestBlock[] } {
  const content = message.content.flatMap(toAnthropicBlock)
  return { role: message.role, content: content.length > 0 ? content : [{ type: 'text', text: '' }] }
}

function toAnthropicBlock(block: ContentBlock): AnthropicRequestBlock[] {
  if (block.type === 'text') return [{ type: 'text', text: block.text }]
  if (block.type === 'image') return [{ type: 'image', source: block.source }]
  if (block.type === 'document') return [toAnthropicDocumentBlock(block)]
  if (block.type === 'tool_use') return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
  if (block.type === 'tool_result') {
    return [{
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      // string → 原样;块数组(多模态)→ 逐块映射成 Anthropic text/image content-block(真 vision 回灌)。
      content: typeof block.content === 'string' ? block.content : block.content.map(toAnthropicToolResultContentBlock),
      ...(block.is_error ? { is_error: true } : {}),
    }]
  }
  return []
}

/**
 * PDF document 块。查证(2026-07 官方文档):MiniMax(api.minimaxi.com/anthropic:只 text/image/video/tool_use/tool_result/thinking)
 * 与 Xiaomi MiMo(api.xiaomimimo.com/anthropic)的 Anthropic 兼容端点都【不支持】document/PDF 块——直接发真 document
 * 块会被上游丢弃或 400。**默认因此不发真块**,改回灌一条文本面包屑,纠正 fileReadTool 里 `<file_pdf>` "已作为视觉块发送"
 * 的误导说明(反逻辑修:此前 `return []` 静默丢块,模型被告知能看 PDF、实际啥也没收到,只能凭空编)。
 * 真正跑在支持 document 的 Anthropic 端点(真 Claude / 能力齐全的代理)时,置 `ANTHROPIC_SEND_PDF_DOCUMENT=1` 发真块。
 */
function toAnthropicDocumentBlock(block: DocumentBlock): AnthropicRequestBlock {
  if (isEnvTruthy(process.env.ANTHROPIC_SEND_PDF_DOCUMENT)) {
    return { type: 'document', source: block.source }
  }
  return {
    type: 'text',
    text: '[系统提示] 已附加一个 PDF 文档,但当前模型端点不支持 PDF 视觉通道,无法直接查看其图像内容;请依据上文 <file_pdf> 元信息作答,或改用可抽取 PDF 文本的工具处理后再读。',
  }
}

/** env 真值判定(1/true/yes/on,大小写无关)。 */
function isEnvTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

function toAnthropicToolResultContentBlock(block: { type: 'text'; text: string } | ImageBlock): AnthropicToolResultContentBlock {
  return block.type === 'image'
    ? { type: 'image', source: block.source }
    : { type: 'text', text: block.text }
}

function anthropicJsonToAccumulated(json: AnthropicResponseJson): AnthropicAccumulated {
  let text = ''
  let thinking = ''
  const toolCalls: ToolCall[] = []
  for (const block of json.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking
    else if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, input: parseToolInput(block.input) })
    }
  }
  return { text, thinking, toolCalls, stopReason: json.stop_reason ?? null, usage: normalizeUsage(json.usage) }
}

function parseToolInput(input: unknown): Record<string, unknown> {
  return parseOpenAIToolArguments(input)
}

function normalizeUsage(usage: Partial<AnthropicUsage> | undefined): AnthropicUsage | undefined {
  if (!usage) return undefined
  return {
    input_tokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
    output_tokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
    ...(typeof usage?.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
    ...(typeof usage?.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
  }
}

interface StreamFrag {
  type: string
  text: string
  thinking: string
  id: string
  name: string
  input: unknown
  argsBuffer: string
  order: number
}

/**
 * 读 Anthropic messages SSE 流并累积成 AnthropicAccumulated。
 * onDelta:逐 token 流式回调——content_block_delta 的 text_delta/thinking_delta 一到就即刻吐增量(前端打字机),
 * 对齐 cc 与 ProxyModel 出口。工具入参(input_json_delta)不吐——那不是用户可见正文。空增量不吐(空 delta 边界)。
 * 跨网络 chunk 切断的行由 buffer 兜住(见 processLine 循环),跨 delta 切断的工具 JSON 由 argsBuffer 累积。
 */
async function accumulateAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (delta: { channel: 'text' | 'thinking'; text: string }) => void,
): Promise<AnthropicAccumulated> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ''
  let orderSeq = 0
  let usage: AnthropicUsage | undefined
  let stopReason: string | null = null
  const frags = new Map<number, StreamFrag>()

  const fragFor = (index: number): StreamFrag => {
    let frag = frags.get(index)
    if (!frag) {
      frag = { type: '', text: '', thinking: '', id: '', name: '', input: undefined, argsBuffer: '', order: orderSeq++ }
      frags.set(index, frag)
    }
    return frag
  }

  const handleEvent = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') return
    const event = payload as Record<string, unknown>
    const index = typeof event.index === 'number' ? event.index : 0

    if (event.type === 'content_block_start') {
      const block = event.content_block as Record<string, unknown> | undefined
      if (!block || typeof block !== 'object') return
      const frag = fragFor(index)
      frag.type = typeof block.type === 'string' ? block.type : frag.type
      // content_block_start 一般 text/thinking 为空;若上游把首段正文塞在这里,也逐 token 吐出去别漏(非空才吐)。
      if (typeof block.text === 'string') { frag.text += block.text; if (block.text) onDelta?.({ channel: 'text', text: block.text }) }
      if (typeof block.thinking === 'string') { frag.thinking += block.thinking; if (block.thinking) onDelta?.({ channel: 'thinking', text: block.thinking }) }
      if (typeof block.id === 'string') frag.id = block.id
      if (typeof block.name === 'string') frag.name = block.name
      if ('input' in block) frag.input = block.input
      return
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (!delta || typeof delta !== 'object') return
      const frag = fragFor(index)
      // text_delta/thinking_delta:即刻逐 token 吐增量(空串不吐,空 delta 边界不产事件);工具 input_json_delta 只累积不吐。
      if (delta.type === 'text_delta' && typeof delta.text === 'string') { frag.text += delta.text; if (delta.text) onDelta?.({ channel: 'text', text: delta.text }) }
      else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') { frag.thinking += delta.thinking; if (delta.thinking) onDelta?.({ channel: 'thinking', text: delta.thinking }) }
      else if (delta.type === 'input_json_delta') frag.argsBuffer += stringifyOpenAIToolArguments(delta.partial_json)
      return
    }

    if (event.type === 'message_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta && typeof delta.stop_reason === 'string') stopReason = delta.stop_reason
      if (event.usage && typeof event.usage === 'object') usage = normalizeUsage(event.usage as Partial<AnthropicUsage>)
    }
  }

  const processLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return
    const raw = trimmed.slice(trimmed.indexOf(':') + 1).trim()
    if (!raw || raw === '[DONE]') return
    try {
      handleEvent(JSON.parse(raw) as unknown)
    } catch {
      return
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    }
    if (buffer) processLine(buffer)
  } finally {
    reader.releaseLock()
  }

  let text = ''
  let thinking = ''
  const toolCalls: ToolCall[] = []
  for (const frag of [...frags.values()].sort((a, b) => a.order - b.order)) {
    if (frag.type === 'text') text += frag.text
    else if (frag.type === 'thinking') thinking += frag.thinking
    else if (frag.type === 'tool_use' && frag.id && frag.name) {
      toolCalls.push({
        id: frag.id,
        name: frag.name,
        input: frag.argsBuffer ? parseToolInput(frag.argsBuffer) : parseToolInput(frag.input),
      })
    }
  }
  return { text, thinking, toolCalls, stopReason, usage }
}

/** 截断判定:stop_reason=max_tokens(输出上限)/ model_context_window_exceeded(上下文窗口耗尽,cc claude.ts:2448-2461
 *  复用同一"从断点续写"恢复路径)都当截断处理。 */
function isTruncatedStopReason(reason: string | null | undefined): boolean {
  return reason === 'max_tokens' || reason === 'model_context_window_exceeded'
}

function toAssistantStep(acc: AnthropicAccumulated): AssistantStep {
  const thinking = acc.thinking ? { thinking: acc.thinking } : {}
  const usage = acc.usage ? { usage: acc.usage } : {}
  const noticeField = isTruncatedStopReason(acc.stopReason) ? { notices: [MODEL_OUTPUT_TRUNCATED_NOTICE] } : {}
  // 截断判定挪到 tool_calls 之后(修长代码生成硬伤):截断时若已拿到 tool_calls,不能当 final 吞掉——
  // 照常返回 tool_calls 让主循环配对执行(截断提示随附让上层知情);纯正文被截断(无工具调用)才走 final,
  // 后续"从断点续写"由 loop.ts 的 max_output_tokens 恢复接手。
  if (acc.toolCalls.length > 0) {
    return { kind: 'tool_calls', ...(acc.text ? { text: acc.text } : {}), ...thinking, calls: acc.toolCalls, ...usage, ...noticeField }
  }
  return { kind: 'final', text: acc.text, ...thinking, ...usage, ...noticeField }
}
