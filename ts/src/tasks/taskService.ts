import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transcript } from '../memory/transcript'
import type { AgentEvent } from '../types/events'

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const DEFAULT_EVENT_LIMIT = 200
const MAX_EVENT_LIMIT = 1000

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type TaskStreamEvent = AgentEvent | { type: 'started'; text: string } | { type: 'done' }

export interface TaskEventRecord {
  seq: number
  ts: string
  event: TaskStreamEvent
}

export interface TaskMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  status: TaskStatus
  kind?: string
  conversationId?: string
  workspaceRoot?: string
  progress?: number
  stage?: string
  summary?: string
  lastEventSeq?: number
  params?: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface BackgroundAgentMetadata {
  taskId: string
  agentId?: string
  agent: string
  agentType?: string
  name?: string
  description?: string
  conversationId?: string
  workspaceRoot?: string
  worktreePath?: string
  toolResultStoreDir?: string
  task?: string
  context?: string
  createdAt?: string
  updatedAt?: string
}

export interface BackgroundAgentTargetResolution {
  task: TaskMeta | null
  ambiguous?: boolean
  matches?: TaskMeta[]
  reason?: string
}

export interface TaskRunnerContext {
  signal: AbortSignal
  emit(event: TaskStreamEvent): Promise<TaskEventRecord>
  progress(progress: number, stage?: string): Promise<void>
}

export interface TaskServiceOptions {
  onSettled?: (task: TaskMeta) => Promise<void> | void
}

export interface ForegroundAgentRegistrationInput {
  taskId?: string
  agentId?: string
  agent: string
  title: string
  conversationId?: string
  workspaceRoot?: string
  task?: string
  context?: string
  name?: string
  params?: Record<string, unknown>
}

export interface ForegroundAgentRegistration {
  task: TaskMeta
  backgroundSignal: Promise<void>
  requestBackground(): Promise<TaskMeta>
  cancelAutoBackground(): void
}

export interface TaskListOptions {
  conversationId?: string
  status?: TaskStatus
  limit?: number
  collapseResumedBackgroundAgents?: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
}

function isTaskMeta(value: unknown): value is TaskMeta {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    TASK_ID_RE.test(value.id) &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isTaskStatus(value.status) &&
    (value.kind === undefined || typeof value.kind === 'string') &&
    (value.conversationId === undefined || typeof value.conversationId === 'string') &&
    (value.workspaceRoot === undefined || typeof value.workspaceRoot === 'string') &&
    (value.progress === undefined || typeof value.progress === 'number') &&
    (value.stage === undefined || typeof value.stage === 'string') &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.lastEventSeq === undefined || typeof value.lastEventSeq === 'number') &&
    (value.params === undefined || isRecord(value.params)) &&
    (value.error === undefined || typeof value.error === 'string')
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(record, key)
  return value || undefined
}

function backgroundAgentMetadataFrom(value: unknown, fallbackTaskId: string): BackgroundAgentMetadata | null {
  if (!isRecord(value)) return null
  const taskId = stringField(value, 'taskId') || fallbackTaskId
  if (taskId !== fallbackTaskId || !TASK_ID_RE.test(taskId)) return null
  const agent = stringField(value, 'agent') || stringField(value, 'agentType')
  if (!agent) return null
  return {
    taskId,
    agentId: optionalStringField(value, 'agentId') || optionalStringField(value, 'agent_id'),
    agent,
    agentType: optionalStringField(value, 'agentType'),
    name: optionalStringField(value, 'name'),
    description: optionalStringField(value, 'description'),
    conversationId: optionalStringField(value, 'conversationId'),
    workspaceRoot: optionalStringField(value, 'workspaceRoot'),
    worktreePath: optionalStringField(value, 'worktreePath'),
    toolResultStoreDir: optionalStringField(value, 'toolResultStoreDir'),
    task: optionalStringField(value, 'task'),
    context: optionalStringField(value, 'context'),
    createdAt: optionalStringField(value, 'createdAt'),
    updatedAt: optionalStringField(value, 'updatedAt'),
  }
}

function isTaskEventRecord(value: unknown): value is TaskEventRecord {
  if (!isRecord(value)) return false
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return false
  if (typeof value.ts !== 'string') return false
  return isRecord(value.event) && typeof value.event.type === 'string'
}

function stringParam(params: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!params) return ''
  for (const key of keys) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function backgroundAgentCustomName(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return metadata?.name?.trim() || stringParam(task.params, 'name', 'agentName', 'agent_name')
}

function backgroundAgentStableId(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return metadata?.agentId?.trim() || stringParam(task.params, 'agent_id', 'agentId') || ''
}

function backgroundAgentType(task: TaskMeta, metadata?: BackgroundAgentMetadata | null): string {
  return metadata?.agent?.trim() || metadata?.agentType?.trim() || stringParam(task.params, 'agent')
}

function backgroundAgentResumeSource(task: TaskMeta): string {
  return stringParam(task.params, 'resumed_from')
}

function isBackgroundAgentDescendantOf(task: TaskMeta, ancestorId: string, allTasks: Map<string, TaskMeta>): boolean {
  const seen = new Set<string>()
  let current = backgroundAgentResumeSource(task)
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    const parent = allTasks.get(current)
    current = parent ? backgroundAgentResumeSource(parent) : ''
  }
  return false
}

function collapseResumedBackgroundAgentTasks(tasks: TaskMeta[]): TaskMeta[] {
  const allTasks = new Map(tasks.map(task => [task.id, task]))
  return tasks.filter(task => {
    if (task.kind !== 'background_agent') return true
    for (const candidate of tasks) {
      if (candidate.id === task.id || candidate.kind !== 'background_agent') continue
      if (isBackgroundAgentDescendantOf(candidate, task.id, allTasks)) return false
    }
    return true
  })
}

function taskFromBackgroundAgentMetadata(metadata: BackgroundAgentMetadata): TaskMeta {
  const updatedAt = metadata.updatedAt || metadata.createdAt || new Date(0).toISOString()
  const createdAt = metadata.createdAt || updatedAt
  const displayName = metadata.name || metadata.agent
  const title = metadata.description || `${displayName}: ${metadata.task?.slice(0, 80) || 'recovered background agent'}`
  return {
    id: metadata.taskId,
    title,
    createdAt,
    updatedAt,
    status: 'completed',
    kind: 'background_agent',
    conversationId: metadata.conversationId,
    workspaceRoot: metadata.workspaceRoot,
    progress: 100,
    params: {
      ...(metadata.agentId ? { agent_id: metadata.agentId } : {}),
      agent: metadata.agent,
      ...(metadata.name ? { name: metadata.name } : {}),
      ...(metadata.task ? { task: metadata.task } : {}),
      ...(metadata.context ? { context: metadata.context } : {}),
      ...(metadata.toolResultStoreDir ? { tool_result_store_dir: metadata.toolResultStoreDir } : {}),
      recovered_from_metadata: true,
    },
    lastEventSeq: 0,
  }
}

function validateTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new Error('非法 task id')
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_EVENT_LIMIT
  return Math.min(Math.floor(value), MAX_EVENT_LIMIT)
}

function clampProgress(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.floor(value)))
}

function maybeUnref(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

export class TaskService {
  private readonly indexPath: string
  private readonly controllers = new Map<string, AbortController>()
  private readonly liveSteerInboxes = new Map<string, string[]>()
  private readonly foregroundAgents = new Map<string, { resolve: () => void; autoTimer?: ReturnType<typeof setTimeout> }>()
  private indexQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly rootDir: string, private readonly options: TaskServiceOptions = {}) {
    this.indexPath = join(rootDir, 'tasks.json')
  }

  async list(opts: TaskListOptions = {}): Promise<TaskMeta[]> {
    const limit = clampLimit(opts.limit)
    const scopedTasks = [...(await this.readIndex()).values()]
      .filter(task => !opts.conversationId || task.conversationId === opts.conversationId)
    const tasks = (opts.collapseResumedBackgroundAgents ? collapseResumedBackgroundAgentTasks(scopedTasks) : scopedTasks)
      .filter(task => !opts.status || task.status === opts.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return tasks.slice(0, limit)
  }

  async get(id: string): Promise<TaskMeta | null> {
    validateTaskId(id)
    return (await this.readIndex()).get(id) ?? null
  }

  async findBackgroundAgent(target: string, opts: { conversationId?: string; statuses?: TaskStatus[] } = {}): Promise<TaskMeta | null> {
    return (await this.resolveBackgroundAgentTarget(target, opts)).task
  }

  async resolveBackgroundAgentTarget(target: string, opts: { conversationId?: string; statuses?: TaskStatus[] } = {}): Promise<BackgroundAgentTargetResolution> {
    const wanted = target.trim()
    if (!wanted) return { task: null }
    const statuses = new Set(opts.statuses ?? ['queued', 'running', 'completed', 'failed', 'cancelled'])
    const index = await this.readIndex()
    const indexedBackgroundTasks = [...index.values()]
      .filter(task => !opts.conversationId || task.conversationId === opts.conversationId)
      .filter(task => task.kind === 'background_agent')
    const allEnriched = await Promise.all(indexedBackgroundTasks.map(async task => ({
      task,
      metadata: await this.readBackgroundAgentMetadata(task.id),
    })))
    for (const metadata of await this.listBackgroundAgentMetadata()) {
      if (index.has(metadata.taskId)) continue
      if (opts.conversationId && metadata.conversationId !== opts.conversationId) continue
      allEnriched.push({ task: taskFromBackgroundAgentMetadata(metadata), metadata })
    }
    const allTasks = new Map(allEnriched.map(item => [item.task.id, item.task]))
    const enriched = allEnriched.filter(item => statuses.has(item.task.status))
    enriched.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt))
    const latestLeafTask = (items: typeof enriched): TaskMeta | null => {
      if (items.length === 0) return null
      const leaves = items.filter(item =>
        !items.some(candidate => candidate.task.id !== item.task.id && isBackgroundAgentDescendantOf(candidate.task, item.task.id, allTasks)),
      )
      const candidates = leaves.length > 0 ? leaves : items
      candidates.sort((a, b) =>
        b.task.updatedAt.localeCompare(a.task.updatedAt) ||
        b.task.createdAt.localeCompare(a.task.createdAt) ||
        b.task.id.localeCompare(a.task.id),
      )
      return candidates[0]?.task ?? null
    }
    const byLatestDescendant = latestLeafTask(enriched.filter(item => item.task.id !== wanted && isBackgroundAgentDescendantOf(item.task, wanted, allTasks)))
    if (byLatestDescendant) return { task: byLatestDescendant }
    const byId = enriched.find(item => item.task.id === wanted)?.task
    if (byId) return { task: byId }
    const byStableAgentId = latestLeafTask(enriched.filter(item => backgroundAgentStableId(item.task, item.metadata) === wanted))
    if (byStableAgentId) return { task: byStableAgentId }
    const byCustomName = latestLeafTask(enriched.filter(item => backgroundAgentCustomName(item.task, item.metadata) === wanted))
    if (byCustomName) return { task: byCustomName }
    const byAgentType = enriched
      .filter(item => backgroundAgentType(item.task, item.metadata) === wanted)
      .map(item => item.task)
    if (byAgentType.length === 1) return { task: byAgentType[0]! }
    if (byAgentType.length > 1) {
      return {
        task: null,
        ambiguous: true,
        matches: byAgentType,
        reason: `Multiple background agents match "${wanted}". Use the task id or the custom name passed to start_background_agent_task({name}).`,
      }
    }
    return { task: null }
  }

  async findRunningBackgroundAgent(target: string, opts: { conversationId?: string } = {}): Promise<TaskMeta | null> {
    return this.findBackgroundAgent(target, { ...opts, statuses: ['running'] })
  }

  async create(input: { id?: string; title: string; kind?: string; conversationId?: string; workspaceRoot?: string; params?: Record<string, unknown> }): Promise<TaskMeta> {
    const id = input.id ?? crypto.randomUUID()
    validateTaskId(id)
    const timestamp = nowIso()
    const meta: TaskMeta = {
      id,
      title: input.title.trim() || '后台任务',
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'queued',
      kind: input.kind,
      conversationId: input.conversationId,
      workspaceRoot: input.workspaceRoot,
      progress: 0,
      params: input.params,
      lastEventSeq: 0,
    }
    await this.mutateIndex(index => {
      index.set(id, meta)
    })
    return meta
  }

  async registerForegroundAgent(input: ForegroundAgentRegistrationInput, opts: { autoBackgroundMs?: number } = {}): Promise<ForegroundAgentRegistration> {
    const params = {
      ...input.params,
      agent: input.agent,
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...(input.context ? { context: input.context } : {}),
      foreground: true,
    }
    const task = await this.create({
      id: input.taskId,
      title: input.title,
      kind: 'background_agent',
      conversationId: input.conversationId,
      workspaceRoot: input.workspaceRoot,
      params,
    })
    let resolveSignal!: () => void
    const backgroundSignal = new Promise<void>(resolve => { resolveSignal = resolve })
    const existing = this.foregroundAgents.get(task.id)
    if (existing?.autoTimer) clearTimeout(existing.autoTimer)
    const record = { resolve: resolveSignal, autoTimer: undefined as ReturnType<typeof setTimeout> | undefined }
    this.foregroundAgents.set(task.id, record)
    if (opts.autoBackgroundMs && Number.isFinite(opts.autoBackgroundMs) && opts.autoBackgroundMs > 0) {
      record.autoTimer = setTimeout(() => {
        void this.requestForegroundAgentBackground(task.id)
      }, Math.floor(opts.autoBackgroundMs))
      maybeUnref(record.autoTimer)
    }
    return {
      task,
      backgroundSignal,
      requestBackground: () => this.requestForegroundAgentBackground(task.id),
      cancelAutoBackground: () => {
        const current = this.foregroundAgents.get(task.id)
        if (current?.autoTimer) {
          clearTimeout(current.autoTimer)
          current.autoTimer = undefined
        }
      },
    }
  }

  async requestForegroundAgentBackground(id: string): Promise<TaskMeta> {
    validateTaskId(id)
    const record = this.foregroundAgents.get(id)
    if (!record) throw new Error(`foreground agent ${id} is not registered`)
    if (record.autoTimer) {
      clearTimeout(record.autoTimer)
      record.autoTimer = undefined
    }
    const task = await this.touch(id, {
      status: 'running',
      params: { ...(await this.get(id))?.params, foreground: false, is_backgrounded: true },
      stage: '已切换到后台运行',
    })
    await this.appendEvent(id, { type: 'context_note', text: '前台 agent 已切换到后台运行' }).catch(() => undefined)
    this.foregroundAgents.delete(id)
    record.resolve()
    return task
  }

  async unregisterForegroundAgent(id: string): Promise<void> {
    validateTaskId(id)
    const record = this.foregroundAgents.get(id)
    if (!record) return
    if (record.autoTimer) clearTimeout(record.autoTimer)
    this.foregroundAgents.delete(id)
    const current = await this.get(id)
    if (current?.params?.foreground === true && current.status === 'queued') {
      await this.touch(id, { status: 'completed', progress: 100, params: { ...current.params, foreground: false } }).catch(() => undefined)
    }
  }

  async touch(id: string, patch: Partial<Pick<TaskMeta, 'title' | 'status' | 'kind' | 'conversationId' | 'workspaceRoot' | 'progress' | 'stage' | 'summary' | 'lastEventSeq' | 'params' | 'result' | 'error'>> = {}): Promise<TaskMeta> {
    validateTaskId(id)
    let next: TaskMeta | null = null
    await this.mutateIndex(index => {
      const current = index.get(id)
      if (!current) throw new Error('task not found')
      const meta = {
        ...current,
        ...patch,
        progress: patch.progress === undefined ? current.progress : clampProgress(patch.progress),
        updatedAt: nowIso(),
      }
      index.set(id, meta)
      next = meta
    })
    if (!next) throw new Error('task not found')
    return next
  }

  start(id: string, runner: (ctx: TaskRunnerContext) => Promise<unknown | void>): void {
    validateTaskId(id)
    if (this.controllers.has(id)) throw new Error('task already running')
    const controller = new AbortController()
    this.controllers.set(id, controller)
    void this.run(id, controller, runner)
  }

  attachSteerInbox(id: string, inbox: string[]): () => void {
    validateTaskId(id)
    this.liveSteerInboxes.set(id, inbox)
    return () => {
      if (this.liveSteerInboxes.get(id) === inbox) this.liveSteerInboxes.delete(id)
    }
  }

  async queueSteerMessage(id: string, message: string): Promise<boolean> {
    validateTaskId(id)
    const inbox = this.liveSteerInboxes.get(id)
    if (!inbox) return false
    inbox.push(message)
    await this.appendEvent(id, { type: 'context_note', text: `SendMessage queued: ${message.slice(0, 160)}` }).catch(() => undefined)
    return true
  }

  async cancel(id: string): Promise<boolean> {
    validateTaskId(id)
    const controller = this.controllers.get(id)
    if (!controller) return false
    controller.abort()
    await this.touch(id, { status: 'cancelled' }).catch(() => undefined)
    await this.appendEvent(id, { type: 'context_note', text: '后台任务已请求取消' }).catch(() => undefined)
    return true
  }

  async appendEvent(id: string, event: TaskStreamEvent): Promise<TaskEventRecord> {
    validateTaskId(id)
    const meta = await this.get(id)
    const metaSeq = meta?.lastEventSeq
    const lastSeq = typeof metaSeq === 'number' && Number.isInteger(metaSeq) && metaSeq > 0
      ? metaSeq
      : await this.readLastEventSeq(id)
    const record: TaskEventRecord = { seq: lastSeq + 1, ts: nowIso(), event }
    const path = this.eventPath(id)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    await this.touch(id, { lastEventSeq: record.seq }).catch(() => undefined)
    return record
  }

  async loadEvents(id: string, opts: { after?: number; limit?: number } = {}): Promise<TaskEventRecord[]> {
    validateTaskId(id)
    const after = Number.isFinite(opts.after) ? Math.max(0, Math.floor(opts.after!)) : 0
    const limit = clampLimit(opts.limit)
    const events: TaskEventRecord[] = []
    for await (const record of this.iterEventRecords(id)) {
      if (record.seq <= after) continue
      events.push(record)
      if (events.length >= limit) break
    }
    return events
  }

  eventPath(id: string): string {
    validateTaskId(id)
    return join(this.rootDir, 'task-events', `${id}.jsonl`)
  }

  transcript(id: string): Transcript {
    validateTaskId(id)
    return new Transcript(join(this.rootDir, 'task-transcripts'), id)
  }

  backgroundAgentMetadataPath(id: string): string {
    validateTaskId(id)
    return join(this.rootDir, 'task-transcripts', 'transcripts', `${id}.meta.json`)
  }

  backgroundAgentToolResultStoreDir(id: string): string {
    validateTaskId(id)
    return join(this.rootDir, 'task-tool-results', id)
  }

  async listBackgroundAgentMetadata(): Promise<BackgroundAgentMetadata[]> {
    const dir = join(this.rootDir, 'task-transcripts', 'transcripts')
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const metadata: BackgroundAgentMetadata[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.meta.json')) continue
      const id = entry.slice(0, -'.meta.json'.length)
      if (!TASK_ID_RE.test(id)) continue
      const record = await this.readBackgroundAgentMetadata(id)
      if (record) metadata.push(record)
    }
    return metadata.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
  }

  async writeBackgroundAgentMetadata(id: string, metadata: Omit<BackgroundAgentMetadata, 'taskId' | 'createdAt' | 'updatedAt'> & Partial<Pick<BackgroundAgentMetadata, 'taskId' | 'createdAt' | 'updatedAt'>>): Promise<BackgroundAgentMetadata> {
    validateTaskId(id)
    const timestamp = nowIso()
    const current = await this.readBackgroundAgentMetadata(id)
    const next: BackgroundAgentMetadata = {
      ...current,
      ...metadata,
      taskId: id,
      agentId: metadata.agentId?.trim() || current?.agentId,
      agent: metadata.agent.trim(),
      agentType: metadata.agentType?.trim() || metadata.agent.trim(),
      createdAt: metadata.createdAt ?? current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    if (!next.agent) throw new Error('background agent metadata requires agent')
    const path = this.backgroundAgentMetadataPath(id)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
    return next
  }

  async readBackgroundAgentMetadata(id: string): Promise<BackgroundAgentMetadata | null> {
    validateTaskId(id)
    try {
      const parsed = JSON.parse(await readFile(this.backgroundAgentMetadataPath(id), 'utf8')) as unknown
      return backgroundAgentMetadataFrom(parsed, id)
    } catch {
      return null
    }
  }

  private async run(id: string, controller: AbortController, runner: (ctx: TaskRunnerContext) => Promise<unknown | void>): Promise<void> {
    let settled: TaskMeta | null = null
    try {
      await this.touch(id, { status: 'running', error: undefined })
      await this.appendEvent(id, { type: 'started', text: '后台任务已启动' })
      const result = await runner({
        signal: controller.signal,
        emit: event => this.appendEvent(id, event),
        progress: async (progress, stage) => {
          await this.touch(id, { progress, stage })
          if (stage) await this.appendEvent(id, { type: 'context_note', text: stage })
        },
      })
      if (controller.signal.aborted) {
        settled = await this.touch(id, { status: 'cancelled' })
      } else {
        settled = await this.touch(id, { status: 'completed', progress: 100, result })
      }
    } catch (err) {
      const message = controller.signal.aborted ? '后台任务已取消' : err instanceof Error ? err.message : String(err)
      settled = await this.touch(id, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: message }).catch(() => null)
      await this.appendEvent(id, { type: 'final', text: message }).catch(() => undefined)
    } finally {
      this.controllers.delete(id)
      this.liveSteerInboxes.delete(id)
      await this.appendEvent(id, { type: 'done' }).catch(() => undefined)
      if (settled) await this.notifySettled(settled)
    }
  }

  private async notifySettled(task: TaskMeta): Promise<void> {
    try {
      await this.options.onSettled?.(task)
    } catch {
      // 通知/旁路钩子失败不能反向污染任务状态。
    }
  }

  private async readLastEventSeq(id: string): Promise<number> {
    let lastSeq = 0
    for await (const record of this.iterEventRecords(id)) {
      if (record.seq > lastSeq) lastSeq = record.seq
    }
    return lastSeq
  }

  private async *iterEventRecords(id: string): AsyncGenerator<TaskEventRecord> {
    const stream = createReadStream(this.eventPath(id), { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as unknown
          if (isTaskEventRecord(parsed)) yield parsed
        } catch {
          // 单行损坏跳过,不让任务抽屉整体不可读。
        }
      }
    } catch {
      // 缺失文件按空事件处理。
    } finally {
      lines.close()
      stream.destroy()
    }
  }

  private async readIndex(): Promise<Map<string, TaskMeta>> {
    let raw = ''
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch {
      return new Map()
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const arr = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : []
      return new Map(arr.filter(isTaskMeta).map(meta => [meta.id, { progress: 0, lastEventSeq: 0, ...meta }]))
    } catch {
      return new Map()
    }
  }

  private async writeIndex(index: Map<string, TaskMeta>): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true })
    const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`
    const tasks = [...index.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    await writeFile(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`, 'utf8')
    await rename(tmp, this.indexPath)
  }

  private async mutateIndex(mutator: (index: Map<string, TaskMeta>) => void | Promise<void>): Promise<void> {
    const run = this.indexQueue.then(async () => {
      const index = await this.readIndex()
      await mutator(index)
      await this.writeIndex(index)
    })
    this.indexQueue = run.catch(() => undefined)
    await run
  }
}
