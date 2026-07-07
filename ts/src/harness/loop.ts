import type { AgentEvent } from '../types/events'
import type { Message, ContentBlock, ToolResultBlock, ToolCall } from '../types/message'
import { textBlock, toolUseBlock, toolResultBlock, userText } from '../types/message'
import type { Model, ModelUsage } from '../types/model'
import type { ToolContext, ToolProgressEvent } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { PermissionMode } from '../permissions/types'
import { APPROVAL_PENDING_MSG, DENIAL_FALLBACK_MSG, resolvePermission } from '../permissions/resolve'
import { actionKey, clearApproval, clearDenial, recordApproval, recordDenial, shouldAutoApprove, shouldStopAsking } from '../permissions/denialTracking'
import { signApproval, verifyApproval } from '../permissions/approval'
import { collectReminders, drainSteering, extendTurns, steerBlock, wrapReminder } from './reminders'
import { formatTodoChecklist, parseProgressMarkdown } from '../types/todo'
import { compactPipeline, looksLikeContextOverflow } from '../context/compaction'
import { buildRecentFileContextMessage } from '../context/recentFileContext'
import {
  applyToolResultBudget,
  maybeStoreToolResult,
  reconstructContentReplacementState,
  type ContentReplacementRecord,
} from '../context/toolResultStorage'
import { callKey, detectStuck, sameCallGuardMessage, sameCallLimitForTool } from './stuckDetector'
import { revealToolNamesForSearch, TOOL_SEARCH_NAME, visibleToolSpecs } from '../tools/toolSearchTool'
import {
  isAskUserQuestionToolName,
  isEnterPlanApprovalAnswer,
  isEnterPlanToolName,
  isExitPlanToolName,
  isPlanApprovalAnswer,
  normalizeAskUserQuestion,
  normalizeEnterPlanQuestion,
  normalizeExitPlanQuestion,
  questionEvent,
} from '../tools/agentInteractionTools'
import { isVerifyPlanExecutionToolName } from '../tools/verifyPlanExecutionTool'
import { activateWorktreeSessionForContext } from '../tools/worktreeTools'
import {
  applyPostToolUseHooks,
  applyPreToolUseHooks,
  applySessionStartHooks,
  applyStopHooks,
  applyUserPromptSubmitHooks,
  type HookRegistry,
} from '../hooks/hooks'
import type { TeamInboxContextOptions, TeamService } from '../tasks/teamService'
import { clearThreadGoalHook, formatGoalContinuationStatusOutput, getThreadGoal, goalCompletionStatusOutput, goalLocalStatusMessage, hookRegistryHasGoalHook } from '../goals/goalState'

export interface TranscriptLike {
  load(): Promise<Message[]>
  captureBaselineLen(): Promise<number>
  savePreservingExternalTail(messages: Message[], baselineLen: number): Promise<void>
  loadContentReplacementRecords?(): Promise<ContentReplacementRecord[]>
  appendContentReplacementRecords?(records: ContentReplacementRecord[]): Promise<void>
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
  contextWindowTokens?: number
  toolResultStoreDir?: string
  transcript?: TranscriptLike
  hooks?: HookRegistry
  subagent?: { agentId: string; agentType: string }
  teamInbox?: TeamInboxContextOptions & { service: TeamService }
}

const TODO_UPDATE_TOOL_NAMES = new Set(['todo_write', 'task_create', 'task_update', 'TaskCreate', 'TaskUpdate'])
const AGGREGATE_TOOL_RESULT_BUDGET_SKIP_TOOLS = new Set(['read_file', 'read_many_files'])

/**
 * 真 ReAct 主循环,内核 = Anthropic content-block:
 * think → 有 tool_use 就过权限闸执行(无 hook/无审批的只读工具可并行) → 一批 tool_result 装单条 user 消息回灌 → 再 think,直到收敛或 max_turns。
 * 退出信号看"有没有 tool_use 块"(kind==='tool_calls'),不信 finish_reason(05 清单⑥)。
 * 工具错误一律 <tool_use_error>+is_error 回灌不崩循环。system 走 ModelStepInput 独立字段。
 */
export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { model, registry } = opts
  const maxTurns = opts.maxTurns ?? 12
  let transcriptBaseline = 0
  let history: Message[] = opts.initialMessages ?? []
  let contentReplacementRecords: ContentReplacementRecord[] = []
  if (opts.transcript) {
    try {
      transcriptBaseline = await opts.transcript.captureBaselineLen()
      const loaded = await opts.transcript.load()
      history = loaded.length > 0 ? loaded : opts.initialMessages ?? []
      contentReplacementRecords = await opts.transcript.loadContentReplacementRecords?.() ?? []
    } catch {
      history = opts.initialMessages ?? []
      contentReplacementRecords = []
    }
  }
  const contentReplacementState = reconstructContentReplacementState(history, contentReplacementRecords)
  const ctx: ToolContext = {
    workspace: opts.workspace,
    model,
    registry,
    signal: opts.signal,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode ?? 'ask',
    conversationId: opts.conversationId,
    autoSpendCount: 0,
    steerInbox: opts.steerInbox ?? [],
    todos: [],
    requestsSinceProgress: 0,
    toolResultStoreDir: opts.toolResultStoreDir,
  }
  const restoredWorktree = activateWorktreeSessionForContext(ctx)
  let system = opts.systemPrompt
  if (restoredWorktree) {
    system = `${system}\n\n<system-reminder>\nActive EnterWorktree session restored. Current tool workspace is ${restoredWorktree.worktreePath}; original workspace is ${restoredWorktree.originalRoot}. Use ExitWorktree when the user asks to leave it.\n</system-reminder>`
  }
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
  let messages: Message[] = []
  const saveTranscript = async () => {
    if (!opts.transcript) return
    try {
      await opts.transcript.savePreservingExternalTail(messages, transcriptBaseline)
    } catch {
      // transcript 是跨轮记忆底座,但写失败不能拖垮当前任务。
    }
  }

  let stopHookActive = false
  const applyStopHookContinuation = async (finalText: string): Promise<{ shouldContinue: boolean; events: AgentEvent[] }> => {
    const events: AgentEvent[] = []
    const stopHook = await applyStopHooks(opts.hooks, finalText, ctx, opts.subagent, { stopHookActive })
    const hasActiveGoalHook = hookRegistryHasGoalHook(opts.hooks, ctx.conversationId) && !!(ctx.conversationId && getThreadGoal(ctx.conversationId))
    for (const extra of stopHook.additionalContext) events.push({ type: 'context_note', text: extra })
    if (!stopHook.blockingFeedback?.length) {
      if (ctx.conversationId && hasActiveGoalHook) {
        messages.push(goalLocalStatusMessage(goalCompletionStatusOutput()))
        clearThreadGoalHook(ctx.conversationId)
        await saveTranscript()
      }
      stopHookActive = false
      return { shouldContinue: false, events }
    }
    for (const feedback of stopHook.blockingFeedback) {
      events.push({ type: 'context_note', text: feedback })
      if (hasActiveGoalHook) {
        messages.push(goalLocalStatusMessage(formatGoalContinuationStatusOutput(feedback)))
      }
    }
    messages.push({ role: 'user', content: stopHook.blockingFeedback.map(text => textBlock(wrapReminder(text))) })
    await saveTranscript()
    stopHookActive = true
    return { shouldContinue: true, events }
  }
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
    const continuation = await applyStopHookContinuation(text)
    for (const event of continuation.events) yield event
    if (!continuation.shouldContinue) {
      yield { type: 'final', text }
      return
    }
  } else {
    const userContent: ContentBlock[] = []
    if (userPrompt.additionalContext.length > 0) {
      userContent.push(textBlock(hookContextBlock('UserPromptSubmit', userPrompt.additionalContext)))
    }
    if (opts.teamInbox) {
      const inboxContext = await opts.teamInbox.service.buildInboxContext(opts.teamInbox)
      if (inboxContext) userContent.push(textBlock(inboxContext))
    }
    userContent.push(textBlock(userPrompt.userPrompt))
    messages = [...history, { role: 'user', content: userContent }]
  }
  const readOnlyToolNames = new Set(registry.list().filter(t => t.isReadOnly).map(t => t.name))
  let compactionFailures = 0
  let lastCompactionAtMs = 0
  let lastCompactedMessageCount = 0
  let sameKey = ''
  let sameKeyCount = 0
  let toolCallsNoProgress = 0
  let stuckNotified = false
  const revealedToolNames = new Set<string>()
  const usageTotals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }

  const applyAggregateToolResultBudget = async () => {
    messages = await applyToolResultBudget(messages, contentReplacementState, {
      dir: opts.toolResultStoreDir,
      conversationId: opts.conversationId,
      skipToolNames: AGGREGATE_TOOL_RESULT_BUDGET_SKIP_TOOLS,
      writeRecords: async records => {
        try {
          await opts.transcript?.appendContentReplacementRecords?.(records)
        } catch {
          // replacement sidecar 是 resume/cache 稳定性增强,写失败不能中断当前 agent。
        }
      },
    })
  }

  const maybeCompact = async (force = false): Promise<string | undefined> => {
    const out = await compactPipeline({
      messages,
      model,
      system,
      contextWindowChars: opts.contextWindowChars,
      readOnlyToolNames,
      compactionFailures,
      lastCompactionAtMs,
      lastCompactedMessageCount,
      force,
    })
    messages = out.messages
    compactionFailures = out.compactionFailures
    if (!out.didCompact) return undefined
    const recentFiles = await buildRecentFileContextMessage(ctx)
    if (recentFiles && messages.length > 0) {
      messages = [messages[0]!, recentFiles, ...messages.slice(1)]
    }
    lastCompactionAtMs = Date.now()
    lastCompactedMessageCount = messages.length
    return recentFiles ? `${out.note}\n已恢复最近文件上下文。` : out.note
  }

  let turnsLimit = maxTurns
  let turn = 0
  await applyAggregateToolResultBudget()
  while (turn < turnsLimit) {
    const compactNote = await maybeCompact(false)
    if (compactNote) yield { type: 'context_note', text: compactNote }

    let step: Awaited<ReturnType<Model['step']>>
    try {
      step = await model.step({ system, messages, tools: visibleToolSpecs(registry, revealedToolNames), signal: opts.signal })
    } catch (err) {
      if (!looksLikeContextOverflow(err)) throw err
      const note = await maybeCompact(true)
      if (!note) throw err
      yield { type: 'context_note', text: note }
      step = await model.step({ system, messages, tools: visibleToolSpecs(registry, revealedToolNames), signal: opts.signal })
    }
    const usageEvent = usageUpdateEvent(step.usage, usageTotals, opts.contextWindowTokens)
    if (usageEvent) yield usageEvent
    for (const notice of step.notices ?? []) {
      if (notice.trim()) yield { type: 'context_note', text: notice.trim() }
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
      const pendingVerification = ctx.pendingPlanVerification
      if (pendingVerification && !pendingVerification.verificationCompleted && (pendingVerification.toolCallsSinceApproval ?? 0) > 0) {
        const reminder = '计划已经开始执行,但还没有通过 VerifyPlanExecution 做收工验证。请先调用 VerifyPlanExecution,带上可复核证据,再给最终总结。'
        messages.push({ role: 'user', content: [textBlock(wrapReminder(reminder))] })
        yield { type: 'context_note', text: reminder }
        turn++
        continue
      }
      const continuation = await applyStopHookContinuation(step.text)
      for (const event of continuation.events) yield event
      if (continuation.shouldContinue) {
        turnsLimit = Math.max(turnsLimit, turn + 2)
        turn++
        continue
      }
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

    // 逐个过闸,tool_result 块累积;只读安全批次并行跑,稍后装单条 user 消息(tool_result 紧贴 tool_use)
    const toolResults: ToolResultBlock[] = []
    const parallelReadOnly: PreparedToolCall[] = []
    const flushParallelReadOnly = async (): Promise<AgentEvent[]> => {
      if (!parallelReadOnly.length) return []
      const batch = parallelReadOnly.splice(0)
      const outcomes = await Promise.all(batch.map(item => executeAllowedToolCall(item.tool, item.call, item.input, ctx, opts.hooks, opts.toolResultStoreDir)))
      const events: AgentEvent[] = []
      for (const outcome of outcomes) {
        toolResults.push(outcome.result)
        events.push(...outcome.events)
      }
      return events
    }
    for (const call of step.calls) {
      const progress = popTaskProgress(call.input)
      if (progress !== null) {
        ctx.todos = parseProgressMarkdown(progress)
        ctx.requestsSinceProgress = 0
        toolCallsNoProgress = 0
        stuckNotified = false
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos) }
      }
      const k = callKey(call.name, call.input)
      sameKeyCount = k === sameKey ? sameKeyCount + 1 : 1
      sameKey = k

      const sameCallLimit = sameCallLimitForTool(call.name)
      const parallelCandidate = sameKeyCount < sameCallLimit ? prepareParallelReadOnlyCall(registry, call, ctx, opts.hooks) : null
      if (parallelCandidate) {
        yield { type: 'tool_call', tool: call.name, input: call.input }
        parallelReadOnly.push(parallelCandidate)
        ctx.requestsSinceProgress = (ctx.requestsSinceProgress ?? 0) + 1
        toolCallsNoProgress++
        continue
      }

      for (const event of await flushParallelReadOnly()) yield event
      yield { type: 'tool_call', tool: call.name, input: call.input }
      if (sameKeyCount >= sameCallLimit) {
        const output = sameCallGuardMessage(call.name, sameCallLimit)
        toolResults.push(toolResultBlock(call.id, output, false))
        yield { type: 'tool_result', tool: call.name, output }
      } else {
        yield* gateOneCall(registry, call, ctx, toolResults, opts.hooks, opts.toolResultStoreDir)
      }
      const pendingVerification = ctx.pendingPlanVerification
      if (
        pendingVerification &&
        !pendingVerification.verificationCompleted &&
        !isExitPlanToolName(call.name) &&
        !isVerifyPlanExecutionToolName(call.name)
      ) {
        pendingVerification.toolCallsSinceApproval = (pendingVerification.toolCallsSinceApproval ?? 0) + 1
      }
      if (call.name === TOOL_SEARCH_NAME) {
        for (const name of revealToolNamesForSearch(registry, call.input)) revealedToolNames.add(name)
      }
      if (TODO_UPDATE_TOOL_NAMES.has(call.name)) {
        ctx.requestsSinceProgress = 0
        toolCallsNoProgress = 0
        stuckNotified = false
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos ?? []) }
      } else {
        ctx.requestsSinceProgress = (ctx.requestsSinceProgress ?? 0) + 1
        toolCallsNoProgress++
      }
    }
    for (const event of await flushParallelReadOnly()) yield event

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
    await applyAggregateToolResultBudget()
    turn++
  }

  // max_turns 兜底:强制一次无工具收敛(照 loop.py 的 _FINAL_NUDGE 哲学)。
  const forced = await model.step({ system, messages, tools: [], signal: opts.signal })
  const usageEvent = usageUpdateEvent(forced.usage, usageTotals, opts.contextWindowTokens)
  if (usageEvent) yield usageEvent
  const text = forced.kind === 'final' ? forced.text : '(已达最大轮次,未能收敛)'
  messages.push({ role: 'assistant', content: [textBlock(text)] })
  await saveTranscript()
  const continuation = await applyStopHookContinuation(text)
  for (const event of continuation.events) yield event
  if (continuation.shouldContinue) {
    const retry = await model.step({ system, messages, tools: [], signal: opts.signal })
    const retryUsage = usageUpdateEvent(retry.usage, usageTotals, opts.contextWindowTokens)
    if (retryUsage) yield retryUsage
    const retryText = retry.kind === 'final' ? retry.text : '(Stop hook 要求继续,但模型仍未能收敛)'
    messages.push({ role: 'assistant', content: [textBlock(retryText)] })
    await saveTranscript()
    const retryContinuation = await applyStopHookContinuation(retryText)
    for (const event of retryContinuation.events) yield event
    yield { type: 'final', text: retryText }
    return
  }
  yield { type: 'final', text }
}

function hookContextBlock(event: string, contexts: string[]): string {
  return `<hook_context event="${event}">\n${contexts.join('\n\n')}\n</hook_context>`
}

interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

function usageUpdateEvent(usage: ModelUsage | undefined, totals: UsageTotals, contextWindowTokens?: number): AgentEvent | null {
  if (!usage) return null
  totals.inputTokens += usage.input_tokens
  totals.outputTokens += usage.output_tokens
  totals.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  totals.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0

  const event: Extract<AgentEvent, { type: 'usage_update' }> = {
    type: 'usage_update',
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    total_tokens: totals.inputTokens + totals.outputTokens,
    last_input_tokens: usage.input_tokens,
    last_output_tokens: usage.output_tokens,
  }
  if (totals.cacheReadInputTokens > 0) event.cache_read_input_tokens = totals.cacheReadInputTokens
  if (totals.cacheCreationInputTokens > 0) event.cache_creation_input_tokens = totals.cacheCreationInputTokens
  if (contextWindowTokens && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    event.context_window = contextWindowTokens
    event.context_percent = Math.round((usage.input_tokens / contextWindowTokens) * 1000) / 10
  }
  return event
}

function isApprovalRememberable(decision: Extract<ReturnType<typeof resolvePermission>, { behavior: 'ask' }>): boolean {
  if (decision.reason?.type === 'forceConfirm' || decision.reason?.type === 'requiresUserInteraction') return false
  return decision.approvalClass !== 'spend' && decision.approvalClass !== 'destructive'
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

interface PreparedToolCall {
  call: ToolCall
  tool: NonNullable<ReturnType<ToolRegistry['get']>>
  input: unknown
}

interface ToolExecutionOutcome {
  result: ToolResultBlock
  events: AgentEvent[]
}

function prepareParallelReadOnlyCall(registry: ToolRegistry, call: ToolCall, ctx: ToolContext, hooks?: HookRegistry): PreparedToolCall | null {
  if (hooks) return null
  if (call.name === TOOL_SEARCH_NAME) return null
  if (isAskUserQuestionToolName(call.name) || isEnterPlanToolName(call.name) || isExitPlanToolName(call.name) || isVerifyPlanExecutionToolName(call.name)) return null
  const tool = registry.get(call.name)
  if (!tool) return null
  const readOnly = tool.isReadOnly || (tool.isReadOnlyFor?.(call.input, ctx) ?? false)
  if (!readOnly) return null
  if (
    tool.requiresApproval ||
    tool.requiresApprovalFor ||
    tool.forceConfirm ||
    tool.requiresUserInteraction ||
    tool.requiresUserInteractionFor ||
    tool.fatalReasonFor ||
    tool.safePrefixFor ||
    tool.approvalClass ||
    tool.approvalClassFor ||
    tool.previewFor ||
    tool.approvalReasonFor
  ) {
    return null
  }
  const decision = resolvePermission(tool, call.input, ctx)
  if (decision.behavior !== 'allow') return null
  return { call, tool, input: decision.updatedInput ?? call.input }
}

function toolFeedback(call: ToolCall, output: string, isError = false, modelContent = output): ToolExecutionOutcome {
  const content = isError ? `<tool_use_error>\n${modelContent}\n</tool_use_error>` : modelContent
  return {
    result: toolResultBlock(call.id, content, isError),
    events: [{ type: 'tool_result', tool: call.name, output }],
  }
}

async function executeAllowedToolCall(
  tool: NonNullable<ReturnType<ToolRegistry['get']>>,
  call: ToolCall,
  input: unknown,
  ctx: ToolContext,
  hooks?: HookRegistry,
  toolResultStoreDir?: string,
): Promise<ToolExecutionOutcome> {
  try {
    const output = await tool.execute(input, ctx)
    const stored = await maybeStoreToolResult(call.name, call.id, output, {
      dir: toolResultStoreDir,
      conversationId: ctx.conversationId,
    })
    const postHook = await applyPostToolUseHooks(hooks, call.name, input, output, ctx)
    const events: AgentEvent[] = postHook.additionalContext.map((text): AgentEvent => ({ type: 'context_note', text }))
    const modelContent = postHook.additionalContext.length > 0
      ? `${stored.content}\n\n${hookContextBlock('PostToolUse', postHook.additionalContext)}`
      : stored.content
    const feedback = toolFeedback(call, stored.content, false, modelContent)
    events.push(...feedback.events)
    return { result: feedback.result, events }
  } catch (err) {
    return toolFeedback(call, `错误:工具 ${tool.name} 执行失败:${err instanceof Error ? err.message : String(err)}`, true)
  }
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
  toolResultStoreDir?: string,
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

  if (isEnterPlanToolName(call.name)) {
    try {
      const { question } = normalizeEnterPlanQuestion(call.input, call.id)
      const answerStartLen = ctx.steerInbox?.length ?? 0
      yield questionEvent(question)
      const answer = await waitForSteeringAnswer(ctx, question.timeoutMs, answerStartLen)
      if (answer && isEnterPlanApprovalAnswer(answer)) {
        ctx.permissionMode = 'plan'
        yield feedback([
          '<plan_mode_entered />',
          'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
          'In plan mode, you should:',
          '1. Thoroughly explore the codebase to understand existing patterns.',
          '2. Identify similar features and architectural approaches.',
          '3. Consider multiple approaches and their trade-offs.',
          '4. Use ask_user_question if you need to clarify the approach.',
          '5. Design a concrete implementation strategy.',
          '6. When ready, use ExitPlanMode to present your plan for approval.',
          'Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.',
        ].join('\n'), false)
      } else if (answer) {
        yield feedback(`<plan_mode_rejected>\n${answer}\n</plan_mode_rejected>`, false)
      } else {
        yield feedback('<plan_mode_enter status="timeout" />', false)
      }
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
        ctx.pendingPlanVerification = {
          plan,
          verificationStarted: false,
          verificationCompleted: false,
          toolCallsSinceApproval: 0,
        }
        yield feedback(`<plan_approved>\n${plan}\n</plan_approved>\n用户已批准计划,当前回合已退出计划模式并切到 ask 权限档。完成实施后必须直接调用 VerifyPlanExecution 并附可复核证据。`, false)
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
    const rememberable = isApprovalRememberable(decision)
    if (rememberable && shouldAutoApprove(ctx.conversationId, key)) {
      const input = hookInput
      const outcome = yield* executeAllowedToolCallWithProgress(tool, call, input, ctx, hooks, toolResultStoreDir)
      toolResults.push(outcome.result)
      for (const event of outcome.events) yield event
      return
    }
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
      rememberable,
    }
    yield feedback(APPROVAL_PENDING_MSG(call.name), false)
    return
  }

  // allow:full 档下自动放行的 spend 类累加计数(过 AUTO_SPEND_LIMIT 后 resolvePermission 会改判 ask)。
  if (tool.approvalClass === 'spend' && ctx.permissionMode === 'full') {
    ctx.autoSpendCount = (ctx.autoSpendCount ?? 0) + 1
  }
  const input = decision.updatedInput ?? hookInput
  const outcome = yield* executeAllowedToolCallWithProgress(tool, call, input, ctx, hooks, toolResultStoreDir)
  toolResults.push(outcome.result)
  for (const event of outcome.events) {
    yield event
  }
}

async function* executeAllowedToolCallWithProgress(
  tool: NonNullable<ReturnType<ToolRegistry['get']>>,
  call: ToolCall,
  input: unknown,
  ctx: ToolContext,
  hooks?: HookRegistry,
  toolResultStoreDir?: string,
): AsyncGenerator<AgentEvent, ToolExecutionOutcome> {
  const previousEmit = ctx.progressEmit
  const progressEvents: AgentEvent[] = []
  let finished = false
  let wake: (() => void) | undefined
  const notify = () => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }
  const progressEmit = (event: ToolProgressEvent) => {
    const normalized = normalizeToolProgressEvent(call, event)
    if (!normalized.chunk) return
    progressEvents.push(normalized)
    notify()
  }
  const waitForProgress = () => new Promise<void>(resolve => {
    if (finished || progressEvents.length) {
      resolve()
      return
    }
    wake = resolve
  })

  ctx.progressEmit = progressEmit
  const execution = executeAllowedToolCall(tool, call, input, ctx, hooks, toolResultStoreDir)
    .finally(() => {
      finished = true
      if (ctx.progressEmit === progressEmit) ctx.progressEmit = previousEmit
      notify()
    })

  while (!finished || progressEvents.length) {
    while (progressEvents.length) yield progressEvents.shift()!
    if (!finished) await waitForProgress()
  }
  return await execution
}

function normalizeToolProgressEvent(call: ToolCall, event: ToolProgressEvent): Extract<AgentEvent, { type: 'tool_progress' }> {
  return {
    type: 'tool_progress',
    tool: typeof event.tool === 'string' && event.tool ? event.tool : call.name,
    id: typeof event.id === 'string' && event.id ? event.id : call.id,
    chunk: typeof event.chunk === 'string' ? event.chunk : String(event.chunk ?? ''),
    stream: typeof event.stream === 'string' ? event.stream : undefined,
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
  remember = false,
  tokenArgs: unknown = args,
): Promise<{ ok: boolean; output: string }> {
  if (!verifyApproval(tool, tokenArgs, token)) return { ok: false, output: '审批校验失败:token 与动作不匹配,拒绝执行。' }
  const t = registry.get(tool)
  if (!t) return { ok: false, output: `未知工具 ${tool}` }
  const decision = resolvePermission(t, args, ctx)
  if (decision.behavior === 'deny') return { ok: false, output: decision.message }
  const executionArgs = decision.behavior === 'allow' ? decision.updatedInput ?? args : args
  clearDenial(ctx.conversationId, actionKey(tool, tokenArgs))
  clearDenial(ctx.conversationId, actionKey(tool, executionArgs))
  const previousApprovedToolExecution = ctx.approvedToolExecution
  try {
    ctx.approvedToolExecution = { name: tool, key: actionKey(tool, tokenArgs) }
    const output = await t.execute(executionArgs, ctx)
    const stored = await maybeStoreToolResult(tool, 'approved', output, {
      dir: ctx.toolResultStoreDir,
      conversationId: ctx.conversationId,
    })
    if (remember) {
      if (decision.behavior === 'ask' && isApprovalRememberable(decision)) {
        recordApproval(ctx.conversationId, actionKey(tool, executionArgs))
      }
    }
    return { ok: true, output: stored.content }
  } catch (err) {
    return { ok: false, output: `工具 ${tool} 执行失败:${err instanceof Error ? err.message : String(err)}` }
  } finally {
    ctx.approvedToolExecution = previousApprovedToolExecution
  }
}

/** 老板拒绝某审批(给独立 /agent/reject 用):记一次拒绝,喂给下次的 shouldStopAsking。 */
export function handleReject(tool: string, args: unknown, ctx: ToolContext): void {
  const key = actionKey(tool, args)
  clearApproval(ctx.conversationId, key)
  recordDenial(ctx.conversationId, key)
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
