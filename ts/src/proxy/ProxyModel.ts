/**
 * ProxyModel:把 proxy 翻译层包成 Model 出口(对接 OpenAI 兼容国产模型 MiMo/豆包)。
 * step 流程:配对清洗 → 出方向翻译 → fetch(stream) → 空闲超时 → 累积 → AssistantStep。
 * 退出决策看"有没有 tool_use"、不看 finish_reason(05 清单⑥)。真实端点/key/网关路由/降级是 W10,这里只留可注入出口。
 */
import { MODEL_OUTPUT_TRUNCATED_NOTICE, type Model, type ModelStepInput, type AssistantStep } from '../types/model'
import { toOpenAiChatRequest, type OpenAIChatImageContentMode } from './toOpenAiChatRequest'
import { accumulateOpenAiStream, type AccumulatedResponse } from './streamAccumulate'
import { openaiChatResponseToAccumulated } from './openaiChatToAnthropic'
import { normalizeMessagesForAPI, ensureToolResultPairing } from './messagePairing'
import { withStreamIdleTimeout } from './streamIdleTimeout'
import type { OpenAIChatRequest, OpenAIChatResponse } from './types'
import type { ReasoningEffort } from '../model/reasoningEffort'
import { fetchWithModelRetry, type ModelRetryOptions } from '../model/fetchRetry'

/**
 * 注入用的最小 fetch 形状——故意不用 `typeof fetch`:bun-types 把 fetch 声明成
 * "函数 + 挂 preconnect 静态方法的 namespace" 合并类型,会强迫测试里的 fake fetch 也得带 preconnect。
 * 这里只留调用签名,globalThis.fetch 结构上兼容、可直接当默认值传入。
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface ProxyModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  imageContentMode?: OpenAIChatImageContentMode
  /** 流空闲超时(默认 60s)。 */
  idleTimeoutMs?: number
  /** 请求头响应前超时。流式 body 的中途卡死另由 idleTimeoutMs 管。 */
  requestTimeoutMs?: number
  /** OpenAI-compatible proxy 透传 reasoning_effort。 */
  reasoningEffort?: ReasoningEffort
  /** 可注入 fetch(测试用 fake;默认 globalThis.fetch)。 */
  fetchImpl?: FetchLike
  /** 缺 tool_call id 时的自造工厂(测试用确定性;默认 streamAccumulate 内置递增)。 */
  idFactory?: (index: number) => string
  /** 瞬时错误(429/5xx/网络抖动)重试退避;默认启用,可注入 sleep 供测试。 */
  retry?: Pick<ModelRetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'sleep'>
  /**
   * 命中输出长度上限(finish_reason=length/max_tokens)且【无 tool_calls】时,升 max_tokens 重试一次的目标值。
   * 默认 ESCALATED_MAX_TOKENS(64k,对齐 cc)。国产上游 max_tokens 上限较低会 400 时可下调。
   */
  escalatedMaxTokens?: number
}

const DEFAULT_IDLE_MS = 60_000

/**
 * 输出撞长度上限时,升级重试的目标 max_tokens(对齐 cc-haha src/utils/context.ts:32 ESCALATED_MAX_TOKENS=64_000)。
 * 默认请求【不带】max_tokens(交国产上游默认,见 toOpenAiChatRequest 注释);仅当"截断且无工具调用"时,
 * 把 max_tokens 升到这个值重试一次(对齐 cc query.ts:1196-1229 的 escalate,每步至多一次)。
 */
export const ESCALATED_MAX_TOKENS = 64_000

export class ProxyModel implements Model {
  constructor(private readonly cfg: ProxyModelConfig) {}

  async step(input: ModelStepInput): Promise<AssistantStep> {
    const cleaned = ensureToolResultPairing(normalizeMessagesForAPI(input.messages))
    const body = toOpenAiChatRequest({
      model: this.cfg.model,
      system: input.system,
      messages: cleaned,
      tools: input.tools,
      stream: true,
      imageContentMode: this.cfg.imageContentMode,
      reasoningEffort: this.cfg.reasoningEffort,
    })

    let read = await this.runOnce(body, input, input.onDelta)

    // 输出撞长度上限的恢复第一步(对齐 cc query.ts:1196-1229 的 escalate):默认请求不带 max_tokens、交上游默认,
    // 若结果被截断(finish_reason=length/max_tokens)【且没有 tool_calls】(纯长正文被切),把 max_tokens 升到
    // escalatedMaxTokens 重试一次。有 tool_calls 时【不】升级重试——那批工具调用要交主循环正常配对执行,
    // 不能被截断吞掉(见 toAssistantStep 顺序 + loop.ts 的 max_output_tokens 续写)。重试不再重复 onDelta:
    // 整段会重发,重复吐正文增量会让前端打字机重影。仍截断则由主循环走"从断点续写"多轮恢复。
    if (isTruncatedFinishReason(read.acc.finishReason) && read.acc.toolCalls.length === 0) {
      const escalated: OpenAIChatRequest = { ...body, max_tokens: this.cfg.escalatedMaxTokens ?? ESCALATED_MAX_TOKENS }
      read = await this.runOnce(escalated, input, undefined)
    }

    return toAssistantStep(read.acc, read.notices)
  }

  /**
   * 一次请求(带超时/可选瞬时重试)+ 读流累积。抽出来供输出上限升级重试复用。
   * 仅当显式配置 cfg.retry 时才做瞬时错误退避重试;默认不改 failover 时序——FallbackModel 已负责跨 provider
   * 快速切换,是否在 provider 内先重试(牺牲切换延迟换单出口韧性)属需按部署权衡的开关,不默认开(见迁移矩阵 §3.401 P1)。
   */
  private async runOnce(
    body: OpenAIChatRequest,
    input: ModelStepInput,
    onDelta: ModelStepInput['onDelta'],
  ): Promise<{ acc: AccumulatedResponse; notices?: string[] }> {
    const doRequest = () => this.fetchWithTimeout(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
    }, input.signal)
    const resp = this.cfg.retry
      ? await fetchWithModelRetry(doRequest, { signal: input.signal, ...this.cfg.retry })
      : await doRequest()

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`模型请求失败 ${resp.status}:${detail.slice(0, 500)}`)
    }

    return this.readResponse(resp, onDelta)
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
        throw new Error(signal?.aborted ? '模型请求已中断' : `模型请求超时 ${this.cfg.requestTimeoutMs}ms`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async readResponse(resp: Response, onDelta?: ModelStepInput['onDelta']): Promise<{ acc: AccumulatedResponse; notices?: string[] }> {
    const ct = resp.headers.get('content-type') ?? ''
    if (ct.includes('text/event-stream') && resp.body) {
      const guarded = withStreamIdleTimeout(resp.body, this.cfg.idleTimeoutMs ?? DEFAULT_IDLE_MS)
      return { acc: await accumulateOpenAiStream(guarded, { idFactory: this.cfg.idFactory, onDelta }) }
    }
    // 非 SSE(错误体已在上面拦掉;这里是 200 但 JSON 的兼容上游)。belt-and-suspenders:整段不可解析
    // (非 JSON / 结构畸形到翻译层也兜不住)时降级空结果,不让 step() 崩出去——SSE 分支的空闲超时+
    // 逐行跳过、以及非 2xx 的抛错分支不受影响。
    try {
      const json = (await resp.json()) as OpenAIChatResponse
      return {
        acc: openaiChatResponseToAccumulated(json, { idFactory: this.cfg.idFactory }),
        notices: ['供应商本轮没有按流式返回,已自动按完整响应接回。'],
      }
    } catch {
      return {
        acc: { text: '', thinking: '', toolCalls: [], finishReason: null },
        notices: ['供应商本轮返回了非流式但内容不可解析,已安全降级为空响应。'],
      }
    }
  }
}

/** 累积结果 → AssistantStep。kind 看 toolCalls 有无(needsFollowUp),不看 finishReason。 */
function toAssistantStep(acc: AccumulatedResponse, notices?: string[]): AssistantStep {
  const thinking = acc.thinking ? { thinking: acc.thinking } : {}
  const usage = acc.usage ? { usage: acc.usage } : {}
  const allNotices = [...(notices ?? []), ...(isTruncatedFinishReason(acc.finishReason) ? [MODEL_OUTPUT_TRUNCATED_NOTICE] : [])]
  const noticeField = allNotices.length ? { notices: allNotices } : {}
  // 截断判定挪到 tool_calls 之后(修长代码生成硬伤):截断时若已经拿到 tool_calls,不能当 final 吞掉——
  // 要照常返回 tool_calls 让主循环配对执行(截断提示仍随附,让上层知情);纯正文被截断(无工具调用)才走 final,
  // 后续"从断点续写"由 loop.ts 的 max_output_tokens 恢复接手。
  if (acc.toolCalls.length > 0) {
    return { kind: 'tool_calls', ...(acc.text ? { text: acc.text } : {}), ...thinking, calls: acc.toolCalls, ...usage, ...noticeField }
  }
  return { kind: 'final', text: acc.text, ...thinking, ...usage, ...noticeField }
}

function isTruncatedFinishReason(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens'
}
