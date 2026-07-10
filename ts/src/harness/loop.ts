import { randomUUID } from 'node:crypto'
import type { AgentEvent, UsageUpdateEvent } from '../types/events'
import type { Message, ContentBlock, ImageBlock, ToolResultBlock, ToolCall } from '../types/message'
import { textBlock, toolUseBlock, toolResultBlock, userText } from '../types/message'
import type { AssistantStep, Model, ModelStepDelta, ModelStepInput, ModelUsage } from '../types/model'
import { MODEL_OUTPUT_TRUNCATED_NOTICE } from '../types/model'
import type { ToolContext, ToolProgressEvent, ToolSpec } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { PermissionMode } from '../permissions/types'
import { APPROVAL_PENDING_MSG, DENIAL_FALLBACK_MSG, resolvePermission } from '../permissions/resolve'
import type { PermissionUpdate } from '../permissions/types'
import { applyPermissionUpdates } from '../permissions/permissionUpdate'
import { rememberedPermissionUpdatesForApproval, transientPermissionUpdatesForApproval } from '../permissions/approvalSuggestions'
import {
  actionKey,
  clearApproval,
  clearDenial,
  clearLocalApproval,
  clearLocalDenial,
  recordApproval,
  recordDenial,
  recordLocalApproval,
  recordLocalDenial,
  shouldAutoApprove,
  shouldLocalAutoApprove,
  shouldLocalStopAsking,
  shouldStopAsking,
  type DenialTrackingState,
} from '../permissions/denialTracking'
import { signApproval, verifyApproval } from '../permissions/approval'
import { collectReminders, drainSteering, steerBlock, wrapReminder } from './reminders'
import { computeRelevantMemoryInjection, SELECT_MEMORIES_SYSTEM_PROMPT, type MemorySelector } from '../memory/relevantMemories'
import { getAutoMemDir } from './memoryNames'
import { formatTodoChecklist, parseProgressMarkdown } from '../types/todo'
import { compactPipeline, compactionWillRun, looksLikeContextOverflow } from '../context/compaction'
import { buildRecentFileContextMessage } from '../context/recentFileContext'
import { createInvokedSkillsMessage, restoreInvokedSkillsFromMessages } from '../skills/invokedSkills'
import {
  applyToolResultBudget,
  cloneContentReplacementState,
  maybeStoreToolResult,
  reconstructContentReplacementState,
  type ContentReplacementState,
  type ContentReplacementRecord,
} from '../context/toolResultStorage'
import {
  checkPromptCacheBreak,
  formatPromptCacheBreak,
  notifyPromptCacheCompaction,
  recordPromptCacheState,
} from '../context/promptCacheBreakDetection'
import { detectStuck } from './stuckDetector'
import { revealToolNamesForSearch, TOOL_SEARCH_NAME, visibleToolSpecs } from '../tools/toolSearchTool'
import { addAllowedToolsToContext } from '../commands/allowedTools'
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
import { getPlan, getPlanFilePath } from './plans'
import { validateToolInput } from '../tools/inputSchemaValidation'
import { sanitizeResumeMessages } from './messageSanitize'
import { getDestructiveCommandWarning } from '../tools/destructiveCommandWarning'
import { isImageExtension } from '../tools/imageRead'
import { extname } from 'node:path'

/**
 * 流式驱动一次 model.step:onDelta 回调在 await 期间到达的正文/推理增量,经 queue+race 交错 yield 成
 * content_delta 事件(前端打字机);await 结束后返回完整 AssistantStep。非流式模型(fake)不触发 onDelta,
 * 队列恒空 → 行为与 `await model.step()` 完全一致(向后兼容)。
 */
async function* streamModelStep(model: Model, input: ModelStepInput): AsyncGenerator<AgentEvent, AssistantStep> {
  const queue: AgentEvent[] = []
  let notify: (() => void) | null = null
  const wake = (): void => { const n = notify; notify = null; n?.() }
  const onDelta = (d: ModelStepDelta): void => { queue.push({ type: 'content_delta', channel: d.channel, text: d.text }); wake() }
  let settled = false
  let result: AssistantStep | undefined
  let error: unknown
  const done = model.step({ ...input, onDelta }).then(v => { result = v }, e => { error = e }).finally(() => { settled = true; wake() })
  while (true) {
    while (queue.length > 0) yield queue.shift()!
    if (settled) break
    await new Promise<void>(resolve => { notify = resolve })
  }
  await done
  if (error) throw error
  return result as AssistantStep
}

/** 命令类工具(run_command/PowerShell)审批时的破坏性警告(纯信息,不影响权限)。 */
function destructiveWarningForInput(toolName: string, input: unknown): string | null {
  if (toolName !== 'run_command' && toolName !== 'PowerShell') return null
  const command = input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
  return typeof command === 'string' && command.trim() ? getDestructiveCommandWarning(command) : null
}
import { activateWorktreeSessionForContext } from '../tools/worktreeTools'
import {
  applyNotificationHooks,
  applyPostCompactHooks,
  applyPostToolUseFailureHooks,
  applyPostToolUseHooks,
  applyPreCompactHooks,
  applyPreToolUseHooks,
  applySessionStartHooks,
  applyStopFailureHooks,
  applyStopHooks,
  applyUserPromptSubmitHooks,
  hookAllowBypassesAsk,
  mergeHookRegistries,
  type HookRegistry,
} from '../hooks/hooks'
import type { TeamInboxContextOptions, TeamService } from '../tasks/teamService'
import { clearThreadGoalHook, formatGoalContinuationStatusOutput, getThreadGoal, goalCompletionStatusOutput, goalLocalStatusMessage, hookRegistryHasGoalHook } from '../goals/goalState'

export interface TranscriptLike {
  load(): Promise<Message[]>
  /** append-only 增量写:只把较盘上活跃链新增/分叉的那段追加成新行,绝不整表覆写(对齐 cc 事件日志)。 */
  append(messages: Message[]): Promise<void>
  /**
   * 压缩边界落盘(对齐 cc autoCompact/insertMessageChain 的 compact-boundary 语义,见 memory/transcript.ts
   * Transcript.recordCompaction):压缩前完整历史先补齐到盘(仍在活跃链、可 message 级 rewind),再追加一条
   * compact-boundary + 压缩后消息(摘要 + 保留近段)。maybeCompact 的压缩成功分支必须调用它而非通用 append(),
   * 否则压缩前历史会从活跃链上永久不可达(loadFullHistory/rewind/fork 全受害——此前的断链正是漏了这一步)。
   */
  recordCompaction(
    preCompactMessages: Message[],
    postCompactMessages: Message[],
    meta: { trigger: 'auto' | 'manual'; preTokens?: number; messagesSummarized?: number },
  ): Promise<void>
  loadContentReplacementRecords?(): Promise<ContentReplacementRecord[]>
  appendContentReplacementRecords?(records: ContentReplacementRecord[]): Promise<void>
}

export interface AgentLoopSnapshot {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  contentReplacementState?: ContentReplacementState
}

export interface RunAgentLoopOptions {
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  userMessage: string
  userContent?: ContentBlock[]
  initialMessages?: Message[]
  skipUserMessage?: boolean
  maxTurns?: number
  signal?: AbortSignal
  /** 状态根目录:透传给 ToolContext.stateRoot,让 file-history 快照落在 stateRoot 而非用户工作区(见 Tool.ts)。 */
  stateRoot?: string
  /**
   * 硬停之外的第二条中断通道(submit-interrupt):调用方(server)在"运行中提交插话"时调用它,让循环把当前在飞的
   * 可中断工具当场 abort('interrupt')切断、再拿排队消息续跑。循环自带闸:只有正跑着 interruptBehavior==='cancel'
   * 的工具时才真 abort,否则 no-op(等价 soft steer 入队)。硬停仍走 signal(reason 非 'interrupt')。
   */
  registerInterrupt?: (interrupt: () => void) => void
  sandbox?: Sandbox
  permissionMode?: PermissionMode
  initialPermissionUpdates?: PermissionUpdate[]
  initialAllowedTools?: string[]
  conversationId?: string
  localDenialTracking?: DenialTrackingState
  steerInbox?: string[]
  contextWindowChars?: number
  contextWindowTokens?: number
  toolResultStoreDir?: string
  contentReplacementState?: ContentReplacementState
  transcript?: TranscriptLike
  hooks?: HookRegistry
  initialSessionHooks?: HookRegistry
  onSessionHooksChanged?: (hooks: HookRegistry | undefined) => void
  subagent?: { agentId: string; agentType: string }
  querySource?: string
  teamInbox?: TeamInboxContextOptions & { service: TeamService }
  onSummarySnapshot?: (snapshot: AgentLoopSnapshot) => void
  modelName?: string
  initialUsage?: UsageUpdateEvent
}

const TODO_UPDATE_TOOL_NAMES = new Set(['todo_write', 'task_create', 'task_update', 'TaskCreate', 'TaskUpdate'])
const AGGREGATE_TOOL_RESULT_BUDGET_SKIP_TOOLS = new Set(['read_file', 'read_many_files'])

/**
 * 输出撞长度上限、模型层已升过一次 max_tokens 仍被截断后,主循环"从断点续写"的最多重试次数
 * (对齐 cc-haha src/query.ts:167 MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3)。耗尽即接受当前(截断)输出为最终,不无限重发。
 */
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
/**
 * 续写元提示:让模型从断点直接接着写,别道歉别复述(对齐 cc-haha src/query.ts:1232-1236 的措辞)。
 * cc 原文:"Output token limit hit. Resume directly — no apology, no recap of what you were doing.
 * Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces."
 */
export const OUTPUT_TOKEN_LIMIT_RECOVERY_PROMPT =
  '输出触达长度上限。直接从断点继续,别道歉、别复述你刚才在做什么;如果是在半句话处被截断,就接着那句往下写。把剩下的内容拆成更小的块逐段输出。'
/**
 * 纯硬停(用户点中断/急停)时循环 yield 的中断消息(对齐 cc createUserInterruptionMessage)。submit-interrupt
 * 不 yield 它(排队的插话会紧跟着提供上下文)。循环只 yield 这条 + return,最终答复由调用方兜底合成。
 */
export const TURN_INTERRUPTED_MSG = '本回合已被用户中断。'

function cloneContentReplacementStateForSnapshot(state: ContentReplacementState | undefined): ContentReplacementState | undefined {
  return state ? cloneContentReplacementState(state) : undefined
}

/** auto-memory 是否启用(与 systemPrompt/claudemd 的开关口径一致):禁用时不做记忆召回。 */
function autoMemoryEnabledForLoop(): boolean {
  const truthy = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes'
  return !truthy(process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY) && !truthy(process.env.BILLIARDBUDDY_DISABLE_MEMORY)
}

/**
 * 真 ReAct 主循环,内核 = Anthropic content-block:
 * think → 有 tool_use 就过权限闸执行(无 hook/无审批的只读工具可并行) → 一批 tool_result 装单条 user 消息回灌 → 再 think,直到收敛或 max_turns。
 * 退出信号看"有没有 tool_use 块"(kind==='tool_calls'),不信 finish_reason(05 清单⑥)。
 * 工具错误一律 <tool_use_error>+is_error 回灌不崩循环。system 走 ModelStepInput 独立字段。
 */
export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { model, registry } = opts
  // maxTurns 对齐 cc(query.ts:194/1713):undefined = 不设限(由调用方显式传);命中只 yield max_turns_reached 后
  // return、绝不再调模型,"总给最终答复"的兜底移到循环外调用方(server/B 线)。
  const maxTurns = opts.maxTurns
  // —— 中断/steering 统一到 abort 之上(对齐 cc query.ts:1023-1058/1493-1524)——
  // liveController = 本"段"实际喂给 model.step / 工具的信号源;外部硬停信号(opts.signal)桥接进来。
  // submit-interrupt 只 abort liveController('interrupt' reason)、不动 opts.signal,切断后换新 controller 续跑,
  // 从而与"纯硬停(opts.signal abort、reason 非 interrupt)"区分开、且硬停通道用后仍可用。
  const newLiveController = (): AbortController => {
    const c = new AbortController()
    if (opts.signal?.aborted) c.abort(opts.signal.reason)
    return c
  }
  let liveController = newLiveController()
  // 当前正在飞的可中断工具数(interruptBehavior==='cancel');requestInterrupt 据此自闸:>0 才真切断。
  let interruptibleInFlight = 0
  opts.signal?.addEventListener('abort', () => {
    if (!liveController.signal.aborted) liveController.abort(opts.signal!.reason)
  }, { once: true })
  const requestInterrupt = (): void => {
    if (interruptibleInFlight > 0 && !liveController.signal.aborted) liveController.abort('interrupt')
  }
  opts.registerInterrupt?.(requestInterrupt)
  let history: Message[] = opts.initialMessages ?? []
  let contentReplacementRecords: ContentReplacementRecord[] = []
  if (opts.transcript) {
    try {
      // 主会话 resume 清洗 transcript 残尾:上一轮中断/异常留下的未配对 tool_use / 孤儿 thinking / 空白
      // assistant 若直接喂回模型会破坏配对(Anthropic API 拒未配对 tool_use);无孤儿时为 no-op。
      const loaded = sanitizeResumeMessages(await opts.transcript.load())
      history = loaded.length > 0 ? loaded : opts.initialMessages ?? []
      contentReplacementRecords = await opts.transcript.loadContentReplacementRecords?.() ?? []
    } catch {
      history = opts.initialMessages ?? []
      contentReplacementRecords = []
    }
  }
  const contentReplacementState = opts.contentReplacementState ??
    reconstructContentReplacementState(history, contentReplacementRecords)
  const invokedSkillScopeId = opts.conversationId ?? null
  restoreInvokedSkillsFromMessages(history, invokedSkillScopeId)
  let ctx: ToolContext = {
    workspace: opts.workspace,
    model,
    registry,
    systemPrompt: opts.systemPrompt,
    renderedSystemPrompt: opts.systemPrompt,
    signal: liveController.signal,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode ?? 'default',
    sessionHooks: opts.initialSessionHooks,
    onSessionHooksChanged: opts.onSessionHooksChanged,
    conversationId: opts.conversationId,
    querySource: opts.querySource,
    localDenialTracking: opts.localDenialTracking,
    steerInbox: opts.steerInbox ?? [],
    todos: [],
    requestsSinceProgress: 0,
    toolResultStoreDir: opts.toolResultStoreDir,
    contentReplacementState,
    // F1 关联修复:opts.stateRoot 此前只声明、从未真正接进 ctx——file-history 快照因此在生产环境恒回退到
    // `<workspaceRoot>/.agent-file-history/`(污染用户工作区),与 SessionRewindService 读取的
    // `<stateRoot>/file-history/` 对不上,即便 ctx.messageId 接对了,checkpoint 也永远读不到真实记录。
    stateRoot: opts.stateRoot,
  }
  if (opts.initialPermissionUpdates?.length) ctx = applyPermissionUpdates(ctx, opts.initialPermissionUpdates)
  addAllowedToolsToContext(ctx, opts.initialAllowedTools)
  const restoredWorktree = activateWorktreeSessionForContext(ctx)
  const hooksForCurrentSession = (): HookRegistry | undefined => mergeHookRegistries(opts.hooks, ctx.sessionHooks)
  let system = opts.systemPrompt
  if (restoredWorktree) {
    system = `${system}\n\n<system-reminder>\nActive EnterWorktree session restored. Current tool workspace is ${restoredWorktree.worktreePath}; original workspace is ${restoredWorktree.originalRoot}. Use ExitWorktree when the user asks to leave it.\n</system-reminder>`
  }
  const sessionStart = await applySessionStartHooks(hooksForCurrentSession(), ctx)
  for (const extra of sessionStart.additionalContext) {
    yield { type: 'context_note', text: extra }
  }
  if (sessionStart.additionalContext.length > 0) {
    system = `${system}\n\n${hookContextBlock('SessionStart', sessionStart.additionalContext)}`
  }
  ctx.systemPrompt = system
  ctx.renderedSystemPrompt = system

  const userPrompt = opts.skipUserMessage
    ? { userPrompt: opts.userMessage, additionalContext: [] }
    : await applyUserPromptSubmitHooks(hooksForCurrentSession(), opts.userMessage, ctx)
  for (const extra of userPrompt.additionalContext) {
    yield { type: 'context_note', text: extra }
  }
  let messages: Message[] = []
  // 正常用户回合的原始问题文本(用于记忆召回);只在真·用户消息路径置值,
  // skipUserMessage / 被 hook 拦截 / stop-hook 续跑等路径保持 null → 不做召回。
  let userTurnQuery: string | null = null
  const saveTranscript = async () => {
    if (!opts.transcript) return
    try {
      await opts.transcript.append(messages)
    } catch {
      // transcript 是跨轮记忆底座,但写失败不能拖垮当前任务。
    }
  }

  let stopHookActive = false
  const applyStopHookContinuation = async (finalText: string): Promise<{ shouldContinue: boolean; events: AgentEvent[] }> => {
    const events: AgentEvent[] = []
    const hooks = hooksForCurrentSession()
    const stopHook = await applyStopHooks(hooks, finalText, ctx, opts.subagent, { stopHookActive })
    const hasActiveGoalHook = hookRegistryHasGoalHook(hooks, ctx.conversationId) && !!(ctx.conversationId && getThreadGoal(ctx.conversationId))
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
  // 收尾时最近一条 assistant 正文(供 StopFailure 载荷带上"回合被中断前模型说了什么",对齐参考实现的 last_assistant_message)。
  const lastAssistantText = (): string | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'assistant') continue
      const text = m.content.map(b => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n').trim()
      return text || undefined
    }
    return undefined
  }
  // StopFailure 落点(对齐参考实现:接口/模型错误让本回合收场时触发 StopFailure 代替正常 Stop,fire-and-forget)。
  // 只在"非用户中断"的真错误路径触发;用户主动中断(signal.aborted)不算失败、不触发。附加上下文非阻塞回灌。
  const fireStopFailureNotes = async (err: unknown): Promise<AgentEvent[]> => {
    if (opts.signal?.aborted) return []
    const message = err instanceof Error ? err.message : String(err)
    const res = await applyStopFailureHooks(hooksForCurrentSession(), message, ctx, { finalText: lastAssistantText(), subagent: opts.subagent })
    return res.additionalContext.map(text => ({ type: 'context_note' as const, text }))
  }
  if (userPrompt.deniedMessage) {
    const text = `请求被 hook 拦截:${userPrompt.deniedMessage}`
    messages = [...history, { role: 'assistant', content: [textBlock(text)] }]
    if (opts.transcript) {
      try {
        await opts.transcript.append(messages)
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
  } else if (opts.skipUserMessage) {
    messages = history.slice()
  } else {
    const userContent: ContentBlock[] = []
    if (userPrompt.additionalContext.length > 0) {
      userContent.push(textBlock(hookContextBlock('UserPromptSubmit', userPrompt.additionalContext)))
    }
    if (opts.teamInbox) {
      const inboxContext = await opts.teamInbox.service.buildInboxContext(opts.teamInbox)
      if (inboxContext) userContent.push(textBlock(inboxContext))
    }
    userContent.push(...(opts.userContent ?? [textBlock(userPrompt.userPrompt)]))
    messages = [...history, { role: 'user', content: userContent }]
    userTurnQuery = userPrompt.userPrompt
  }
  const readOnlyToolNames = new Set(registry.list().filter(t => t.isReadOnly).map(t => t.name))
  let compactionFailures = 0
  let lastCompactionAtMs = 0
  let lastCompactedMessageCount = 0
  let lastInputTokens: number | undefined // 上一轮响应回报的真实 prompt input tokens(含 cache),供 token 级压缩触发
  let toolCallsNoProgress = 0
  let stuckNotified = false
  let maxOutputTokensRecoveryCount = 0 // 连续"输出被长度上限截断"的续写计数;有实质进展(tool_calls/自然收敛)即复位
  // 计划验证提醒的"每段最多一次"闸:maxTurns=undefined(server 主路)时,final 分支不再靠 turn++/maxTurns 兜底,
  // 若模型收到提醒仍固执地不调 VerifyPlanExecution 直接 final,得避免无限重发同一条提醒。有真进展(跑了工具)即复位。
  let verifyPlanReminded = false
  const revealedToolNames = new Set<string>()
  const usageTotals = usageTotalsFromInitial(opts.initialUsage)
  const promptCacheTrackingKey = opts.conversationId
  const modelNameForPromptCache = opts.modelName ?? opts.model.constructor?.name ?? ''

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
    const invokedSkills = createInvokedSkillsMessage(invokedSkillScopeId)
    // 压缩前完整(未裁剪)messages 的引用:compactPipeline 成功时会把 `messages` 变量重指到压缩后的短数组,
    // 这里留一份指向原数组对象的引用,供下面成功路径调 transcript.recordCompaction() 时把压缩前全量历史一并落盘
    // (microcompactReadOnlyToolResults 原地折叠只读工具结果不改变数组本身,引用依旧有效)。
    const preCompactMessages = messages
    const input = {
      messages,
      model,
      system,
      postSummaryMessages: invokedSkills ? [invokedSkills] : [],
      contextWindowChars: opts.contextWindowChars,
      contextWindowTokens: opts.contextWindowTokens,
      lastInputTokens,
      readOnlyToolNames,
      compactionFailures,
      lastCompactionAtMs,
      lastCompactedMessageCount,
      force,
    }
    // PreCompact 钩:只在本轮真会压缩时触发(对齐 cc executePreCompactHooks 在真压缩前 fire);
    // compactionWillRun 与 compactPipeline 用同一决策,随后的 microcompact 是幂等 no-op。
    const trigger: 'auto' | 'manual' = force ? 'manual' : 'auto'
    const notes: string[] = []
    if (compactionWillRun(input)) {
      const pre = await applyPreCompactHooks(hooksForCurrentSession(), trigger, ctx)
      notes.push(...pre.additionalContext)
    }
    const out = await compactPipeline(input)
    if (out.didCompact && opts.transcript) {
      try {
        // 压缩边界落盘(F2 修复):必须走 recordCompaction 而非通用 append()——否则压缩前历史从没真正落盘/
        // 从活跃链分叉出去,后续 loadFullHistory()/rewind/fork 都够不到它(见 TranscriptLike.recordCompaction 注释)。
        await opts.transcript.recordCompaction(preCompactMessages, out.messages, {
          trigger,
          preTokens: lastInputTokens,
          messagesSummarized: preCompactMessages.length - out.messages.length,
        })
      } catch {
        // 压缩边界落盘失败不能拖垮当前任务;messages 仍切到压缩后视图继续跑,下次自然 append() 兜底
        // (退化为旧行为——压缩前历史这一次暂不可达,但不阻塞当前回合,后续压缩成功时会补上)。
      }
    }
    messages = out.messages
    compactionFailures = out.compactionFailures
    if (!out.didCompact) return notes.length > 0 ? notes.join('\n') : undefined
    notifyPromptCacheCompaction(promptCacheTrackingKey)
    // PostCompact 钩:压缩完成后触发,载荷带摘要文本(从压缩后首条摘要消息还原,去掉展示前缀)。
    const summaryMsg = messages[0]
    const compactSummary = summaryMsg && summaryMsg.content[0]?.type === 'text'
      ? summaryMsg.content[0].text.replace(/^\[此前对话摘要\]\n?/, '')
      : (out.note ?? '')
    const post = await applyPostCompactHooks(hooksForCurrentSession(), trigger, compactSummary, ctx)
    notes.push(...post.additionalContext)
    const recentFiles = await buildRecentFileContextMessage(ctx)
    if (recentFiles && messages.length > 0) {
      messages = [messages[0]!, recentFiles, ...messages.slice(1)]
    }
    lastCompactionAtMs = Date.now()
    lastCompactedMessageCount = messages.length
    const base = recentFiles ? `${out.note}\n已恢复最近文件上下文。` : out.note
    return [base, ...notes].filter(Boolean).join('\n')
  }

  // —— 记忆召回(findRelevantMemories,对齐 cc utils/attachments.ts:2192 + query.ts prefetch)——
  // 主 agent 正常用户回合开始时:拿这句话去 memdir 扫记忆头 → 便宜档小模型(复用主模型档)选 top-5 →
  // 把选中主题文件正文当作一条 <system-reminder> 追加进本回合用户消息,让「写进去的记忆能被读回并用上」。
  // 去重(历史里已注入过的路径,压缩后自愈)+ 会话字节上限;memdir 空 / 无命中 / 出错都静默跳过、不阻塞回合。
  if (userTurnQuery && !opts.subagent && autoMemoryEnabledForLoop()) {
    try {
      const memorySelect: MemorySelector = async ({ query, manifest, signal }) => {
        const out = await model.step({
          system: SELECT_MEMORIES_SYSTEM_PROMPT,
          messages: [userText(`用户的问题:${query}\n\n可选记忆:\n${manifest}`)],
          tools: [],
          signal,
        })
        return out.kind === 'final' ? out.text : (out.text ?? '')
      }
      const injection = await computeRelevantMemoryInjection({
        query: userTurnQuery,
        memoryDir: getAutoMemDir(opts.workspace.root),
        select: memorySelect,
        messages,
        signal: liveController.signal,
      })
      const last = messages[messages.length - 1]
      if (injection && last && last.role === 'user') {
        last.content = [...last.content, textBlock(wrapReminder(injection.reminder))]
        yield { type: 'context_note', text: `已根据你的问题从记忆库召回 ${injection.surfaced.length} 条相关记忆。` }
      }
    } catch {
      // 召回是增强、不是主路:小模型报错 / 读盘失败等任何异常都静默跳过,不影响本回合。
    }
  }

  // turn = 已完成的"用工具的回合"数(= cc turnCount 语义);只有工具批结束那一处 turn++ 并做 maxTurns 检查。
  // 恢复/续写/steering/stop-hook 续跑都不占回合预算(对齐 cc:那些路径 turnCount 不变)。
  let turn = 0
  await applyAggregateToolResultBudget()
  while (true) {
    const compactNote = await maybeCompact(false)
    if (compactNote) yield { type: 'context_note', text: compactNote }

    let step: Awaited<ReturnType<Model['step']>>
    try {
      const toolsForStep = visibleToolSpecs(registry, revealedToolNames)
      opts.onSummarySnapshot?.({ system, messages: messages.slice(), tools: toolsForStep, contentReplacementState: cloneContentReplacementStateForSnapshot(contentReplacementState) })
      recordPromptCacheState({ trackingKey: promptCacheTrackingKey, system, tools: toolsForStep, model: modelNameForPromptCache })
      // 流式:边流边把正文/推理增量 yield 成 content_delta(前端打字机);await 结束拿完整 step。
      step = yield* streamModelStep(model, { system, messages, tools: toolsForStep, signal: liveController.signal })
    } catch (err) {
      // 中断/硬停发生在 model.step 期间(真模型会抛 AbortError):优先按中断收场,别当模型错误/上下文溢出。
      // 硬停(reason 非 'interrupt')yield 中断消息;submit-interrupt 走不到这里(切断只在工具在飞时、且已换新
      // controller 续跑),防御性地也在此收场不抛。最终答复由调用方兜底。
      if (liveController.signal.aborted) {
        await saveTranscript()
        if (liveController.signal.reason !== 'interrupt') yield { type: 'context_note', text: TURN_INTERRUPTED_MSG }
        return
      }
      if (!looksLikeContextOverflow(err)) {
        for (const e of await fireStopFailureNotes(err)) yield e
        throw err
      }
      const note = await maybeCompact(true)
      if (!note) {
        for (const e of await fireStopFailureNotes(err)) yield e
        throw err
      }
      yield { type: 'context_note', text: note }
      const toolsForStep = visibleToolSpecs(registry, revealedToolNames)
      opts.onSummarySnapshot?.({ system, messages: messages.slice(), tools: toolsForStep, contentReplacementState: cloneContentReplacementStateForSnapshot(contentReplacementState) })
      recordPromptCacheState({ trackingKey: promptCacheTrackingKey, system, tools: toolsForStep, model: modelNameForPromptCache })
      step = await model.step({ system, messages, tools: toolsForStep, signal: liveController.signal })
    }
    // 记下这轮真实 prompt input tokens(含 cache 命中/创建),供下一轮 maybeCompact 做 token 级触发。
    if (step.usage) lastInputTokens = step.usage.input_tokens + (step.usage.cache_read_input_tokens ?? 0) + (step.usage.cache_creation_input_tokens ?? 0)
    const usageEvent = usageUpdateEvent(step.usage, usageTotals, opts.contextWindowTokens)
    if (usageEvent) yield usageEvent
    const cacheBreak = checkPromptCacheBreak(promptCacheTrackingKey, step.usage, messages)
    if (cacheBreak) yield { type: 'context_note', text: formatPromptCacheBreak(cacheBreak) }
    for (const notice of step.notices ?? []) {
      if (notice.trim()) yield { type: 'context_note', text: notice.trim() }
    }

    if (step.kind === 'final') {
      // 硬停发生在"模型已给 final"处:补齐历史后 yield 中断消息收场,不把这条 final 当最终答复。
      // submit-interrupt(reason==='interrupt')则换新 controller 后走下面的 steering 续跑,把排队插话灌进去。
      if (liveController.signal.aborted) {
        if (liveController.signal.reason === 'interrupt') {
          liveController = newLiveController()
          ctx.signal = liveController.signal
        } else {
          await saveTranscript()
          yield { type: 'context_note', text: TURN_INTERRUPTED_MSG }
          return
        }
      }
      if (step.thinking) yield { type: 'thinking', text: step.thinking }
      messages.push({ role: 'assistant', content: [textBlock(step.text)] })

      // 输出撞长度上限的恢复第二步(对齐 cc query.ts:1231-1260):模型层已升过一次 max_tokens 仍被截断
      // (step.notices 带 MODEL_OUTPUT_TRUNCATED_NOTICE),这里把已生成的正文留在历史里,再注入"从断点续写"元提示
      // 重发,最多 MAX_OUTPUT_TOKENS_RECOVERY_LIMIT 次。续写优先于自然收尾/steering:模型不是想结束、是被切断,
      // 得先接着把内容写完;不能让截断当成 final 收敛(那正是被修的长代码生成硬伤)。续写是恢复、不占回合预算。
      if ((step.notices ?? []).includes(MODEL_OUTPUT_TRUNCATED_NOTICE) && maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        maxOutputTokensRecoveryCount++
        messages.push({ role: 'user', content: [textBlock(wrapReminder(OUTPUT_TOKEN_LIMIT_RECOVERY_PROMPT))] })
        await saveTranscript()
        continue
      }
      // 到这:要么本轮没截断(自然收敛),要么续写预算已耗尽(接受当前截断输出为最终)。复位计数,给后续独立截断留满预算。
      maxOutputTokensRecoveryCount = 0

      // steering 优先于收尾:模型想结束但收件箱有插话 → 灌进去接着跑(续跑不占回合预算,对齐 cc 每次插话起新 query)。
      const drained = drainSteering(ctx)
      if (drained.length) {
        messages.push({ role: 'user', content: drained.map(steerBlock) })
        for (const m of drained) yield { type: 'steering', content: m }
        continue
      }
      await saveTranscript()
      const pendingVerification = ctx.pendingPlanVerification
      if (pendingVerification && !pendingVerification.verificationCompleted && (pendingVerification.toolCallsSinceApproval ?? 0) > 0 && !verifyPlanReminded) {
        verifyPlanReminded = true
        const reminder = '计划已经开始执行,但还没有通过 VerifyPlanExecution 做收工验证。请先调用 VerifyPlanExecution,带上可复核证据,再给最终总结。'
        messages.push({ role: 'user', content: [textBlock(wrapReminder(reminder))] })
        yield { type: 'context_note', text: reminder }
        continue
      }
      const continuation = await applyStopHookContinuation(step.text)
      for (const event of continuation.events) yield event
      if (continuation.shouldContinue) {
        continue
      }
      yield { type: 'final', text: step.text }
      return
    }

    // 走到 tool_calls 分支 = 有实质进展(哪怕这步也带了截断提示,工具调用照常配对执行、不丢);复位续写计数 +
    // 计划验证提醒闸(跑了工具算真进展,下一段 final 若仍缺验证可再提醒一次)。
    maxOutputTokensRecoveryCount = 0
    verifyPlanReminded = false

    // 展示:reasoning + 正文叙述合成一条 thinking 事件(保证每步≤1条,前端细分事件归 W16)
    const display = [step.thinking, step.text].filter(Boolean).join('\n\n')
    if (display) yield { type: 'thinking', text: display }

    // assistant 历史块:正文 text(若有)+ tool_use 块(thinking 不进历史、不回灌模型)
    const asstContent: ContentBlock[] = []
    if (step.text) asstContent.push(textBlock(step.text))
    for (const c of step.calls) asstContent.push(toolUseBlock(c))
    // F1 修复:预生成这条发起工具调用的 assistant 消息的 uuid,挂在消息对象上(MessageProvenance.uuid)。
    // Transcript.stamp() 落盘时会复用已挂的 uuid(见 memory/transcript.ts stamp()),而不是重新 randomUUID(),
    // 这样「file-history 快照绑定的 messageId」==「这条消息落盘后的真实 uuid」——message 级 checkpoint/rewind
    // 得以成立的关键连线(此前 ctx.messageId 全仓从未被赋值,fileHistory 记录的 messageId 恒 undefined)。
    const assistantMessageId = randomUUID()
    messages.push({ role: 'assistant', content: asstContent, uuid: assistantMessageId })
    // 本批工具调用发起前置好:tool.execute() 内部经 ctx 记录的 file-history 快照按它绑定(见
    // tools/fileHistory.ts recordFileSnapshot)。下一轮若还有 tool_calls,循环会在这里重新赋值,天然按轮隔离。
    ctx.messageId = assistantMessageId

    // 逐个过闸,tool_result 块累积;只读安全批次并行跑,稍后装单条 user 消息(tool_result 紧贴 tool_use)
    ctx.messages = messages.slice()
    const toolResults: ToolResultBlock[] = []
    // PDF 视觉通道:本批 read_file 读到 PDF 时把 document 块推进 ctx.documentResultSink(见 fileReadTool),
    // 稍后随尾随 user 消息一并追加。每批开始置空,避免跨轮泄漏。
    ctx.documentResultSink = []
    const parallelReadOnly: PreparedToolCall[] = []
    const flushParallelReadOnly = async (): Promise<AgentEvent[]> => {
      if (!parallelReadOnly.length) return []
      const batch = parallelReadOnly.splice(0)
      const outcomes = await mapWithConcurrency(batch, parallelReadOnlyLimit(), item =>
        executeAllowedToolCall(item.tool, item.call, item.input, ctx, hooksForCurrentSession(), opts.toolResultStoreDir))
      const events: AgentEvent[] = []
      for (const outcome of outcomes) {
        toolResults.push(outcome.result)
        events.push(...outcome.events)
      }
      return events
    }
    // 工具执行段兜底:整段 for 循环 + 收尾 flush 包一层 try/catch。任何在既有内层 try 之外抛出的异常
    // (hook 聚合器 / 工具插桩方法 isReadOnlyFor·requiresApprovalFor 等在权限/并行判定处抛错)都不会留下
    // 未配对 tool_use;catch 里为尚未产出 result 的 call 补 is_error tool_result,保配对、循环不崩(对齐 cc
    // yieldMissingToolResultBlocks:即便执行段异常也要让每个 tool_use 都有配对的 tool_result)。
    try {
    for (const call of step.calls) {
      const progress = popTaskProgress(call.input)
      if (progress !== null) {
        ctx.todos = parseProgressMarkdown(progress)
        ctx.requestsSinceProgress = 0
        toolCallsNoProgress = 0
        stuckNotified = false
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos) }
      }
      // 软护栏降级(对齐 cc「循环只执行、软劝在 system prompt / system-reminder」):同一工具重复调用不再硬拒执行、
      // 不再伪造 tool_result 回灌——模型点名的工具照常执行、回灌真实结果。原地打转的软提醒统一由下方 detectStuck 在本批
      // tool_result 回灌里追加一条 <system-reminder>(trailingSameCallStreak 命中同阈值),单一软提醒机制、不改回灌契约。
      const hooks = hooksForCurrentSession()
      const parallelCandidate = prepareParallelReadOnlyCall(registry, call, ctx, hooks)
      if (parallelCandidate) {
        yield { type: 'tool_call', tool: call.name, input: call.input }
        parallelReadOnly.push(parallelCandidate)
        ctx.requestsSinceProgress = (ctx.requestsSinceProgress ?? 0) + 1
        toolCallsNoProgress++
        continue
      }

      for (const event of await flushParallelReadOnly()) yield event
      yield { type: 'tool_call', tool: call.name, input: call.input }
      // 可中断工具在飞时计数 +1,让 requestInterrupt 自闸判定"该不该当场切断"(普通工具不计数 = 插话入队/soft steer)。
      const interruptible = registry.get(call.name)?.interruptBehavior === 'cancel'
      if (interruptible) interruptibleInFlight++
      try {
        yield* gateOneCall(registry, call, ctx, toolResults, hooksForCurrentSession(), opts.toolResultStoreDir)
      } finally {
        if (interruptible) interruptibleInFlight--
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
    } catch (toolLoopErr) {
      // 工具执行段异常兜底(对齐 cc yieldMissingToolResultBlocks):先尽力收回已排队的并行只读结果,再为 step.calls 中
      // 仍未配对的 tool_use 各补一条 is_error tool_result——保证 tool_use/tool_result 严格配对、不把未配对 tool_use
      // 泄漏到下一轮(否则下一轮 Anthropic API 400、当轮崩溃),模型据错误文本自救、循环不崩。
      try { for (const event of await flushParallelReadOnly()) yield event } catch { /* 尽力而为,仍要补齐配对 */ }
      const detail = toolLoopErr instanceof Error ? toolLoopErr.message : String(toolLoopErr)
      const paired = new Set(toolResults.map(r => r.tool_use_id))
      for (const call of step.calls) {
        if (paired.has(call.id)) continue
        const text = `工具 ${call.name} 执行中断:${detail}`
        toolResults.push(toolResultBlock(call.id, `<tool_use_error>\n${text}\n</tool_use_error>`, true))
        yield { type: 'tool_result', tool: call.name, output: text }
      }
    }

    // 单条 user 消息:一批 tool_result 块 + PDF 文档块 + steering + reminder(都作块尾随)
    const followup: ContentBlock[] = [...toolResults]
    // PDF 文档块(视觉通道)紧贴 tool_result 追加:document 块不能进 tool_result content(会破坏 model 侧
    // text|image 签名),只能作顶层块随本条 user 消息喂给模型(对齐 cc 的补充 document 消息)。drain 后清空。
    const pdfDocs = ctx.documentResultSink ?? []
    if (pdfDocs.length) {
      followup.push(...pdfDocs)
      ctx.documentResultSink = []
    }
    // steering 排队消息随本批 tool_result 一起回灌(submit-interrupt 切断在飞工具后,这里把排队插话作本回合续跑注入)。
    const drained = drainSteering(ctx)
    if (drained.length) {
      for (const m of drained) {
        followup.push(steerBlock(m))
        yield { type: 'steering', content: m }
      }
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

    // —— 中断/硬停:tool_result 已随 followup 配对进历史(在飞工具被 abort 后经短路补齐 tool_result 保配对)——
    // submit-interrupt(reason==='interrupt'):换新 controller 续跑,排队插话已在上面注入;纯硬停:yield 中断消息收场,
    // 绝不再调模型,最终答复由调用方兜底合成。
    if (liveController.signal.aborted) {
      if (liveController.signal.reason === 'interrupt') {
        liveController = newLiveController()
        ctx.signal = liveController.signal
      } else {
        yield { type: 'context_note', text: TURN_INTERRUPTED_MSG }
        return
      }
    }

    turn++
    // max_turns 命中:只 yield max_turns_reached 后 return、绝不再调模型(对齐 cc query.ts:1713-1719)。
    // 兜底"总给最终答复"移到循环外调用方(server/B 线),不在这里强制多打一次无工具 model.step。
    if (maxTurns !== undefined && turn >= maxTurns) {
      yield { type: 'max_turns_reached', turnCount: turn, maxTurns }
      return
    }
  }
}

function hookContextBlock(event: string, contexts: string[]): string {
  return `<hook_context event="${event}">\n${contexts.join('\n\n')}\n</hook_context>`
}

interface UsageTotals {
  latestInputTokens: number
  cumulativeOutputTokens: number
}

function usageTotalsFromInitial(initial: UsageUpdateEvent | undefined): UsageTotals {
  return {
    latestInputTokens: initial?.input_tokens ?? 0,
    cumulativeOutputTokens: initial?.output_tokens ?? 0,
  }
}

function usageUpdateEvent(usage: ModelUsage | undefined, totals: UsageTotals, contextWindowTokens?: number): AgentEvent | null {
  if (!usage) return null
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0
  const currentInputTokens = usage.input_tokens + cacheReadInputTokens + cacheCreationInputTokens
  totals.latestInputTokens = currentInputTokens
  totals.cumulativeOutputTokens += usage.output_tokens

  const event: UsageUpdateEvent = {
    type: 'usage_update',
    input_tokens: totals.latestInputTokens,
    output_tokens: totals.cumulativeOutputTokens,
    total_tokens: totals.latestInputTokens + totals.cumulativeOutputTokens,
    last_input_tokens: currentInputTokens,
    last_output_tokens: usage.output_tokens,
  }
  if (cacheReadInputTokens > 0) event.cache_read_input_tokens = cacheReadInputTokens
  if (cacheCreationInputTokens > 0) event.cache_creation_input_tokens = cacheCreationInputTokens
  if (contextWindowTokens && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    event.context_window = contextWindowTokens
    event.context_percent = Math.round((currentInputTokens / contextWindowTokens) * 1000) / 10
  }
  return event
}

function isApprovalRememberable(decision: Extract<ReturnType<typeof resolvePermission>, { behavior: 'ask' }>): boolean {
  if (decision.reason?.type === 'forceConfirm' || decision.reason?.type === 'requiresUserInteraction') return false
  return decision.approvalClass !== 'spend' && decision.approvalClass !== 'destructive'
}

function clearDenialForContext(ctx: ToolContext, key: string): void {
  if (ctx.localDenialTracking) clearLocalDenial(ctx.localDenialTracking, key)
  else clearDenial(ctx.conversationId, key)
}

function clearApprovalForContext(ctx: ToolContext, key: string): void {
  if (ctx.localDenialTracking) clearLocalApproval(ctx.localDenialTracking, key)
  else clearApproval(ctx.conversationId, key)
}

function recordApprovalForContext(ctx: ToolContext, key: string): void {
  if (ctx.localDenialTracking) recordLocalApproval(ctx.localDenialTracking, key)
  else recordApproval(ctx.conversationId, key)
}

function recordDenialForContext(ctx: ToolContext, key: string): void {
  if (ctx.localDenialTracking) recordLocalDenial(ctx.localDenialTracking, key)
  else recordDenial(ctx.conversationId, key)
}

function shouldAutoApproveForContext(ctx: ToolContext, key: string): boolean {
  return ctx.localDenialTracking
    ? shouldLocalAutoApprove(ctx.localDenialTracking, key)
    : shouldAutoApprove(ctx.conversationId, key)
}

function shouldStopAskingForContext(ctx: ToolContext, key: string): boolean {
  return ctx.localDenialTracking
    ? shouldLocalStopAsking(ctx.localDenialTracking, key)
    : shouldStopAsking(ctx.conversationId, key)
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

/** 该调用是否可能产出 vision 图像块(read_file 读 png/jpeg/gif/webp/bmp)。用于把读图强制排到串行路径。 */
function producesImageResult(call: ToolCall): boolean {
  if (call.name !== 'read_file') return false
  const path = call.input && typeof call.input === 'object' ? (call.input as { path?: unknown }).path : undefined
  return typeof path === 'string' && isImageExtension(extname(path))
}

// MCP 工具统一 `mcp__server__tool` 前缀(见 mcp/config.mcpToolName)。cc 对 MCP 用 z.object({}).passthrough(),
// 故入参校验对 MCP 走非严格(不拒未知键),对内建工具走 strictObject 强校验。
function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__')
}

function prepareParallelReadOnlyCall(registry: ToolRegistry, call: ToolCall, ctx: ToolContext, hooks?: HookRegistry): PreparedToolCall | null {
  if (hooks) return null
  if (call.name === TOOL_SEARCH_NAME) return null
  if (isAskUserQuestionToolName(call.name) || isEnterPlanToolName(call.name) || isExitPlanToolName(call.name) || isVerifyPlanExecutionToolName(call.name)) return null
  // 读图会往共享 ctx.imageResultSink 推 vision 块 → 必须串行执行(sink 一一对应),不进并行批以免串图。
  if (producesImageResult(call)) return null
  const tool = registry.get(call.name)
  if (!tool) return null
  // 入参非法 → 回退串行,让 gateOneCall 统一吐 InputValidationError(不在并行批里静默跑脏参数)。
  if (validateToolInput(tool.inputSchema, call.input, { strict: !isMcpToolName(call.name) }) !== null) return null
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

function toolFeedback(call: ToolCall, output: string, isError = false, modelContent = output, images?: ImageBlock[]): ToolExecutionOutcome {
  const text = isError ? `<tool_use_error>\n${modelContent}\n</tool_use_error>` : modelContent
  // 有图像块 → tool_result content 变块数组 [text, image...],让 model/proxy 序列化成真 vision 输入(对齐 cc);
  // 无图 → 保持纯 string 原路(向后兼容)。UI 事件的 output 恒为文本,前端图片展示是另一件事(#18)。
  const content: ToolResultBlock['content'] = images && images.length > 0 ? [textBlock(text), ...images] : text
  return {
    result: toolResultBlock(call.id, content, isError),
    events: [{ type: 'tool_result', tool: call.name, output }],
  }
}

/** 并行只读工具的并发上限:对齐 cc getMaxToolUseConcurrency(默认 10,env 可覆盖),避免模型一次发几十个
 * 并行只读调用时无限制铺开 fetch/子进程/文件句柄把本机打爆。 */
function parallelReadOnlyLimit(): number {
  const raw = Number(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10
}

/** 带并发上限地跑 items(保持结果顺序);数量不超上限时退化为 Promise.all。 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length <= limit) return Promise.all(items.map(fn))
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

async function executeAllowedToolCall(
  tool: NonNullable<ReturnType<ToolRegistry['get']>>,
  call: ToolCall,
  input: unknown,
  ctx: ToolContext,
  hooks?: HookRegistry,
  toolResultStoreDir?: string,
): Promise<ToolExecutionOutcome> {
  // 已中止:已下发但还没跑的工具直接短路成取消态,不再执行(对齐 cc runToolUse 的 signal 前置检查)。
  // 大多数文件类工具不自读 ctx.signal,批量下发后用户中途取消时,靠这里保证剩余工具不再动手。
  if (ctx.signal?.aborted) {
    return toolFeedback(call, `已取消:用户中止了本轮,「${tool.name}」未执行。`, false)
  }
  try {
    // 单次执行的图像块 sink:执行前置空、执行后收走,组进本 tool_result 的 content 块数组(真 vision 回灌)。
    // 串行路径 loop 设/取之间无交错 → 一一对应;并行只读批次已排除读图工具(见 prepareParallelReadOnlyCall),
    // 故并行执行不会往 sink 推、不串图。用 === 守卫恢复,防并行时误清他人 sink。
    const imageSink: ImageBlock[] = []
    const previousSink = ctx.imageResultSink
    ctx.imageResultSink = imageSink
    let output: string
    try {
      output = await tool.execute(input, ctx)
    } finally {
      if (ctx.imageResultSink === imageSink) ctx.imageResultSink = previousSink
    }
    const images = imageSink.length > 0 ? imageSink.slice() : undefined
    const stored = await maybeStoreToolResult(call.name, call.id, output, {
      dir: toolResultStoreDir,
      conversationId: ctx.conversationId,
    })
    const postHook = await applyPostToolUseHooks(hooks, call.name, input, output, ctx)
    const events: AgentEvent[] = postHook.additionalContext.map((text): AgentEvent => ({ type: 'context_note', text }))
    const modelContent = postHook.additionalContext.length > 0
      ? `${stored.content}\n\n${hookContextBlock('PostToolUse', postHook.additionalContext)}`
      : stored.content
    // 结果被落盘替换成预览时(storable 且超阈值)不再挂原图;read_file 非 storable,恒不替换 → 图正常回灌。
    const feedback = toolFeedback(call, stored.content, false, modelContent, stored.stored ? undefined : images)
    events.push(...feedback.events)
    return { result: feedback.result, events }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // PostToolUseFailure 钩:工具抛错时触发(对齐 cc);非阻断,只把 hook 追加的上下文并入回灌,
    // 不改变"错误文本回灌让模型自救"的既有失败路径。
    const failHook = await applyPostToolUseFailureHooks(hooks, call.name, input, message, ctx, call.id)
    const base = toolFeedback(call, `错误:工具 ${tool.name} 执行失败:${message}`, true)
    if (failHook.additionalContext.length === 0) return base
    const events: AgentEvent[] = [
      ...base.events,
      ...failHook.additionalContext.map((text): AgentEvent => ({ type: 'context_note', text })),
    ]
    return { result: base.result, events }
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
        const planFilePath = getPlanFilePath(ctx.workspace.root, ctx.conversationId)
        yield feedback([
          '<plan_mode_entered />',
          'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
          `Your plan file is: ${planFilePath}`,
          'This plan file is the ONLY file you are allowed to edit in plan mode — build your plan incrementally by writing to it with write_file, then refining with edit_file. Everything else must stay read-only.',
          'In plan mode, you should:',
          '1. Thoroughly explore the codebase to understand existing patterns (read-only tools only).',
          '2. Identify similar features and architectural approaches.',
          '3. Consider multiple approaches and their trade-offs.',
          '4. Use ask_user_question if you need to clarify the approach.',
          '5. Write the concrete, step-by-step plan into the plan file above.',
          '6. When the plan file is ready, call ExitPlanMode to present it for approval (ExitPlanMode reads the plan from that file — do NOT pass the plan as an argument).',
          'Remember: DO NOT write or edit any files other than the plan file yet. This is a read-only exploration and planning phase.',
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
      // cc ExitPlanModeV2 对齐:计划正文从**磁盘计划文件**读,而不是工具入参。模型还没写计划文件 → 先引导它写。
      const planFilePath = getPlanFilePath(ctx.workspace.root, ctx.conversationId)
      const plan = (getPlan(ctx.workspace.root, ctx.conversationId) ?? '').trim()
      if (!plan) {
        yield feedback(`计划文件 ${planFilePath} 还是空的。请先用 write_file 把完整、分步的计划写进这个文件(它是计划模式下你唯一能编辑的文件),再调用 ExitPlanMode 请求批准。`, true)
        return
      }
      const question = normalizeExitPlanQuestion(plan, call.id, call.input)
      const answerStartLen = ctx.steerInbox?.length ?? 0
      yield questionEvent(question)
      const answer = await waitForSteeringAnswer(ctx, question.timeoutMs, answerStartLen)
      if (answer && isPlanApprovalAnswer(answer)) {
        // cc 的 ExitPlanMode 批准默认高亮项即 "Yes, auto-accept edits" → acceptEdits;
        // 本项目单一"批准并执行"选项映射到同一档:批准整份计划后,实施阶段的文件编辑低摩擦放行,
        // 不再逐个 write/edit 重复弹卡(对外/不可逆/高风险动作仍走审批闸)。
        ctx.permissionMode = 'acceptEdits'
        ctx.pendingPlanVerification = {
          plan,
          verificationStarted: false,
          verificationCompleted: false,
          toolCallsSinceApproval: 0,
        }
        yield feedback(`<plan_approved>\n${plan}\n</plan_approved>\n计划已保存到:${planFilePath}(实施时可随时用 read_file 复看)。用户已批准计划,当前回合已退出计划模式并切到 acceptEdits(自动接受文件编辑)档。完成实施后必须直接调用 VerifyPlanExecution 并附可复核证据。`, false)
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

  // 入参 schema 校验闸(对齐 cc `toolExecution.ts:615` 的 inputSchema.safeParse:权限/执行前统一挡结构化
  // InputValidationError)。内建工具走 strictObject 强校验(未知键/enum/嵌套 required/数组元素/number 范围),
  // MCP 工具(mcp__ 前缀)走 passthrough 不拒未知键;交互工具(ask/plan/verify)在上方已各自处理、不到这里。
  const inputValidationError = validateToolInput(tool.inputSchema, call.input, { strict: !isMcpToolName(call.name) })
  if (inputValidationError) {
    yield feedback(`InputValidationError: ${inputValidationError}`, true)
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
  // cc PreToolUse hook permissionDecision:'allow' → 只跳过"默认档位该问"这一层(decision.reason.type==='mode'),
  // 不越过显式 ask 规则/forceConfirm/安全检查;deny>ask>allow 聚合由 hookAllowBypassesAsk 内部兜底。
  if (decision.behavior === 'ask' && hookAllowBypassesAsk(hookResult, decision)) {
    const outcome = yield* executeAllowedToolCallWithProgress(tool, call, hookInput, ctx, hooks, toolResultStoreDir)
    toolResults.push(outcome.result)
    for (const event of outcome.events) yield event
    return
  }
  // cc PreToolUse hook permissionDecision:'ask' → 即使当前档位/规则本会自动放行,也强制该次走审批闸。
  const forceAsk = hookResult.askRequested === true && decision.behavior === 'allow'
  if (decision.behavior === 'ask' || forceAsk) {
    const key = actionKey(call.name, hookInput)
    const rememberable = decision.behavior === 'ask' ? isApprovalRememberable(decision) : false
    // hook 强制的 ask 不走"本会话已允许/已停止询问"捷径(hook 明确要求当次询问);规则级 ask 保留原捷径。
    if (!forceAsk && rememberable && shouldAutoApproveForContext(ctx, key)) {
      const input = hookInput
      const outcome = yield* executeAllowedToolCallWithProgress(tool, call, input, ctx, hooks, toolResultStoreDir)
      toolResults.push(outcome.result)
      for (const event of outcome.events) yield event
      return
    }
    if (!forceAsk && shouldStopAskingForContext(ctx, key)) {
      yield feedback(DENIAL_FALLBACK_MSG(call.name), false)
      return
    }
    let preview: string | undefined
    try {
      preview = (await tool.previewFor?.(hookInput, ctx)) ?? undefined
    } catch {
      preview = undefined
    }
    const commandWarning = destructiveWarningForInput(call.name, hookInput)
    // Notification 落点(对齐参考实现:需要用户确认=需要通知用户 → 触发 Notification 钩子,fire-and-forget)。
    // 权限闸挂起、等待人工确认时通知宿主/外部通道;附加上下文非阻塞回灌,不改变审批流程本身。
    const notify = await applyNotificationHooks(hooks, {
      message: `需要你确认工具调用:${call.name}`,
      notificationType: 'permission',
    }, ctx)
    for (const extra of notify.additionalContext) yield { type: 'context_note', text: extra }
    yield {
      type: 'approval_request',
      tool: call.name,
      args: hookInput,
      id: call.id,
      token: signApproval(call.name, hookInput),
      preview,
      reason: decision.behavior === 'ask'
        ? decision.approvalReason
        : { what: `PreToolUse hook 要求确认调用 ${call.name}`, why: hookResult.askMessage ?? 'hook 请求人工确认', impact: '' },
      ...(commandWarning ? { warning: commandWarning } : {}),
      rememberable,
    }
    yield feedback(APPROVAL_PENDING_MSG(call.name), false)
    return
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
): Promise<{ ok: boolean; output: string; permissionUpdates?: PermissionUpdate[] }> {
  if (!verifyApproval(tool, tokenArgs, token)) return { ok: false, output: '审批校验失败:token 与动作不匹配,拒绝执行。' }
  const t = registry.get(tool)
  if (!t) return { ok: false, output: `未知工具 ${tool}` }
  const decision = resolvePermission(t, args, ctx)
  if (decision.behavior === 'deny') return { ok: false, output: decision.message }
  const executionArgs = decision.behavior === 'allow' ? decision.updatedInput ?? args : args
  const approvalClass = decision.behavior === 'ask'
    ? decision.approvalClass
    : t.approvalClassFor?.(executionArgs, ctx) ?? t.approvalClass
  const transientUpdates = decision.behavior === 'ask'
    ? transientPermissionUpdatesForApproval(tool, executionArgs, ctx)
    : []
  const rememberedUpdates = remember && decision.behavior === 'ask' && isApprovalRememberable(decision)
    ? rememberedPermissionUpdatesForApproval(tool, executionArgs, ctx, approvalClass)
    : []
  const executionCtx = transientUpdates.length ? applyPermissionUpdates(ctx, transientUpdates) : ctx
  clearDenialForContext(ctx, actionKey(tool, tokenArgs))
  clearDenialForContext(ctx, actionKey(tool, executionArgs))
  const previousApprovedToolExecution = executionCtx.approvedToolExecution
  try {
    executionCtx.approvedToolExecution = { name: tool, key: actionKey(tool, tokenArgs) }
    const output = await t.execute(executionArgs, executionCtx)
    const stored = await maybeStoreToolResult(tool, 'approved', output, {
      dir: executionCtx.toolResultStoreDir,
      conversationId: executionCtx.conversationId,
    })
    if (remember) {
      if (decision.behavior === 'ask' && isApprovalRememberable(decision)) {
        recordApprovalForContext(ctx, actionKey(tool, executionArgs))
      }
    }
    return { ok: true, output: stored.content, ...(rememberedUpdates.length ? { permissionUpdates: rememberedUpdates } : {}) }
  } catch (err) {
    return { ok: false, output: `工具 ${tool} 执行失败:${err instanceof Error ? err.message : String(err)}` }
  } finally {
    executionCtx.approvedToolExecution = previousApprovedToolExecution
  }
}

/** 老板拒绝某审批(给独立 /agent/reject 用):记一次拒绝,喂给下次的 shouldStopAsking。 */
export function handleReject(tool: string, args: unknown, ctx: ToolContext): void {
  const key = actionKey(tool, args)
  clearApprovalForContext(ctx, key)
  recordDenialForContext(ctx, key)
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
