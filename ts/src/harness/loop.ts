import type { AgentEvent } from '../types/events'
import type { Message, ContentBlock, ToolResultBlock, ToolCall } from '../types/message'
import { textBlock, toolUseBlock, toolResultBlock, userText } from '../types/message'
import type { Model } from '../types/model'
import type { ToolContext } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { PermissionMode } from '../permissions/types'
import { APPROVAL_PENDING_MSG, DENIAL_FALLBACK_MSG, resolvePermission } from '../permissions/resolve'
import { actionKey, clearDenial, recordDenial, shouldStopAsking } from '../permissions/denialTracking'
import { signApproval, verifyApproval } from '../permissions/approval'
import { collectReminders, drainSteering, extendTurns, steerBlock, wrapReminder } from './reminders'
import { formatTodoChecklist, parseProgressMarkdown } from '../types/todo'
import { compactPipeline, looksLikeContextOverflow } from '../context/compaction'
import { callKey, detectStuck, MAX_SAME_CALL, sameCallGuardMessage } from './stuckDetector'
import {
  isAskUserQuestionToolName,
  isExitPlanToolName,
  isPlanApprovalAnswer,
  normalizeAskUserQuestion,
  normalizeExitPlanQuestion,
  questionEvent,
} from '../tools/agentInteractionTools'
import {
  applyPostToolUseHooks,
  applyPreToolUseHooks,
  applySessionStartHooks,
  applyStopHooks,
  applyUserPromptSubmitHooks,
  type HookRegistry,
} from '../hooks/hooks'

export interface TranscriptLike {
  load(): Promise<Message[]>
  captureBaselineLen(): Promise<number>
  savePreservingExternalTail(messages: Message[], baselineLen: number): Promise<void>
}

export interface RunAgentLoopOptions {
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  userMessage: string
  initialMessages?: Message[]
  maxTurns?: number
  signal?: AbortSignal
  sandbox?: Sandbox
  permissionMode?: PermissionMode
  conversationId?: string
  steerInbox?: string[]
  contextWindowChars?: number
  transcript?: TranscriptLike
  hooks?: HookRegistry
}

/**
 * 真 ReAct 主循环(照 cc-haha query.ts / 现有 loop.py),内核 = Anthropic content-block:
 * think → 有 tool_use 就逐个过权限闸执行 → 一批 tool_result 装单条 user 消息回灌 → 再 think,直到收敛或 max_turns。
 * 退出信号看"有没有 tool_use 块"(kind==='tool_calls'),不信 finish_reason(05 清单⑥)。
 * 工具错误一律 <tool_use_error>+is_error 回灌不崩循环。system 走 ModelStepInput 独立字段。
 */
export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { model, registry } = opts
  const maxTurns = opts.maxTurns ?? 12
  let transcriptBaseline = 0
  let history: Message[] = opts.initialMessages ?? []
  if (opts.transcript) {
    try {
      transcriptBaseline = await opts.transcript.captureBaselineLen()
      history = await opts.transcript.load()
    } catch {
      history = opts.initialMessages ?? []
    }
  }
  const ctx: ToolContext = {
    workspace: opts.workspace,
    signal: opts.signal,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode ?? 'ask',
    conversationId: opts.conversationId,
    autoSpendCount: 0,
    steerInbox: opts.steerInbox ?? [],
    todos: [],
    requestsSinceProgress: 0,
  }
  let system = opts.systemPrompt
  const sessionStart = await applySessionStartHooks(opts.hooks, ctx)
  for (const extra of sessionStart.additionalContext) {
    yield { type: 'context_note', text: extra }
  }
  if (sessionStart.additionalContext.length > 0) {
    system = `${system}\n\n${hookContextBlock('SessionStart', sessionStart.additionalContext)}`
  }

  const userPrompt = await applyUserPromptSubmitHooks(opts.hooks, opts.userMessage, ctx)
  for (const extra of userPrompt.additionalContext) {
    yield { type: 'context_note', text: extra }
  }
  let messages: Message[]
  if (userPrompt.deniedMessage) {
    const text = `请求被 hook 拦截:${userPrompt.deniedMessage}`
    messages = [...history, { role: 'assistant', content: [textBlock(text)] }]
    if (opts.transcript) {
      try {
        await opts.transcript.savePreservingExternalTail(messages, transcriptBaseline)
      } catch {
        // hook 拦截后的落盘失败不能拖垮响应。
      }
    }
    yield { type: 'context_note', text }
    const stopHook = await applyStopHooks(opts.hooks, text, ctx)
    for (const extra of stopHook.additionalContext) yield { type: 'context_note', text: extra }
    yield { type: 'final', text }
    return
  }
  const userContent: ContentBlock[] = []
  if (userPrompt.additionalContext.length > 0) {
    userContent.push(textBlock(hookContextBlock('UserPromptSubmit', userPrompt.additionalContext)))
  }
  userContent.push(textBlock(userPrompt.userPrompt))
  messages = [...history, { role: 'user', content: userContent }]
  const readOnlyToolNames = new Set(registry.list().filter(t => t.isReadOnly).map(t => t.name))
  let compactionFailures = 0
  let sameKey = ''
  let sameKeyCount = 0
  let toolCallsNoProgress = 0
  let stuckNotified = false

  const saveTranscript = async () => {
    if (!opts.transcript) return
    try {
      await opts.transcript.savePreservingExternalTail(messages, transcriptBaseline)
    } catch {
      // transcript 是跨轮记忆底座,但写失败不能拖垮当前任务。
    }
  }

  const maybeCompact = async (force = false): Promise<string | undefined> => {
    const out = await compactPipeline({
      messages,
      model,
      system,
      contextWindowChars: opts.contextWindowChars,
      readOnlyToolNames,
      compactionFailures,
      force,
    })
    messages = out.messages
    compactionFailures = out.compactionFailures
    return out.didCompact ? out.note : undefined
  }

  let turnsLimit = maxTurns
  let turn = 0
  while (turn < turnsLimit) {
    const compactNote = await maybeCompact(false)
    if (compactNote) yield { type: 'context_note', text: compactNote }

    let step: Awaited<ReturnType<Model['step']>>
    try {
      step = await model.step({ system, messages, tools: registry.specs(), signal: opts.signal })
    } catch (err) {
      if (!looksLikeContextOverflow(err)) throw err
      const note = await maybeCompact(true)
      if (!note) throw err
      yield { type: 'context_note', text: note }
      step = await model.step({ system, messages, tools: registry.specs(), signal: opts.signal })
    }

    if (step.kind === 'final') {
      if (step.thinking) yield { type: 'thinking', text: step.thinking }
      messages.push({ role: 'assistant', content: [textBlock(step.text)] })
      // steering 优先于收尾:模型想结束但收件箱有插话 → 灌进去接着跑
      const drained = drainSteering(ctx)
      if (drained.length) {
        messages.push({ role: 'user', content: drained.map(steerBlock) })
        for (const m of drained) yield { type: 'steering', content: m }
        turnsLimit = extendTurns(turnsLimit, maxTurns, drained.length)
        turn++
        continue
      }
      await saveTranscript()
      const stopHook = await applyStopHooks(opts.hooks, step.text, ctx)
      for (const extra of stopHook.additionalContext) yield { type: 'context_note', text: extra }
      yield { type: 'final', text: step.text }
      return
    }

    // 展示:reasoning + 正文叙述合成一条 thinking 事件(保证每步≤1条,前端细分事件归 W16)
    const display = [step.thinking, step.text].filter(Boolean).join('\n\n')
    if (display) yield { type: 'thinking', text: display }

    // assistant 历史块:正文 text(若有)+ tool_use 块(thinking 不进历史、不回灌模型)
    const asstContent: ContentBlock[] = []
    if (step.text) asstContent.push(textBlock(step.text))
    for (const c of step.calls) asstContent.push(toolUseBlock(c))
    messages.push({ role: 'assistant', content: asstContent })

    // 逐个过闸,tool_result 块累积;稍后装单条 user 消息(tool_result 紧贴 tool_use)
    const toolResults: ToolResultBlock[] = []
    for (const call of step.calls) {
      const progress = popTaskProgress(call.input)
      if (progress !== null) {
        ctx.todos = parseProgressMarkdown(progress)
        ctx.requestsSinceProgress = 0
        toolCallsNoProgress = 0
        stuckNotified = false
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos) }
      }
      yield { type: 'tool_call', tool: call.name, input: call.input }
      const k = callKey(call.name, call.input)
      sameKeyCount = k === sameKey ? sameKeyCount + 1 : 1
      sameKey = k
      if (sameKeyCount >= MAX_SAME_CALL) {
        const output = sameCallGuardMessage(call.name)
        toolResults.push(toolResultBlock(call.id, output, false))
        yield { type: 'tool_result', tool: call.name, output }
      } else {
        yield* gateOneCall(registry, call, ctx, toolResults, opts.hooks)
      }
      if (call.name === 'todo_write') {
        ctx.requestsSinceProgress = 0
        toolCallsNoProgress = 0
        stuckNotified = false
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos ?? []) }
      } else {
        ctx.requestsSinceProgress = (ctx.requestsSinceProgress ?? 0) + 1
        toolCallsNoProgress++
      }
    }

    // 单条 user 消息:一批 tool_result 块 + steering + reminder(都作 text 块尾随)
    const followup: ContentBlock[] = [...toolResults]
    const drained = drainSteering(ctx)
    if (drained.length) {
      for (const m of drained) {
        followup.push(steerBlock(m))
        yield { type: 'steering', content: m }
      }
      turnsLimit = extendTurns(turnsLimit, maxTurns, drained.length)
    }
    for (const r of collectReminders(ctx)) {
      followup.push(textBlock(wrapReminder(r.text)))
      if (r.kind === 'progress') ctx.requestsSinceProgress = 0
    }
    if (!stuckNotified) {
      const finding = detectStuck(messages, { totalToolCallsNoProgress: toolCallsNoProgress })
      if (finding) {
        followup.push(textBlock(wrapReminder(finding.message)))
        yield { type: 'context_note', text: finding.message }
        stuckNotified = true
      }
    }
    messages.push({ role: 'user', content: followup })
    turn++
  }

  // max_turns 兜底:强制一次无工具收敛(照 loop.py 的 _FINAL_NUDGE 哲学)。
  const forced = await model.step({ system, messages, tools: [], signal: opts.signal })
  const text = forced.kind === 'final' ? forced.text : '(已达最大轮次,未能收敛)'
  messages.push({ role: 'assistant', content: [textBlock(text)] })
  await saveTranscript()
  const stopHook = await applyStopHooks(opts.hooks, text, ctx)
  for (const extra of stopHook.additionalContext) yield { type: 'context_note', text: extra }
  yield { type: 'final', text }
}

function hookContextBlock(event: string, contexts: string[]): string {
  return `<hook_context event="${event}">\n${contexts.join('\n\n')}\n</hook_context>`
}

/** 剥离工具入参里的 task_progress(Cline Focus-Chain 内联清单,非真工具参数)。原地删并返回其字符串;无则 null。永不抛。 */
function popTaskProgress(input: unknown): string | null {
  if (input && typeof input === 'object' && 'task_progress' in input) {
    const o = input as Record<string, unknown>
    const p = o.task_progress
    delete o.task_progress
    return typeof p === 'string' ? p : null
  }
  return null
}

/**
 * 单个 tool_call:权限闸(deny/ask/allow)→ 相应事件 + 累积 tool_result 块。ask=提案模式,不执行不阻塞。
 * 工具执行/未知工具/异常 → is_error:true + <tool_use_error> 包壳回灌(OpenAI 侧没有 is_error 字段,
 * 文本包壳是国产模型能看到的唯一报错信号);权限类消息(deny/pending)= 普通 tool_result 不当报错。
 */
async function* gateOneCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
  toolResults: ToolResultBlock[],
  hooks?: HookRegistry,
): AsyncGenerator<AgentEvent> {
  const feedback = (output: string, isError = false, modelContent = output): AgentEvent => {
    const content = isError ? `<tool_use_error>\n${modelContent}\n</tool_use_error>` : modelContent
    toolResults.push(toolResultBlock(call.id, content, isError))
    return { type: 'tool_result', tool: call.name, output }
  }

  const tool = registry.get(call.name)
  if (!tool) {
    yield feedback(`错误:未知工具 ${call.name}`, true)
    return
  }

  if (isAskUserQuestionToolName(call.name)) {
    try {
      const question = normalizeAskUserQuestion(call.input, call.id)
      const answerStartLen = ctx.steerInbox?.length ?? 0
      yield questionEvent(question)
      const answer = await waitForSteeringAnswer(ctx, question.timeoutMs, answerStartLen)
      yield feedback(answer ? `<user_answer>\n${answer}\n</user_answer>` : '<user_answer status="timeout" />', false)
    } catch (err) {
      yield feedback(`错误:${err instanceof Error ? err.message : String(err)}`, true)
    }
    return
  }

  if (isExitPlanToolName(call.name)) {
    try {
      const { plan, question } = normalizeExitPlanQuestion(call.input, call.id)
      const answerStartLen = ctx.steerInbox?.length ?? 0
      yield questionEvent(question)
      const answer = await waitForSteeringAnswer(ctx, question.timeoutMs, answerStartLen)
      if (answer && isPlanApprovalAnswer(answer)) {
        ctx.permissionMode = 'ask'
        yield feedback(`<plan_approved>\n${plan}\n</plan_approved>\n用户已批准计划,当前回合已退出计划模式并切到 ask 权限档。`, false)
      } else if (answer) {
        yield feedback(`<plan_needs_revision>\n${answer}\n</plan_needs_revision>`, false)
      } else {
        yield feedback('<plan_approval status="timeout" />', false)
      }
    } catch (err) {
      yield feedback(`错误:${err instanceof Error ? err.message : String(err)}`, true)
    }
    return
  }

  const hookResult = await applyPreToolUseHooks(hooks, call.name, call.input, ctx)
  for (const extra of hookResult.additionalContext) {
    yield { type: 'context_note', text: extra }
  }
  if (hookResult.deniedMessage) {
    yield feedback(`[hook 拦截] ${hookResult.deniedMessage}`, false)
    return
  }
  const hookInput = hookResult.input

  const decision = resolvePermission(tool, hookInput, ctx)
  if (decision.behavior === 'deny') {
    yield feedback(decision.message, false)
    return
  }
  if (decision.behavior === 'ask') {
    const key = actionKey(call.name, hookInput)
    if (shouldStopAsking(ctx.conversationId, key)) {
      yield feedback(DENIAL_FALLBACK_MSG(call.name), false)
      return
    }
    let preview: string | undefined
    try {
      preview = (await tool.previewFor?.(hookInput, ctx)) ?? undefined
    } catch {
      preview = undefined
    }
    yield {
      type: 'approval_request',
      tool: call.name,
      args: hookInput,
      id: call.id,
      token: signApproval(call.name, hookInput),
      preview,
      reason: decision.approvalReason,
    }
    yield feedback(APPROVAL_PENDING_MSG(call.name), false)
    return
  }

  // allow:full 档下自动放行的 spend 类累加计数(过 AUTO_SPEND_LIMIT 后 resolvePermission 会改判 ask)。
  if (tool.approvalClass === 'spend' && ctx.permissionMode === 'full') {
    ctx.autoSpendCount = (ctx.autoSpendCount ?? 0) + 1
  }
  const input = decision.updatedInput ?? hookInput
  try {
    const output = await tool.execute(input, ctx)
    const postHook = await applyPostToolUseHooks(hooks, call.name, input, output, ctx)
    for (const extra of postHook.additionalContext) {
      yield { type: 'context_note', text: extra }
    }
    const modelContent = postHook.additionalContext.length > 0
      ? `${output}\n\n${hookContextBlock('PostToolUse', postHook.additionalContext)}`
      : output
    yield feedback(output, false, modelContent)
  } catch (err) {
    yield feedback(`错误:工具 ${tool.name} 执行失败:${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/**
 * 审批确认后的真执行入口(给独立 /agent/execute 用):验 token → 清该动作拒绝计数 → 跑工具。
 * token 不匹配一律拒(不信任前端回传的 args)。返回纯 output 字符串——把它包成 tool_result 块重注入会话是
 * 审批恢复流(W5/server)的活,本层不扩责。
 */
export async function executeApproved(
  registry: ToolRegistry,
  tool: string,
  args: unknown,
  token: string | null | undefined,
  ctx: ToolContext,
): Promise<{ ok: boolean; output: string }> {
  if (!verifyApproval(tool, args, token)) return { ok: false, output: '审批校验失败:token 与动作不匹配,拒绝执行。' }
  clearDenial(ctx.conversationId, actionKey(tool, args))
  const t = registry.get(tool)
  if (!t) return { ok: false, output: `未知工具 ${tool}` }
  try {
    return { ok: true, output: await t.execute(args, ctx) }
  } catch (err) {
    return { ok: false, output: `工具 ${tool} 执行失败:${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 老板拒绝某审批(给独立 /agent/reject 用):记一次拒绝,喂给下次的 shouldStopAsking。 */
export function handleReject(tool: string, args: unknown, ctx: ToolContext): void {
  recordDenial(ctx.conversationId, actionKey(tool, args))
}

async function waitForSteeringAnswer(ctx: ToolContext, timeoutMs: number, startLen: number): Promise<string | null> {
  const inbox = ctx.steerInbox
  if (!inbox) return null
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (ctx.signal?.aborted) return null
    if (inbox.length > startLen) {
      const [answer] = inbox.splice(startLen, 1)
      return typeof answer === 'string' ? answer : null
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return null
}
