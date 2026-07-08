import { stat, utimes } from 'node:fs/promises'
import { runAgentLoop } from '../harness/loop'
import type { AgentDefinition } from '../agents/agentLoader'
import { resolveAgentTools } from '../agents/agentLoader'
import { loadAgentMcpRuntime, type AgentMcpRuntimeOptions } from '../agents/agentMcp'
import type { Model } from '../types/model'
import { textBlock, type Message } from '../types/message'
import type { AgentEvent } from '../types/events'
import type { Tool, ToolContext } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'
import { Sandbox } from '../sandbox/sandbox'
import { Workspace } from '../workspace/workspace'
import type { BackgroundAgentMetadata, TaskEventRecord, TaskMeta, TaskService, TaskStatus } from './taskService'
import { createIsolatedAgentWorktree, type AgentWorktreeCleanupResult } from '../tools/worktreeTools'
import { applySubagentStartHooks, mergeHookRegistries, type HookRegistry } from '../hooks/hooks'
import { buildAgentMemoryPrompt, workspaceWithAgentMemory } from '../agents/agentMemory'
import {
  cloneContentReplacementState,
  reconstructContentReplacementState,
  type ContentReplacementRecord,
} from '../context/toolResultStorage'
import { startAgentSummarization, type AgentSummaryController } from './agentSummary'
import { createDenialTrackingState } from '../permissions/denialTracking'
import { FORK_SUBAGENT_TYPE, isForkQuerySource, isInForkChild, type ForkRunContext } from '../agents/forkSubagent'

export interface BackgroundAgentTaskInput {
  agent?: string
  name?: string
  task: string
  context?: string
  title?: string
  isolation?: 'worktree'
}

export interface BackgroundAgentTaskOptions {
  tasks: TaskService
  agents: AgentDefinition[]
  model: Model
  baseTools: Tool[]
  baseSystemPrompt?: string
  maxTurns?: number
  hooks?: HookRegistry
  mcp?: AgentMcpRuntimeOptions
  agentSummaryIntervalMs?: number
}

function pickAgent(agents: AgentDefinition[], name: unknown): AgentDefinition | null {
  if (typeof name === 'string' && name.trim()) {
    const wanted = name.trim()
    return agents.find(agent => agent.name === wanted) ?? null
  }
  return agents.length === 1 ? agents[0]! : null
}

function agentList(agents: AgentDefinition[]): string {
  return agents.map(agent => `${agent.name}: ${agent.description}`).join('\n')
}

function taskMessage(input: BackgroundAgentTaskInput): string {
  const task = input.task.trim()
  const context = input.context?.trim()
  return context
    ? `${task}\n\n<context>\n${context}\n</context>`
    : task
}

function agentTaskMessage(agent: AgentDefinition, input: BackgroundAgentTaskInput): string {
  const base = taskMessage(input)
  return agent.initialPrompt?.trim()
    ? `${agent.initialPrompt.trim()}\n\n${base}`
    : base
}

function hookContextMessage(event: string, contexts: string[]): Message | undefined {
  if (contexts.length === 0) return undefined
  return { role: 'user', content: [textBlock(`<hook_context event="${event}">\n${contexts.join('\n\n')}\n</hook_context>`)] }
}

function taskTitle(input: BackgroundAgentTaskInput, agent: AgentDefinition): string {
  const displayName = normalizeAgentInstanceName(input.name) || agent.name
  return input.title?.trim() || `${displayName}: ${input.task.trim().slice(0, 80)}`
}

async function agentSystemPrompt(agent: AgentDefinition, workspaceRoot: string, baseSystemPrompt = ''): Promise<string> {
  const memoryPrompt = agent.memory
    ? await buildAgentMemoryPrompt(agent.name, agent.memory, workspaceRoot)
    : ''
  return [
    baseSystemPrompt,
    `<background_subagent name="${agent.name}">`,
    agent.prompt,
    '</background_subagent>',
    memoryPrompt,
    'You are running in a background task. Keep progress concise and return a final result for the user.',
  ].filter(Boolean).join('\n\n')
}

function backgroundTaskParams(input: BackgroundAgentTaskInput, agent: AgentDefinition, extraParams: Record<string, unknown> = {}): Record<string, unknown> {
  const name = normalizeAgentInstanceName(input.name)
  const isolation = input.isolation ?? agent.isolation
  return {
    agent: agent.name,
    ...(name ? { name } : {}),
    task: input.task.trim(),
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    ...(isolation === 'worktree' ? { isolation: 'worktree' } : {}),
    ...(agent.permissionMode ? { permission_mode: agent.permissionMode } : {}),
    ...(agent.maxTurns ? { max_turns: agent.maxTurns } : {}),
    ...extraParams,
  }
}

function oneLine(value: unknown, max = 160): string {
  let raw = ''
  if (typeof value === 'string') {
    raw = value
  } else if (value !== undefined && value !== null) {
    try {
      raw = JSON.stringify(value) ?? String(value)
    } catch {
      raw = String(value)
    }
  }
  const clean = raw.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

function inputHint(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const record = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'query', 'pattern', 'command', 'name', 'url', 'task']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return oneLine(value, 96)
  }
  return oneLine(input, 96)
}

function progressStageForEvent(event: AgentEvent): string {
  if (event.type === 'thinking') {
    const text = oneLine(event.text)
    return text ? `思考:${text}` : ''
  }
  if (event.type === 'tool_call') {
    const hint = inputHint(event.input)
    return `调用 ${event.tool}${hint ? `: ${hint}` : ''}`
  }
  if (event.type === 'tool_progress') {
    const chunk = oneLine(event.chunk)
    return chunk ? `${event.tool} 进度:${chunk}` : `${event.tool} 运行中`
  }
  if (event.type === 'tool_result') return `${event.tool} 完成`
  if (event.type === 'approval_request') return `等待确认:${event.tool}`
  if (event.type === 'ask_question') return `等待补充:${oneLine(event.question, 120)}`
  if (event.type === 'todo_update') return '更新任务清单'
  if (event.type === 'context_note') return oneLine(event.text)
  if (event.type === 'final') return '整理最终结果'
  return ''
}

function progressValueForEvent(event: AgentEvent, current: number): number {
  if (event.type === 'thinking' || event.type === 'context_note' || event.type === 'usage_update') return Math.max(current, 8)
  if (event.type === 'tool_call') return Math.max(current + 4, 18)
  if (event.type === 'tool_progress') return Math.max(current + 1, 22)
  if (event.type === 'tool_result' || event.type === 'todo_update') return Math.max(current + 5, 28)
  if (event.type === 'approval_request' || event.type === 'ask_question') return Math.max(current, 35)
  if (event.type === 'final') return Math.max(current, 95)
  return current
}

function createBackgroundAgentProgressReporter(update: (progress: number, stage: string) => Promise<void>) {
  let progress = 5
  let lastStage = ''

  return async (event: AgentEvent): Promise<void> => {
    const stage = progressStageForEvent(event)
    const nextProgress = Math.min(95, progressValueForEvent(event, progress))
    if (!stage) return
    if (stage === lastStage && nextProgress === progress) return
    progress = nextProgress
    if (stage) lastStage = stage
    await update(progress, stage || lastStage)
  }
}

function normalizeAgentInstanceName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  if (!name) return ''
  if (name === '*' || name.includes('@')) throw new Error('background agent name must be a bare SendMessage recipient name')
  if (name.length > 128) throw new Error('background agent name is too long')
  return name
}

function stringMetadata(value: string | undefined): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function stringTaskParam(task: TaskMeta, key: string): string {
  const value = task.params?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function resumableAgentName(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return stringMetadata(metadata?.agent) || stringMetadata(metadata?.agentType) || stringTaskParam(task, 'agent')
}

function resumableInstanceName(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return stringMetadata(metadata?.name) || stringTaskParam(task, 'name') || stringTaskParam(task, 'agentName') || stringTaskParam(task, 'agent_name')
}

function resumableStableAgentId(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return stringMetadata(metadata?.agentId) || stringTaskParam(task, 'agent_id') || stringTaskParam(task, 'agentId') || task.id
}

function resumableToolResultStoreDir(task: TaskMeta, tasks: TaskService, metadata?: BackgroundAgentMetadata | null): string {
  return stringMetadata(metadata?.toolResultStoreDir) || stringTaskParam(task, 'tool_result_store_dir') || tasks.backgroundAgentToolResultStoreDir(task.id)
}

function originalTaskText(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return stringMetadata(metadata?.task) || stringTaskParam(task, 'task') || task.title
}

function originalContextText(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return stringMetadata(metadata?.context) || stringTaskParam(task, 'context')
}

function resumeContext(task: TaskMeta, prompt: string, metadata?: BackgroundAgentMetadata | null): string {
  return [
    `This is a resumed background agent run triggered by SendMessage for task ${task.id} (previous status: ${task.status}).`,
    `Original task:\n${originalTaskText(task, metadata)}`,
    originalContextText(task, metadata) ? `Original context:\n${originalContextText(task, metadata)}` : '',
    `New message from team-lead:\n${prompt.trim()}`,
  ].filter(Boolean).join('\n\n')
}

function filterUnresolvedToolUseMessages(messages: Message[]): Message[] {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseIds.add(block.id)
      if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id)
    }
  }
  const unresolved = new Set([...toolUseIds].filter(id => !toolResultIds.has(id)))
  if (unresolved.size === 0) return messages
  return messages.filter(message => {
    if (message.role !== 'assistant') return true
    const toolUseBlockIds = message.content
      .filter(block => block.type === 'tool_use')
      .map(block => block.id)
    if (toolUseBlockIds.length === 0) return true
    return !toolUseBlockIds.every(id => unresolved.has(id))
  })
}

function filterWhitespaceOnlyAssistantMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.role !== 'assistant' || message.content.length === 0) return true
    return !message.content.every(block => block.type === 'text' && !block.text.trim())
  })
}

function filterOrphanedThinkingOnlyMessages(messages: Message[]): Message[] {
  return messages.filter(message => {
    if (message.role !== 'assistant' || message.content.length === 0) return true
    return !message.content.every(block => block.type === 'thinking')
  })
}

export function sanitizeBackgroundAgentResumeMessages(messages: Message[]): Message[] {
  return filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUseMessages(messages),
    ),
  )
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function touchDirectoryMtime(path: string): Promise<void> {
  const now = new Date()
  await utimes(path, now, now).catch(() => undefined)
}

function sandboxForWorkspace(base: Sandbox | undefined, workspace: Workspace): Sandbox | undefined {
  return base?.isOsSandboxActive() ? new Sandbox({ workspace, enabled: true }) : base
}

function formatAgentWorktreeNote(cleanup: AgentWorktreeCleanupResult | null): string {
  if (!cleanup) return ''
  if (!cleanup.kept) return `Agent worktree was clean and removed. changed_files=${cleanup.changedFiles} commits=${cleanup.commits}`
  return `Agent worktree kept at ${cleanup.worktreePath} on ${cleanup.worktreeBranch}. changed_files=${cleanup.changedFiles} commits=${cleanup.commits}`
}

async function resumeToolContext(previousTask: TaskMeta, ctx: ToolContext, metadata?: BackgroundAgentMetadata | null): Promise<{ ctx: ToolContext; params: Record<string, unknown> }> {
  const worktreePath = stringMetadata(metadata?.worktreePath)
  const workspaceRoot = stringMetadata(metadata?.workspaceRoot) ||
    (typeof previousTask.workspaceRoot === 'string' && previousTask.workspaceRoot.trim() ? previousTask.workspaceRoot.trim() : '')
  if (worktreePath) {
    if (await directoryExists(worktreePath)) {
      await touchDirectoryMtime(worktreePath)
      const workspace = new Workspace(worktreePath)
      const sandbox = ctx.sandbox?.isOsSandboxActive()
        ? new Sandbox({ workspace, enabled: true })
        : ctx.sandbox
      return {
        ctx: { ...ctx, workspace, sandbox },
        params: {
          resumed_workspace_root: workspace.root,
          resumed_worktree_path: workspace.root,
        },
      }
    }
    if (!workspaceRoot || workspaceRoot === worktreePath) {
      return {
        ctx,
        params: {
          resumed_workspace_root: ctx.workspace.root,
          resume_worktree_missing: worktreePath,
        },
      }
    }
  }
  if (!workspaceRoot || workspaceRoot === ctx.workspace.root) {
    return {
      ctx,
      params: {
        ...(workspaceRoot ? { resumed_workspace_root: ctx.workspace.root } : {}),
        ...(worktreePath ? { resume_worktree_missing: worktreePath } : {}),
      },
    }
  }
  if (!(await directoryExists(workspaceRoot))) {
    return {
      ctx,
      params: {
        resumed_workspace_root: ctx.workspace.root,
        ...(worktreePath ? { resume_worktree_missing: worktreePath } : {}),
        resume_workspace_missing: workspaceRoot,
      },
    }
  }
  const workspace = new Workspace(workspaceRoot)
  const sandbox = ctx.sandbox?.isOsSandboxActive()
    ? new Sandbox({ workspace, enabled: true })
    : ctx.sandbox
  return {
    ctx: { ...ctx, workspace, sandbox },
    params: {
      resumed_workspace_root: workspace.root,
      ...(worktreePath ? { resume_worktree_missing: worktreePath } : {}),
    },
  }
}

export interface BackgroundAgentRunResult {
  task: TaskMeta
  agent: AgentDefinition
}

interface BackgroundAgentRunOptions {
  replaceTaskId?: string
  forkContext?: ForkRunContext
}

async function createOrReplaceBackgroundAgentTask(
  opts: BackgroundAgentTaskOptions,
  input: BackgroundAgentTaskInput,
  ctx: ToolContext,
  agent: AgentDefinition,
  params: Record<string, unknown>,
  replaceTaskId?: string,
): Promise<TaskMeta> {
  const payload = {
    title: taskTitle(input, agent),
    kind: 'background_agent',
    conversationId: ctx.conversationId,
    workspaceRoot: ctx.workspace.root,
    progress: 0,
    stage: undefined,
    params,
    result: undefined,
    error: undefined,
  }
  if (!replaceTaskId) return opts.tasks.create(payload)
  const existing = await opts.tasks.get(replaceTaskId)
  if (existing?.status === 'queued' || existing?.status === 'running') {
    throw new Error(`background agent task ${replaceTaskId} is already running`)
  }
  if (!existing) return opts.tasks.create({ id: replaceTaskId, ...payload })
  return opts.tasks.touch(replaceTaskId, payload)
}

export async function startBackgroundAgentRun(
  opts: BackgroundAgentTaskOptions,
  input: BackgroundAgentTaskInput,
  ctx: ToolContext,
  extraParams: Record<string, unknown> = {},
  initialMessages: Message[] = [],
  initialContentReplacementRecords: ContentReplacementRecord[] = [],
  runOptions: BackgroundAgentRunOptions = {},
): Promise<BackgroundAgentRunResult> {
  if (!input || typeof input.task !== 'string' || !input.task.trim()) throw new Error('start_background_agent_task 需要 string 参数 task')
  const agent = runOptions.forkContext
    ? {
        name: FORK_SUBAGENT_TYPE,
        description: 'Forked worker inheriting the parent coding-agent context.',
        prompt: '',
        filePath: 'built-in:fork',
        permissionMode: ctx.permissionMode,
        maxTurns: opts.maxTurns,
      } satisfies AgentDefinition
    : pickAgent(opts.agents, input.agent)
  if (!agent) throw new Error(`start_background_agent_task 需要指定 agent;可用 agent:\n${agentList(opts.agents)}`)
  let task = await createOrReplaceBackgroundAgentTask(opts, input, ctx, agent, backgroundTaskParams(input, agent, {
    ...extraParams,
    ...(runOptions.forkContext ? { fork_context: true } : {}),
  }), runOptions.replaceTaskId)
  const stableAgentId = stringTaskParam(task, 'agent_id') || stringTaskParam(task, 'agentId') || task.id
  if (!stringTaskParam(task, 'agent_id')) {
    task = await opts.tasks.touch(task.id, { params: { ...task.params, agent_id: stableAgentId } })
  }
  const effectiveIsolation = input.isolation ?? agent.isolation
  const agentWorktree = effectiveIsolation === 'worktree'
    ? await createIsolatedAgentWorktree(ctx.workspace.root, task.id, ctx.conversationId)
    : null
  const runWorkspaceBase = agentWorktree ? new Workspace(agentWorktree.session.worktreePath) : ctx.workspace
  const runWorkspace = workspaceWithAgentMemory(runWorkspaceBase, agent.name, agent.memory)
  const runSandbox = sandboxForWorkspace(ctx.sandbox, runWorkspace)
  const resumedWorktreePath = typeof extraParams.resumed_worktree_path === 'string' && extraParams.resumed_worktree_path.trim()
    ? extraParams.resumed_worktree_path.trim()
    : ''
  const metadataWorktreePath = agentWorktree?.session.worktreePath || resumedWorktreePath || ctx.worktreeSession?.worktreePath
  const inheritedToolResultStoreDir = typeof extraParams.tool_result_store_dir === 'string' && extraParams.tool_result_store_dir.trim()
    ? extraParams.tool_result_store_dir.trim()
    : ''
  const toolResultStoreDir = inheritedToolResultStoreDir || opts.tasks.backgroundAgentToolResultStoreDir(task.id)
  void opts.tasks.writeBackgroundAgentMetadata(task.id, {
    agentId: stableAgentId,
    agent: agent.name,
    agentType: agent.name,
    ...(typeof task.params?.name === 'string' && task.params.name.trim() ? { name: task.params.name.trim() } : {}),
    task: input.task.trim(),
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    description: task.title,
    conversationId: ctx.conversationId,
    workspaceRoot: ctx.workspace.root,
    ...(metadataWorktreePath ? { worktreePath: metadataWorktreePath } : {}),
    toolResultStoreDir,
  }).catch(() => undefined)
  const baseAgentTools = runOptions.forkContext
    ? (runOptions.forkContext.tools.length > 0 ? runOptions.forkContext.tools : opts.baseTools)
    : resolveAgentTools(agent, opts.baseTools)
      .filter(tool => tool.name !== 'start_background_agent_task' && tool.name !== 'cancel_background_task')
  const steerInbox: string[] = []
  const detachSteerInbox = opts.tasks.attachSteerInbox(task.id, steerInbox)
  const hooks = mergeHookRegistries(opts.hooks, agent.hooks)
  if (initialContentReplacementRecords.length > 0) {
    await opts.tasks.transcript(task.id).seedContentReplacementRecords(initialContentReplacementRecords)
  }
  const inheritedContentReplacementState = initialMessages.length > 0
    ? reconstructContentReplacementState(initialMessages, initialContentReplacementRecords, ctx.contentReplacementState?.replacements)
    : ctx.contentReplacementState ? cloneContentReplacementState(ctx.contentReplacementState) : undefined
  opts.tasks.start(task.id, async taskCtx => {
    let finalText = ''
    let cleanup: AgentWorktreeCleanupResult | null = null
    let agentMcp: Awaited<ReturnType<typeof loadAgentMcpRuntime>> | undefined
    let summarizer: AgentSummaryController | undefined
    const updateProgress = async (progress: number, stage: string) => {
      await opts.tasks.touch(task.id, { progress, stage }).catch(() => undefined)
    }
    const reportProgress = createBackgroundAgentProgressReporter(updateProgress)
    try {
      await updateProgress(5, `启动 ${agent.name} 子代理`)
      agentMcp = await loadAgentMcpRuntime({
        agent,
        baseTools: baseAgentTools,
        workspaceRoot: runWorkspace.root,
        signal: taskCtx.signal,
        taskId: task.id,
        mcpConfigPath: opts.mcp?.mcpConfigPath,
        loadOptions: opts.mcp?.loadOptions,
      })
      for (const warning of agentMcp.warnings) {
        await taskCtx.emit({ type: 'context_note', text: warning })
      }
      if (agentWorktree) await taskCtx.emit({ type: 'context_note', text: `Background agent using isolated worktree: ${agentWorktree.session.worktreePath}` })
      summarizer = startAgentSummarization({
        taskId: task.id,
        model: opts.model,
        intervalMs: opts.agentSummaryIntervalMs,
        signal: taskCtx.signal,
        updateSummary: async summary => {
          await opts.tasks.touch(task.id, { summary }).catch(() => undefined)
        },
      })
      const subagentStart = await applySubagentStartHooks(hooks, stableAgentId, agent.name, {
        ...ctx,
        workspace: runWorkspace,
        sandbox: runSandbox,
        signal: taskCtx.signal,
        conversationId: stableAgentId,
        toolResultStoreDir,
        contentReplacementState: inheritedContentReplacementState,
      })
      for (const extra of subagentStart.additionalContext) {
        await taskCtx.emit({ type: 'context_note', text: extra })
      }
      for await (const event of runAgentLoop({
        model: opts.model,
        registry: new ToolRegistry(agentMcp.tools),
        workspace: runWorkspace,
        systemPrompt: runOptions.forkContext?.systemPrompt ?? await agentSystemPrompt(agent, runWorkspace.root, opts.baseSystemPrompt),
        userMessage: agentTaskMessage(agent, input),
        initialMessages: [
          ...(runOptions.forkContext?.initialMessages ?? []),
          ...initialMessages,
          ...[hookContextMessage('SubagentStart', subagentStart.additionalContext)].filter((message): message is Message => !!message),
        ],
        skipUserMessage: !!runOptions.forkContext,
        maxTurns: agent.maxTurns ?? opts.maxTurns ?? 8,
        signal: taskCtx.signal,
        sandbox: runSandbox,
        permissionMode: agent.permissionMode ?? ctx.permissionMode,
        localDenialTracking: createDenialTrackingState(),
        conversationId: stableAgentId,
        steerInbox,
        transcript: opts.tasks.transcript(task.id),
        toolResultStoreDir,
        hooks,
        subagent: { agentId: stableAgentId, agentType: agent.name },
        querySource: runOptions.forkContext?.querySource,
        contentReplacementState: inheritedContentReplacementState,
        onSummarySnapshot: snapshot => summarizer?.updateSnapshot(snapshot),
      })) {
        await taskCtx.emit(event)
        await reportProgress(event)
        if (event.type === 'final') finalText = event.text
      }
    } finally {
      summarizer?.stop()
      await agentMcp?.close()
      cleanup = agentWorktree ? await agentWorktree.cleanupIfClean().catch(() => ({
        kept: true,
        worktreePath: agentWorktree.session.worktreePath,
        worktreeBranch: agentWorktree.session.worktreeBranch,
        changedFiles: -1,
        commits: -1,
      })) : null
      const worktreeNote = formatAgentWorktreeNote(cleanup)
      if (worktreeNote) await taskCtx.emit({ type: 'context_note', text: worktreeNote }).catch(() => undefined)
      if (cleanup) {
        await opts.tasks.writeBackgroundAgentMetadata(task.id, {
          agentId: stableAgentId,
          agent: agent.name,
          agentType: agent.name,
          ...(typeof task.params?.name === 'string' && task.params.name.trim() ? { name: task.params.name.trim() } : {}),
          task: input.task.trim(),
          ...(input.context?.trim() ? { context: input.context.trim() } : {}),
          description: task.title,
          conversationId: ctx.conversationId,
          workspaceRoot: ctx.workspace.root,
          worktreePath: cleanup.kept && cleanup.worktreePath ? cleanup.worktreePath : undefined,
          toolResultStoreDir,
        }).catch(() => undefined)
      }
      detachSteerInbox()
    }
    return finalText
  })
  return { task, agent }
}

export async function resumeBackgroundAgentTask(
  opts: BackgroundAgentTaskOptions,
  previousTask: TaskMeta,
  prompt: string,
  ctx: ToolContext,
): Promise<BackgroundAgentRunResult> {
  const metadata = await opts.tasks.readBackgroundAgentMetadata(previousTask.id)
  const agentName = resumableAgentName(previousTask, metadata)
  if (!agentName) throw new Error(`Task ${previousTask.id} has no background agent name to resume`)
  const previousTranscript = opts.tasks.transcript(previousTask.id)
  const [previousRawMessages, previousReplacementRecords] = await Promise.all([
    previousTranscript.load(),
    previousTranscript.loadContentReplacementRecords(),
  ])
  const previousMessages = sanitizeBackgroundAgentResumeMessages(previousRawMessages)
  const resumedContext = await resumeToolContext(previousTask, ctx, metadata)
  const instanceName = resumableInstanceName(previousTask, metadata)
  const stableAgentId = resumableStableAgentId(previousTask, metadata)
  const toolResultStoreDir = resumableToolResultStoreDir(previousTask, opts.tasks, metadata)
  const { task, agent } = await startBackgroundAgentRun(opts, {
    agent: agentName,
    ...(instanceName ? { name: instanceName } : {}),
    task: prompt,
    context: resumeContext(previousTask, prompt, metadata),
    title: `${instanceName || agentName}: resumed: ${prompt.trim().slice(0, 60)}`,
  }, resumedContext.ctx, {
    resume_source: 'SendMessage',
    previous_status: previousTask.status,
    ...(metadata ? { resume_metadata: true } : {}),
    agent_id: stableAgentId,
    replayed_messages: previousMessages.length,
    tool_result_store_dir: toolResultStoreDir,
    ...resumedContext.params,
  }, previousMessages, previousReplacementRecords, { replaceTaskId: previousTask.id })
  await opts.tasks.appendEvent(previousTask.id, {
    type: 'context_note',
    text: `SendMessage resumed this background agent as task ${task.id}.`,
  }).catch(() => undefined)
  return { task, agent }
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function statusFrom(value: unknown): TaskStatus | undefined {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined
}

function formatTasks(tasks: Awaited<ReturnType<TaskService['list']>>): string {
  if (tasks.length === 0) return '当前没有后台任务。'
  return tasks.map(task => {
    const suffix = [
      task.conversationId ? `conversation=${task.conversationId}` : '',
      task.summary ? `summary=${task.summary}` : '',
      task.stage ? `stage=${task.stage}` : '',
      task.error ? `error=${task.error}` : '',
    ].filter(Boolean).join(' ')
    return `- ${task.id} [${task.status}] ${task.title}${suffix ? ` ${suffix}` : ''}`
  }).join('\n')
}

async function resolveTaskReference(
  tasks: TaskService,
  target: string,
  ctx: ToolContext,
  statuses?: TaskStatus[],
): Promise<{ task: TaskMeta | null; requestedTaskId: string }> {
  const requestedTaskId = target.trim()
  const resolution = await tasks.resolveBackgroundAgentTarget(requestedTaskId, {
    conversationId: ctx.conversationId,
    ...(statuses ? { statuses } : {}),
  })
  if (resolution.ambiguous) throw new Error(resolution.reason || `Multiple background agents match "${requestedTaskId}". Use a task id.`)
  if (resolution.task) return { task: resolution.task, requestedTaskId }
  return { task: await tasks.get(requestedTaskId), requestedTaskId }
}

function formatTaskEvents(task: NonNullable<Awaited<ReturnType<TaskService['get']>>>, events: Awaited<ReturnType<TaskService['loadEvents']>>, requestedTaskId?: string): string {
  const requested = requestedTaskId && requestedTaskId !== task.id ? ` requested_id="${xmlAttr(requestedTaskId)}"` : ''
  const agentId = typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? ` agent_id="${xmlAttr(task.params.agent_id.trim())}"` : ''
  const lines = [
    `<background_task id="${xmlAttr(task.id)}"${requested}${agentId} status="${xmlAttr(task.status)}" title="${xmlAttr(task.title)}">`,
    task.summary ? `<summary>${xmlText(task.summary)}</summary>` : '',
    task.stage ? `<stage>${xmlText(task.stage)}</stage>` : '',
    ...events.map(record => `#${record.seq} ${record.event.type} ${JSON.stringify(record.event)}`),
    '</background_task>',
  ].filter(Boolean)
  return lines.join('\n')
}

function clampTimeoutMs(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 30_000
  return Math.max(0, Math.min(600_000, Math.floor(n)))
}

function semanticBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
  return fallback
}

function taskIsSettled(task: TaskMeta): boolean {
  return task.status !== 'queued' && task.status !== 'running'
}

async function waitForTask(tasks: TaskService, taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskMeta | null> {
  const deadline = Date.now() + timeoutMs
  let current = await tasks.get(taskId)
  while (current && !taskIsSettled(current) && Date.now() <= deadline) {
    if (signal?.aborted) throw new Error('TaskOutput 已取消等待')
    await new Promise(resolve => setTimeout(resolve, 100))
    current = await tasks.get(taskId)
  }
  return current
}

function taskEventText(record: TaskEventRecord): string {
  const event = record.event
  if ('text' in event && typeof event.text === 'string') return event.text
  if ('output' in event && typeof event.output === 'string') return event.output
  if ('content' in event && typeof event.content === 'string') return event.content
  return JSON.stringify(event)
}

function extractTaskOutput(task: TaskMeta, events: TaskEventRecord[]): string {
  if (typeof task.result === 'string' && task.result.trim()) return task.result
  const finalTexts = events
    .filter(record => record.event.type === 'final')
    .map(taskEventText)
    .filter(Boolean)
  if (finalTexts.length > 0) return finalTexts.join('\n')
  return events.map(record => `#${record.seq} ${record.event.type} ${taskEventText(record)}`).join('\n')
}

function formatCcTaskOutput(status: 'success' | 'timeout' | 'not_ready', task: TaskMeta | null, events: TaskEventRecord[] = [], requestedTaskId?: string): string {
  const parts = [`<retrieval_status>${status}</retrieval_status>`]
  if (!task) return parts.join('\n\n')
  if (requestedTaskId && requestedTaskId !== task.id) parts.push(`<requested_task_id>${xmlText(requestedTaskId)}</requested_task_id>`)
  parts.push(`<task_id>${xmlText(task.id)}</task_id>`)
  if (typeof task.params?.agent_id === 'string' && task.params.agent_id.trim()) parts.push(`<agent_id>${xmlText(task.params.agent_id.trim())}</agent_id>`)
  parts.push(`<task_type>${xmlText(task.kind ?? 'background_task')}</task_type>`)
  parts.push(`<status>${xmlText(task.status)}</status>`)
  parts.push(`<description>${xmlText(task.title)}</description>`)
  if (task.error) parts.push(`<error>${xmlText(task.error)}</error>`)
  const output = extractTaskOutput(task, events).trimEnd()
  if (output) parts.push(`<output>\n${xmlText(output)}\n</output>`)
  return parts.join('\n\n')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

function taskOutputAlias(tool: Tool, name: string): Tool {
  return {
    ...tool,
    name,
    description: `${tool.description} Legacy CC-Haha alias for TaskOutput.`,
  }
}

export function createTaskTools(tasks: TaskService): Tool[] {
  const listTasks: Tool = {
    name: 'list_background_tasks',
    description: 'List background tasks for this conversation or all conversations. Input: { conversationId?, status?, limit? }.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    isReadOnly: true,
    async execute(input, ctx) {
      const args = recordInput(input)
      const conversationId = typeof args.conversationId === 'string' && args.conversationId.trim()
        ? args.conversationId.trim()
        : ctx.conversationId
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      return formatTasks(await tasks.list({ conversationId, status: statusFrom(args.status), limit, collapseResumedBackgroundAgents: true }))
    },
  }

  const readTask: Tool = {
    name: 'read_background_task',
    description: 'Read background task status and recent events. Input: { task_id, after?, limit? }.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        after: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['task_id'],
    },
    isReadOnly: true,
    async execute(input, ctx) {
      const args = recordInput(input)
      if (typeof args.task_id !== 'string' || !args.task_id.trim()) throw new Error('read_background_task 需要 string 参数 task_id')
      const { task, requestedTaskId } = await resolveTaskReference(tasks, args.task_id, ctx)
      if (!task) return `没有找到后台任务:${args.task_id}`
      const after = typeof args.after === 'number' ? args.after : undefined
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      return formatTaskEvents(task, await tasks.loadEvents(task.id, { after, limit }), requestedTaskId)
    },
  }

  const cancelTask: Tool = {
    name: 'cancel_background_task',
    description: 'Cancel a running background task. Input: { task_id }.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const args = recordInput(input)
      if (typeof args.task_id !== 'string' || !args.task_id.trim()) throw new Error('cancel_background_task 需要 string 参数 task_id')
      const { task, requestedTaskId } = await resolveTaskReference(tasks, args.task_id, ctx, ['queued', 'running'])
      const taskId = task?.id ?? requestedTaskId
      const cancelled = await tasks.cancel(taskId)
      const alias = task && task.id !== requestedTaskId ? ` (requested:${requestedTaskId})` : ''
      return cancelled ? `已请求取消后台任务:${taskId}${alias}` : `后台任务未在运行:${requestedTaskId}`
    },
  }

  const taskOutput: Tool = {
    name: 'TaskOutput',
    description: [
      'Read output/logs from a background task by id. CC-Haha-compatible TaskOutput.',
      'Input: { task_id, block?, timeout?, limit? }. block=true waits for completion up to timeout ms; block=false returns current status immediately.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        block: { type: ['boolean', 'string'], description: 'Whether to wait for completion. Defaults true.' },
        timeout: { type: ['number', 'string'], description: 'Max wait time in ms, capped at 600000. Defaults 30000.' },
        limit: { type: 'number', description: 'Maximum event records to read. Defaults TaskService limit.' },
      },
      required: ['task_id'],
    },
    isReadOnly: true,
    async execute(input, ctx) {
      const args = recordInput(input)
      if (typeof args.task_id !== 'string' || !args.task_id.trim()) throw new Error('TaskOutput 需要 string 参数 task_id')
      const taskId = args.task_id.trim()
      const block = semanticBoolean(args.block, true)
      const timeout = clampTimeoutMs(args.timeout)
      const limit = typeof args.limit === 'number' ? args.limit : undefined
      const { task: initial, requestedTaskId } = await resolveTaskReference(tasks, taskId, ctx)
      if (!initial) throw new Error(`No task found with ID: ${taskId}`)
      const task = block ? await waitForTask(tasks, initial.id, timeout, ctx.signal) : initial
      if (!task) return formatCcTaskOutput('timeout', null)
      const events = await tasks.loadEvents(task.id, { limit })
      if (!taskIsSettled(task)) return formatCcTaskOutput(block ? 'timeout' : 'not_ready', task, events, requestedTaskId)
      return formatCcTaskOutput('success', task, events, requestedTaskId)
    },
  }

  const taskStop: Tool = {
    name: 'TaskStop',
    description: 'Stop a running background task by ID. CC-Haha-compatible TaskStop. Input: { task_id } or deprecated { shell_id }.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        shell_id: { type: 'string', description: 'Deprecated alias for task_id.' },
      },
    },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'destructive',
    forceConfirm: true,
    approvalReasonFor(input) {
      const args = recordInput(input)
      const taskId = typeof args.task_id === 'string' ? args.task_id : typeof args.shell_id === 'string' ? args.shell_id : ''
      return {
        what: `停止后台任务:${taskId || '(未指定)'}`,
        why: '停止后台任务会中断正在运行的子代理或长任务。',
        impact: '任务可能无法继续产出结果;仅在用户要求取消、任务失控、重复或明显无用时执行。',
      }
    },
    async execute(input, ctx) {
      const args = recordInput(input)
      const taskId = typeof args.task_id === 'string' && args.task_id.trim()
        ? args.task_id.trim()
        : typeof args.shell_id === 'string' && args.shell_id.trim()
          ? args.shell_id.trim()
          : ''
      if (!taskId) throw new Error('TaskStop 需要 task_id')
      const { task, requestedTaskId } = await resolveTaskReference(tasks, taskId, ctx, ['queued', 'running'])
      if (!task) throw new Error(`No task found with ID: ${taskId}`)
      if (task.status !== 'running' && task.status !== 'queued') {
        throw new Error(`Task ${taskId} is not running (status: ${task.status})`)
      }
      const stopped = await tasks.cancel(task.id)
      if (!stopped) throw new Error(`Task ${task.id} is not running`)
      const next = await tasks.get(task.id)
      return [
        '<task_stopped>',
        `<message>Successfully stopped task: ${xmlText(task.id)}</message>`,
        ...(requestedTaskId !== task.id ? [`<requested_task_id>${xmlText(requestedTaskId)}</requested_task_id>`] : []),
        `<task_id>${xmlText(task.id)}</task_id>`,
        ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? [`<agent_id>${xmlText(task.params.agent_id.trim())}</agent_id>`] : []),
        `<task_type>${xmlText(task.kind ?? 'background_task')}</task_type>`,
        `<status>${xmlText(next?.status ?? 'cancelled')}</status>`,
        `<command>${xmlText(task.title)}</command>`,
        '</task_stopped>',
      ].join('\n')
    },
  }

  return [
    listTasks,
    readTask,
    cancelTask,
    taskOutput,
    taskOutputAlias(taskOutput, 'AgentOutputTool'),
    taskOutputAlias(taskOutput, 'BashOutputTool'),
    taskStop,
  ]
}

export function createBackgroundAgentTaskTool(opts: BackgroundAgentTaskOptions): Tool<BackgroundAgentTaskInput> {
  return {
    name: 'start_background_agent_task',
    description: `Start a focused subagent in the background and return a task id immediately. Available agents:\n${agentList(opts.agents)}`,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name. Required when more than one agent is available.' },
        name: { type: 'string', description: 'Optional instance name. Makes this background agent addressable via SendMessage({to:name}).' },
        task: { type: 'string' },
        context: { type: 'string' },
        title: { type: 'string' },
        isolation: { type: 'string', enum: ['worktree'], description: 'Use "worktree" to run the background subagent in an isolated git worktree.' },
      },
      required: ['task'],
    },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'spend',
    approvalReasonFor(input) {
      return {
        what: '启动后台子代理任务',
        why: typeof input.task === 'string' ? input.task.slice(0, 120) : '模型请求启动后台任务',
        impact: '会继续调用模型直到后台任务完成或被取消。',
      }
    },
    async execute(input, ctx: ToolContext) {
      if (isForkQuerySource(ctx.querySource) || (ctx.messages && isInForkChild(ctx.messages))) {
        throw new Error('Fork worker 内部不能再次启动 start_background_agent_task。请直接使用当前可用工具完成任务。')
      }
      const { task, agent } = await startBackgroundAgentRun(opts, input, ctx)
      const name = typeof task.params?.name === 'string' ? ` name="${xmlAttr(task.params.name)}"` : ''
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${xmlAttr(task.params.agent_id)}"` : ''
      return `<background_task_started id="${task.id}" agent="${agent.name}"${name}${agentId} status="queued">\n${task.title}\n</background_task_started>`
    },
  }
}
