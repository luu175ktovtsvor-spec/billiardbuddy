import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runAgentLoop, type AgentLoopSnapshot } from '../harness/loop'
import { Transcript } from '../memory/transcript'
import type { Message } from '../types/message'
import type { AgentEvent, UsageUpdateEvent } from '../types/events'
import type { Model } from '../types/model'
import type { Tool, ToolContext } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'
import { stripAnsiControlSequences } from '../tools/outputSanitize'
import {
  clampNumber as clampStoredResultNumber,
  errorMessage,
  isInsideRealPath,
  readWindow,
  semanticBoolean,
} from '../tools/storedToolResultTool'
import { Sandbox } from '../sandbox/sandbox'
import { Workspace } from '../workspace/workspace'
import { createIsolatedAgentWorktree, type AgentWorktreeCleanupResult, type WorktreeSession } from '../tools/worktreeTools'
import { applySubagentStartHooks, mergeHookRegistries, type HookRegistry } from '../hooks/hooks'
import { textBlock } from '../types/message'
import type { AgentDefinition } from './agentLoader'
import { resolveAgentTools } from './agentLoader'
import { loadAgentMcpRuntime, type AgentMcpRuntimeOptions } from './agentMcp'
import { buildAgentMemoryPrompt, workspaceWithAgentMemory } from './agentMemory'
import { cloneContentReplacementState, type ContentReplacementState } from '../context/toolResultStorage'
import { createDenialTrackingState } from '../permissions/denialTracking'
import { buildForkRunContext, FORK_SUBAGENT_TYPE, isForkQuerySource, isForkSubagentEnabled, isInForkChild, type ForkRunContext } from './forkSubagent'

export interface AgentTaskHandoffInput {
  agent: string
  agentId: string
  task: string
  context?: string
  title: string
  name?: string
  isolation?: 'worktree'
  initialMessages?: Message[]
  contentReplacementState?: ContentReplacementState
  summarySnapshot?: AgentLoopSnapshot
  usageSnapshot?: UsageUpdateEvent
  handoffWorktreeSession?: WorktreeSession
}

export interface AgentTaskForegroundRegistration {
  task: { id: string; title: string; params?: Record<string, unknown> }
  backgroundSignal: Promise<void>
  cancelAutoBackground(): void
}

export interface AgentTaskInput {
  agent?: string
  name?: string
  task: string
  context?: string
  isolation?: 'worktree'
  run_in_background?: boolean | string
  runInBackground?: boolean | string
  fork_context?: boolean | string
  forkContext?: boolean | string
}

export interface AgentTaskToolOptions {
  agents: AgentDefinition[]
  model: Model
  baseTools: Tool[]
  baseSystemPrompt?: string
  maxTurns?: number
  sidechainRoot?: string
  hooks?: HookRegistry
  mcp?: AgentMcpRuntimeOptions
  env?: Record<string, string | undefined>
  startBackgroundAgent?: (input: { agent?: string; name?: string; task: string; context?: string; title?: string; isolation?: 'worktree' }, ctx: ToolContext, forkContext?: ForkRunContext) => Promise<{ task: { id: string; title: string; params?: Record<string, unknown> }; agent: AgentDefinition }>
  registerForegroundAgent?: (input: { agent: string; agentId: string; task: string; context?: string; title: string; name?: string }, ctx: ToolContext, forkContext?: ForkRunContext) => Promise<AgentTaskForegroundRegistration>
  handoffForegroundAgent?: (registration: AgentTaskForegroundRegistration, input: AgentTaskHandoffInput, ctx: ToolContext, forkContext?: ForkRunContext) => Promise<{ task: { id: string; title: string; params?: Record<string, unknown> }; agent: AgentDefinition }>
  unregisterForegroundAgent?: (taskId: string, ctx: ToolContext) => Promise<void> | void
}

interface AgentTaskSidechain {
  id: string
  transcript: Transcript
  toolResultStoreDir: string
}

interface AgentTaskSidechainMetadata {
  agentType: string
  agentFilePath?: string
  description?: string
  task: string
  context: string | null
  parentConversationId: string | null
  toolResultStoreDir: string
  worktreePath?: string
  createdAt: string
}

interface ListAgentTaskSidechainsInput {
  parent_conversation_id?: string
  parentConversationId?: string
  limit?: number | string
}

interface ReadAgentTaskSidechainInput {
  agent_id?: string
  agentId?: string
  after?: number | string
  limit?: number | string
}

interface ReadAgentTaskStoredResultInput {
  agent_id?: string
  agentId?: string
  path?: string
  offset?: number | string
  max_bytes?: number | string
  tail?: boolean | string
}

const DEFAULT_STORED_RESULT_MAX_BYTES = 120_000
const MAX_STORED_RESULT_BYTES = 500_000

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

async function buildAgentSystemPrompt(agent: AgentDefinition, workspaceRoot: string, baseSystemPrompt = ''): Promise<string> {
  const memoryPrompt = agent.memory
    ? await buildAgentMemoryPrompt(agent.name, agent.memory, workspaceRoot)
    : ''
  return [
    baseSystemPrompt,
    `<subagent name="${agent.name}">`,
    agent.prompt,
    '</subagent>',
    memoryPrompt,
    'You are running as an isolated subagent. Return only the useful result for the parent agent.',
  ].filter(Boolean).join('\n\n')
}

function buildTaskMessage(input: AgentTaskInput): string {
  const task = input.task.trim()
  const context = input.context?.trim()
  return context
    ? `${task}\n\n<context>\n${context}\n</context>`
    : task
}

function agentTaskMessage(agent: AgentDefinition, input: AgentTaskInput): string {
  const base = buildTaskMessage(input)
  return agent.initialPrompt?.trim()
    ? `${agent.initialPrompt.trim()}\n\n${base}`
    : base
}

function optionalBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
  return fallback
}

function hookContextMessage(event: string, contexts: string[]): Message | undefined {
  if (contexts.length === 0) return undefined
  return { role: 'user', content: [textBlock(`<hook_context event="${event}">\n${contexts.join('\n\n')}\n</hook_context>`)] }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80) || 'item'
}

function createAgentTaskSidechain(opts: AgentTaskToolOptions, agent: AgentDefinition, ctx: ToolContext): AgentTaskSidechain | undefined {
  if (!opts.sidechainRoot) return undefined
  const parent = safeSegment(ctx.conversationId ?? 'adhoc')
  const name = safeSegment(agent.name)
  const id = `agent_${parent}_${name}_${randomUUID().replaceAll('-', '_')}`
  return {
    id,
    transcript: new Transcript(opts.sidechainRoot, id),
    toolResultStoreDir: join(opts.sidechainRoot, 'tool-results', id),
  }
}

async function writeAgentTaskMetadata(opts: AgentTaskToolOptions, sidechain: AgentTaskSidechain, agent: AgentDefinition, input: AgentTaskInput, ctx: ToolContext, worktreePath?: string): Promise<void> {
  if (!opts.sidechainRoot) return
  const path = join(opts.sidechainRoot, 'transcripts', `${sidechain.id}.meta.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    agentType: agent.name,
    agentFilePath: agent.filePath,
    description: agent.description,
    task: input.task,
    context: input.context ?? null,
    parentConversationId: ctx.conversationId ?? null,
    toolResultStoreDir: sidechain.toolResultStoreDir,
    ...(worktreePath ? { worktreePath } : {}),
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf8')
}

function oneLine(value: unknown, max = 160): string {
  const text = typeof value === 'string'
    ? value
    : value === undefined ? '' : JSON.stringify(value)
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function summarizeArgs(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const args = input as Record<string, unknown>
  for (const key of ['path', 'file_path', 'query', 'pattern', 'command', 'name', 'url', 'task']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return oneLine(value, 80)
  }
  return oneLine(input, 80)
}

function subagentLine(agent: AgentDefinition, event: AgentEvent): string | null {
  if (event.type === 'thinking') return `子代理 ${agent.name} 思考:${oneLine(event.text)}`
  if (event.type === 'tool_call') {
    const hint = summarizeArgs(event.input)
    return `子代理 ${agent.name} 调用 ${event.tool}${hint ? `: ${hint}` : ''}`
  }
  if (event.type === 'tool_progress') {
    const text = oneLine(event.chunk, 120)
    return text ? `子代理 ${agent.name} 进度:${text}` : null
  }
  if (event.type === 'tool_result') return `子代理 ${agent.name} 完成 ${event.tool}`
  if (event.type === 'approval_request') return `子代理 ${agent.name} 等待确认 ${event.tool}`
  if (event.type === 'ask_question') return `子代理 ${agent.name} 需要补充:${oneLine(event.question)}`
  if (event.type === 'context_note') return `子代理 ${agent.name} 提醒:${oneLine(event.text)}`
  if (event.type === 'todo_update') return `子代理 ${agent.name} 更新任务清单`
  if (event.type === 'final') return `子代理 ${agent.name} 结论:${oneLine(event.text)}`
  return null
}

function emitSubagentProgress(ctx: ToolContext, agent: AgentDefinition, text: string): void {
  ctx.progressEmit?.({ tool: 'agent_task', stream: 'subagent', chunk: text.endsWith('\n') ? text : `${text}\n` })
}

function optionalIsolation(input: AgentTaskInput, agent: AgentDefinition): { isolation?: 'worktree' } {
  const isolation = input.isolation ?? agent.isolation
  return isolation ? { isolation } : {}
}

function sandboxForWorkspace(base: Sandbox | undefined, workspace: Workspace): Sandbox | undefined {
  return base?.isOsSandboxActive() ? new Sandbox({ workspace, enabled: true }) : base
}

function formatWorktreeResult(cleanup: AgentWorktreeCleanupResult | null): string {
  if (!cleanup) return ''
  if (!cleanup.kept) {
    return [
      '<agent_worktree status="removed_clean">',
      `changed_files: ${cleanup.changedFiles}`,
      `commits: ${cleanup.commits}`,
      '</agent_worktree>',
    ].join('\n')
  }
  return [
    `<agent_worktree status="kept" path="${xmlAttr(cleanup.worktreePath ?? '')}" branch="${xmlAttr(cleanup.worktreeBranch ?? '')}">`,
    `changed_files: ${cleanup.changedFiles}`,
    `commits: ${cleanup.commits}`,
    '</agent_worktree>',
  ].join('\n')
}

async function closeAgentIteratorForHandoff(iterator: AsyncIterator<AgentEvent>, timeoutMs = 1000): Promise<void> {
  const close = iterator.return?.(undefined).catch(() => undefined)
  if (!close) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    close,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs)
      const maybe = timer as { unref?: () => void }
      maybe.unref?.()
    }),
  ])
  if (timer) clearTimeout(timer)
}

export function createAgentTaskTool(opts: AgentTaskToolOptions): Tool<AgentTaskInput> {
  const forkGateEnabled = isForkSubagentEnabled(opts.env)
  const inputSchemaProperties = forkGateEnabled
    ? {
        task: { type: 'string' },
        context: { type: 'string' },
        isolation: { type: 'string', enum: ['worktree'], description: 'Use "worktree" to run the forked worker in an isolated git worktree.' },
      }
    : {
        agent: { type: 'string', description: 'Agent name. Required when more than one agent is available.' },
        name: { type: 'string', description: 'Optional instance name when run_in_background is true. Makes this background agent addressable via SendMessage({to:name}).' },
        task: { type: 'string' },
        context: { type: 'string' },
        isolation: { type: 'string', enum: ['worktree'], description: 'Use "worktree" to run the subagent in an isolated git worktree.' },
        run_in_background: { type: ['boolean', 'string'], description: 'Set true to launch this Agent task in the background and return a task id immediately.' },
        fork_context: { type: ['boolean', 'string'], description: 'Set true to run a forked worker that inherits the parent conversation, system prompt, and exact tool pool.' },
      }
  return {
    name: 'agent_task',
    description: forkGateEnabled
      ? 'Fork a worker that inherits the parent coding-agent conversation and runs in the background.'
      : `Run a focused subagent and return only its final result. Available agents:\n${agentList(opts.agents)}`,
    inputSchema: {
      type: 'object',
      properties: inputSchemaProperties,
      required: ['task'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      if (!input || typeof input.task !== 'string' || !input.task.trim()) {
        throw new Error('agent_task 需要 string 参数 task')
      }
      if (isForkQuerySource(ctx.querySource) || (ctx.messages && isInForkChild(ctx.messages))) {
        throw new Error('Fork worker 内部不能再次启动 agent_task。请直接使用当前可用工具完成任务。')
      }
      const wantsForkContext = optionalBoolean(input.fork_context ?? input.forkContext) || (forkGateEnabled && !input.agent)
      const agent = wantsForkContext
        ? {
            name: FORK_SUBAGENT_TYPE,
            description: 'Forked worker inheriting the parent coding-agent context.',
            prompt: '',
            filePath: 'built-in:fork',
            permissionMode: ctx.permissionMode,
            maxTurns: opts.maxTurns,
          } satisfies AgentDefinition
        : pickAgent(opts.agents, input.agent)
      if (!agent) {
        throw new Error(`agent_task 需要指定 agent;可用 agent:\n${agentList(opts.agents)}`)
      }
      const forkRunContext = wantsForkContext ? buildForkRunContext(ctx, buildTaskMessage(input)) : undefined
      const wantsBackground = wantsForkContext && forkGateEnabled
        ? true
        : optionalBoolean(input.run_in_background ?? input.runInBackground) || agent.background === true
      if (wantsBackground) {
        if (!opts.startBackgroundAgent) {
          throw new Error('agent_task run_in_background 需要后台任务运行器')
        }
        const { task } = await opts.startBackgroundAgent({
          agent: agent.name,
          ...(input.name ? { name: input.name } : {}),
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          title: `${agent.name}: ${input.task.trim().slice(0, 80)}`,
          isolation: input.isolation ?? agent.isolation,
        }, ctx, forkRunContext)
        const name = typeof task.params?.name === 'string' ? ` name="${xmlAttr(task.params.name)}"` : ''
        const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${xmlAttr(task.params.agent_id)}"` : ''
        return `<background_task_started id="${xmlAttr(task.id)}" agent="${xmlAttr(agent.name)}"${name}${agentId} status="queued">\n${xmlText(task.title)}\n</background_task_started>`
      }

      const sidechain = createAgentTaskSidechain(opts, agent, ctx)
      const agentId = sidechain?.id ?? (ctx.conversationId ? `${ctx.conversationId}_${agent.name}` : `agent_${safeSegment(agent.name)}_${randomUUID().replaceAll('-', '_')}`)
      let finalText = ''
      let cleanup: AgentWorktreeCleanupResult | null = null
      let foregroundRegistration: AgentTaskForegroundRegistration | undefined
      let wasBackgrounded = false
      let agentWorktree: Awaited<ReturnType<typeof createIsolatedAgentWorktree>> | null = null
      let agentMcp: Awaited<ReturnType<typeof loadAgentMcpRuntime>> | undefined
      try {
        const foregroundInput = {
          agent: agent.name,
          agentId,
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          ...(input.name ? { name: input.name } : {}),
          title: `${agent.name}: ${input.task.trim().slice(0, 80)}`,
        }
        foregroundRegistration = opts.registerForegroundAgent
          ? await opts.registerForegroundAgent({
            ...foregroundInput,
          }, ctx, forkRunContext)
          : undefined
        const effectiveIsolation = input.isolation ?? agent.isolation
        agentWorktree = effectiveIsolation === 'worktree'
          ? await createIsolatedAgentWorktree(ctx.workspace.root, agentId, ctx.conversationId)
          : null
        const workspaceBase = agentWorktree ? new Workspace(agentWorktree.session.worktreePath) : ctx.workspace
        const workspace = workspaceWithAgentMemory(workspaceBase, agent.name, agent.memory)
        const sandbox = sandboxForWorkspace(ctx.sandbox, workspace)
        if (sidechain) await writeAgentTaskMetadata(opts, sidechain, agent, input, ctx, agentWorktree?.session.worktreePath)
        const baseAgentTools = wantsForkContext
          ? forkRunContext?.tools.length ? forkRunContext.tools : opts.baseTools
          : resolveAgentTools(agent, opts.baseTools).filter(tool => tool.name !== 'agent_task')
        const hooks = mergeHookRegistries(opts.hooks, agent.hooks)
        const inheritedContentReplacementState = ctx.contentReplacementState
          ? cloneContentReplacementState(ctx.contentReplacementState)
          : undefined
        agentMcp = await loadAgentMcpRuntime({
          agent,
          baseTools: baseAgentTools,
          workspaceRoot: workspace.root,
          signal: ctx.signal,
          mcpConfigPath: opts.mcp?.mcpConfigPath,
          loadOptions: opts.mcp?.loadOptions,
        })
        const registry = new ToolRegistry(agentMcp.tools)
        let handoffSnapshot: AgentLoopSnapshot | undefined
        let handoffUsageSnapshot: UsageUpdateEvent | undefined
        emitSubagentProgress(ctx, agent, `子代理 ${agent.name} 开始:${oneLine(input.task, 120)}`)
        if (agentWorktree) emitSubagentProgress(ctx, agent, `子代理 ${agent.name} 使用隔离 worktree:${agentWorktree.session.worktreePath}`)
        for (const warning of agentMcp.warnings) emitSubagentProgress(ctx, agent, warning)
        const subagentStart = await applySubagentStartHooks(hooks, agentId, agent.name, {
          ...ctx,
          workspace,
          sandbox,
          conversationId: agentId,
          toolResultStoreDir: sidechain?.toolResultStoreDir ?? ctx.toolResultStoreDir,
          contentReplacementState: inheritedContentReplacementState,
        })
        for (const extra of subagentStart.additionalContext) emitSubagentProgress(ctx, agent, `子代理 ${agent.name} hook:${oneLine(extra, 160)}`)
        const agentIterator = runAgentLoop({
          model: opts.model,
          registry,
          workspace,
          systemPrompt: forkRunContext?.systemPrompt ?? await buildAgentSystemPrompt(agent, workspace.root, opts.baseSystemPrompt),
          userMessage: agentTaskMessage(agent, input),
          initialMessages: [
            ...(forkRunContext?.initialMessages ?? []),
            ...[hookContextMessage('SubagentStart', subagentStart.additionalContext)].filter((message): message is Message => !!message),
          ],
          skipUserMessage: !!forkRunContext,
          maxTurns: agent.maxTurns ?? opts.maxTurns ?? 8,
          signal: ctx.signal,
          sandbox,
          permissionMode: agent.permissionMode ?? ctx.permissionMode,
          localDenialTracking: createDenialTrackingState(),
          conversationId: agentId,
          transcript: sidechain?.transcript,
          toolResultStoreDir: sidechain?.toolResultStoreDir ?? ctx.toolResultStoreDir,
          hooks,
          subagent: { agentId, agentType: agent.name },
          querySource: forkRunContext?.querySource,
          contentReplacementState: inheritedContentReplacementState,
          onSummarySnapshot: snapshot => {
            handoffSnapshot = snapshot
          },
        })[Symbol.asyncIterator]()
        const backgroundPromise = foregroundRegistration && opts.handoffForegroundAgent
          ? foregroundRegistration.backgroundSignal.then(() => ({ type: 'background' as const }))
          : undefined
        while (true) {
          const nextEvent = agentIterator.next()
          const raceResult = backgroundPromise
            ? await Promise.race([
              nextEvent.then(result => ({ type: 'event' as const, result })),
              backgroundPromise,
            ])
            : { type: 'event' as const, result: await nextEvent }
          if (raceResult.type === 'background') {
            if (!foregroundRegistration || !opts.handoffForegroundAgent) continue
            wasBackgrounded = true
            await closeAgentIteratorForHandoff(agentIterator)
            const { task } = await opts.handoffForegroundAgent(foregroundRegistration, {
              ...foregroundInput,
              ...optionalIsolation(input, agent),
              ...(handoffSnapshot?.messages.length ? { initialMessages: handoffSnapshot.messages } : {}),
              ...(handoffSnapshot?.contentReplacementState ? { contentReplacementState: handoffSnapshot.contentReplacementState } : {}),
              ...(handoffSnapshot ? { summarySnapshot: handoffSnapshot } : {}),
              ...(handoffUsageSnapshot ? { usageSnapshot: handoffUsageSnapshot } : {}),
              ...(agentWorktree ? { handoffWorktreeSession: agentWorktree.session } : {}),
            }, ctx, forkRunContext)
            const name = typeof task.params?.name === 'string' ? ` name="${xmlAttr(task.params.name)}"` : ''
            const backgroundAgentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${xmlAttr(task.params.agent_id)}"` : ''
            return `<background_task_started id="${xmlAttr(task.id)}" agent="${xmlAttr(agent.name)}"${name}${backgroundAgentId} status="running">\n${xmlText(task.title)}\n</background_task_started>`
          }
          if (raceResult.result.done) break
          const ev = raceResult.result.value
          if (ev.type === 'usage_update') handoffUsageSnapshot = ev
          const line = subagentLine(agent, ev)
          if (line) emitSubagentProgress(ctx, agent, line)
          if (ev.type === 'final') finalText = ev.text
        }
      } finally {
        try {
          foregroundRegistration?.cancelAutoBackground()
          if (foregroundRegistration && !wasBackgrounded) await opts.unregisterForegroundAgent?.(foregroundRegistration.task.id, ctx)
        } catch (error) {
          emitSubagentProgress(ctx, agent, `子代理 ${agent.name} 前台登记清理失败:${oneLine(errorMessage(error))}`)
        }
        await agentMcp?.close()
        const worktree = agentWorktree
        cleanup = worktree && !wasBackgrounded ? await worktree.cleanupIfClean().catch(error => ({
          kept: true,
          worktreePath: worktree.session.worktreePath,
          worktreeBranch: worktree.session.worktreeBranch,
          changedFiles: -1,
          commits: -1,
          cleanupError: errorMessage(error),
        } as AgentWorktreeCleanupResult)) : null
      }
      const idAttr = sidechain ? ` agent_id="${xmlAttr(sidechain.id)}"` : ''
      const worktreeResult = formatWorktreeResult(cleanup)
      return `<agent_task agent="${xmlAttr(agent.name)}"${idAttr}>\n${finalText}${worktreeResult ? `\n${worktreeResult}` : ''}\n</agent_task>`
    },
  }
}

export function createAgentTaskSidechainTools(sidechainRoot: string): Tool[] {
  return [
    {
      name: 'list_agent_task_sidechains',
      description: 'List recent synchronous agent_task sidechain transcripts. Input: { parent_conversation_id?, limit? }.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_conversation_id: { type: 'string', description: 'Optional parent conversation id filter.' },
          limit: { type: ['number', 'string'], description: 'Maximum sidechains to list, default 20, max 100.' },
        },
      },
      isReadOnly: true,
      async execute(input) {
        const wantedParent = stringInput(input?.parent_conversation_id ?? input?.parentConversationId)
        const limit = clampNumber(input?.limit, 20, 100)
        const entries = await listSidechainMetadata(sidechainRoot)
        const filtered = entries
          .filter(entry => !wantedParent || entry.metadata.parentConversationId === wantedParent)
          .sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt))
          .slice(0, limit)
        return [
          `<agent_task_sidechains count="${filtered.length}" total="${entries.length}">`,
          ...filtered.map(({ id, metadata }) => [
            `<agent_task_sidechain id="${xmlAttr(id)}" agent="${xmlAttr(metadata.agentType)}" parent_conversation_id="${xmlAttr(metadata.parentConversationId ?? '')}" created_at="${xmlAttr(metadata.createdAt)}">`,
            `<task>${xmlText(metadata.task)}</task>`,
            metadata.description ? `<description>${xmlText(metadata.description)}</description>` : '',
            '</agent_task_sidechain>',
          ].filter(Boolean).join('\n')),
          '</agent_task_sidechains>',
        ].join('\n')
      },
    } satisfies Tool<ListAgentTaskSidechainsInput>,
    {
      name: 'read_agent_task_sidechain',
      description: 'Read a paged synchronous agent_task sidechain transcript by agent_id from an agent_task result. Input: { agent_id, after?, limit? }.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'agent_id attribute returned by <agent_task>.' },
          after: { type: ['number', 'string'], description: 'Message sequence cursor, default 0.' },
          limit: { type: ['number', 'string'], description: 'Maximum messages, default 50, max 200.' },
        },
        required: ['agent_id'],
      },
      isReadOnly: true,
      fatalReasonFor(input) {
        const id = stringInput(input?.agent_id ?? input?.agentId)
        if (!id) return 'read_agent_task_sidechain 需要 agent_id'
        if (!isSafeSidechainId(id)) return 'agent_id 格式非法'
        return null
      },
      async execute(input) {
        const id = stringInput(input?.agent_id ?? input?.agentId)
        if (!id || !isSafeSidechainId(id)) throw new Error('agent_id 格式非法')
        const transcript = new Transcript(sidechainRoot, id)
        const [metadata, page, replacements] = await Promise.all([
          readSidechainMetadata(sidechainRoot, id),
          transcript.loadPage({ after: clampNumber(input?.after, 0, Number.MAX_SAFE_INTEGER), limit: clampNumber(input?.limit, 50, 200) }),
          transcript.loadContentReplacementRecords(),
        ])
        if (!metadata && page.messages.length === 0) {
          return `<agent_task_sidechain id="${xmlAttr(id)}" status="missing" />`
        }
        return [
          `<agent_task_sidechain id="${xmlAttr(id)}" status="ok" agent="${xmlAttr(metadata?.agentType ?? '')}" parent_conversation_id="${xmlAttr(metadata?.parentConversationId ?? '')}" created_at="${xmlAttr(metadata?.createdAt ?? '')}" next_seq="${page.nextSeq}" has_more="${page.hasMore ? 'true' : 'false'}" content_replacements="${replacements.length}">`,
          metadata ? `<task>${xmlText(metadata.task)}</task>` : '',
          '<messages>',
          ...page.messages.map(record => formatSidechainMessage(record.seq, record.message)),
          '</messages>',
          '</agent_task_sidechain>',
        ].filter(Boolean).join('\n')
      },
    } satisfies Tool<ReadAgentTaskSidechainInput>,
    {
      name: 'read_agent_task_stored_result',
      description: 'Read a bounded window from an oversized <stored_tool_result> emitted inside a synchronous agent_task sidechain. Input: { agent_id, path, offset?, max_bytes?, tail? }. Only files inside that agent_id tool-result store are allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'agent_id attribute returned by <agent_task>.' },
          path: { type: 'string', description: 'Path from the sidechain <stored_tool_result path="..."> attribute, or a filename inside that sidechain tool-result store.' },
          offset: { type: ['number', 'string'], description: 'Byte offset to start reading from. Ignored when tail is true.' },
          max_bytes: { type: ['number', 'string'], description: `Maximum bytes to read, default ${DEFAULT_STORED_RESULT_MAX_BYTES}, max ${MAX_STORED_RESULT_BYTES}.` },
          tail: { type: ['boolean', 'string'], description: 'Set true to read the tail window instead of from offset.' },
        },
        required: ['agent_id', 'path'],
      },
      isReadOnly: true,
      fatalReasonFor(input) {
        const id = stringInput(input?.agent_id ?? input?.agentId)
        if (!id) return 'read_agent_task_stored_result 需要 agent_id'
        if (!isSafeSidechainId(id)) return 'agent_id 格式非法'
        if (!input?.path || typeof input.path !== 'string' || !input.path.trim()) return 'read_agent_task_stored_result 需要 path'
        return null
      },
      async execute(input) {
        const id = stringInput(input?.agent_id ?? input?.agentId)
        if (!id || !isSafeSidechainId(id)) throw new Error('agent_id 格式非法')
        if (!input?.path || typeof input.path !== 'string' || !input.path.trim()) throw new Error('read_agent_task_stored_result 需要 path')

        const base = await sidechainToolResultStoreDir(sidechainRoot, id)
        if (!base) {
          return `<stored_tool_result_read status="missing_store_dir" agent_id="${xmlAttr(id)}">\n未找到该子代理的可回读大工具结果目录。\n</stored_tool_result_read>`
        }

        const requested = input.path.trim()
        const target = isAbsolute(requested) ? resolve(requested) : resolve(base, requested)
        const allowed = await isInsideRealPath(base, target)
        if (!allowed) {
          return `<stored_tool_result_read status="rejected" agent_id="${xmlAttr(id)}" path="${xmlAttr(requested)}">\n只能读取该子代理工具结果目录里的文件。\n</stored_tool_result_read>`
        }

        let info: Awaited<ReturnType<typeof stat>>
        try {
          info = await stat(target)
        } catch (error) {
          return `<stored_tool_result_read status="missing" agent_id="${xmlAttr(id)}" path="${xmlAttr(requested)}">\n${xmlText(errorMessage(error))}\n</stored_tool_result_read>`
        }
        if (!info.isFile()) {
          return `<stored_tool_result_read status="not_file" agent_id="${xmlAttr(id)}" path="${xmlAttr(requested)}" />`
        }

        const maxBytes = clampStoredResultNumber(input.max_bytes, DEFAULT_STORED_RESULT_MAX_BYTES, MAX_STORED_RESULT_BYTES)
        const size = info.size
        const offset = semanticBoolean(input.tail)
          ? Math.max(0, size - maxBytes)
          : Math.min(size, clampStoredResultNumber(input.offset, 0, Number.MAX_SAFE_INTEGER))
        const bytesToRead = Math.min(maxBytes, Math.max(0, size - offset))
        const body = bytesToRead > 0 ? await readWindow(target, offset, bytesToRead) : Buffer.alloc(0)
        const text = stripAnsiControlSequences(body.toString('utf8'))
        return [
          `<stored_tool_result_read status="completed" agent_id="${xmlAttr(id)}" path="${xmlAttr(requested)}" size="${size}" offset="${offset}" bytes="${body.length}" limit="${maxBytes}" truncated_top="${offset > 0 ? 'true' : 'false'}" truncated_bottom="${offset + body.length < size ? 'true' : 'false'}">`,
          xmlText(text),
          '</stored_tool_result_read>',
        ].join('\n')
      },
    } satisfies Tool<ReadAgentTaskStoredResultInput>,
  ]
}

async function listSidechainMetadata(sidechainRoot: string): Promise<Array<{ id: string; metadata: AgentTaskSidechainMetadata }>> {
  const dir = join(sidechainRoot, 'transcripts')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: Array<{ id: string; metadata: AgentTaskSidechainMetadata }> = []
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue
    const id = name.slice(0, -'.meta.json'.length)
    const metadata = await readSidechainMetadata(sidechainRoot, id)
    if (metadata) out.push({ id, metadata })
  }
  return out
}

async function readSidechainMetadata(sidechainRoot: string, id: string): Promise<AgentTaskSidechainMetadata | null> {
  if (!isSafeSidechainId(id)) return null
  try {
    const parsed = JSON.parse(await readFile(join(sidechainRoot, 'transcripts', `${id}.meta.json`), 'utf8')) as Partial<AgentTaskSidechainMetadata>
    if (!parsed || typeof parsed.agentType !== 'string' || typeof parsed.task !== 'string') return null
    return {
      agentType: parsed.agentType,
      agentFilePath: typeof parsed.agentFilePath === 'string' ? parsed.agentFilePath : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      task: parsed.task,
      context: typeof parsed.context === 'string' ? parsed.context : null,
      parentConversationId: typeof parsed.parentConversationId === 'string' ? parsed.parentConversationId : null,
      toolResultStoreDir: typeof parsed.toolResultStoreDir === 'string' ? parsed.toolResultStoreDir : '',
      worktreePath: typeof parsed.worktreePath === 'string' ? parsed.worktreePath : undefined,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    }
  } catch {
    return null
  }
}

async function sidechainToolResultStoreDir(sidechainRoot: string, id: string): Promise<string | null> {
  const expected = resolve(sidechainRoot, 'tool-results', id)
  const metadata = await readSidechainMetadata(sidechainRoot, id)
  const candidate = metadata?.toolResultStoreDir ? resolve(metadata.toolResultStoreDir) : expected
  const base = await isInsideRealPath(expected, candidate) ? candidate : expected
  try {
    const info = await stat(base)
    return info.isDirectory() ? base : null
  } catch {
    return null
  }
}

function formatSidechainMessage(seq: number, message: Message): string {
  return [
    `<message seq="${seq}" role="${message.role}">`,
    ...message.content.map(block => {
      if (block.type === 'text') return `<text>${xmlText(block.text)}</text>`
      if (block.type === 'tool_use') return `<tool_use id="${xmlAttr(block.id)}" name="${xmlAttr(block.name)}">${xmlText(JSON.stringify(block.input))}</tool_use>`
      if (block.type === 'tool_result') return `<tool_result tool_use_id="${xmlAttr(block.tool_use_id)}"${block.is_error ? ' is_error="true"' : ''}>${xmlText(block.content)}</tool_result>`
      if (block.type === 'thinking') return `<thinking>${xmlText(block.thinking)}</thinking>`
      return ''
    }).filter(Boolean),
    '</message>',
  ].join('\n')
}

function isSafeSidechainId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function stringInput(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.max(0, Math.min(max, Math.floor(n)))
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
