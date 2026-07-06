import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
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
  lastEventSeq?: number
  params?: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface TaskRunnerContext {
  signal: AbortSignal
  emit(event: TaskStreamEvent): Promise<TaskEventRecord>
  progress(progress: number, stage?: string): Promise<void>
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
    (value.lastEventSeq === undefined || typeof value.lastEventSeq === 'number') &&
    (value.params === undefined || isRecord(value.params)) &&
    (value.error === undefined || typeof value.error === 'string')
}

function isTaskEventRecord(value: unknown): value is TaskEventRecord {
  if (!isRecord(value)) return false
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return false
  if (typeof value.ts !== 'string') return false
  return isRecord(value.event) && typeof value.event.type === 'string'
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

export class TaskService {
  private readonly indexPath: string
  private readonly controllers = new Map<string, AbortController>()
  private indexQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly rootDir: string) {
    this.indexPath = join(rootDir, 'tasks.json')
  }

  async list(opts: { conversationId?: string; status?: TaskStatus; limit?: number } = {}): Promise<TaskMeta[]> {
    const limit = clampLimit(opts.limit)
    const tasks = [...(await this.readIndex()).values()]
      .filter(task => !opts.conversationId || task.conversationId === opts.conversationId)
      .filter(task => !opts.status || task.status === opts.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return tasks.slice(0, limit)
  }

  async get(id: string): Promise<TaskMeta | null> {
    validateTaskId(id)
    return (await this.readIndex()).get(id) ?? null
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

  async touch(id: string, patch: Partial<Pick<TaskMeta, 'title' | 'status' | 'kind' | 'conversationId' | 'workspaceRoot' | 'progress' | 'stage' | 'lastEventSeq' | 'params' | 'result' | 'error'>> = {}): Promise<TaskMeta> {
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

  private async run(id: string, controller: AbortController, runner: (ctx: TaskRunnerContext) => Promise<unknown | void>): Promise<void> {
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
        await this.touch(id, { status: 'cancelled' })
      } else {
        await this.touch(id, { status: 'completed', progress: 100, result })
      }
    } catch (err) {
      const message = controller.signal.aborted ? '后台任务已取消' : err instanceof Error ? err.message : String(err)
      await this.touch(id, { status: controller.signal.aborted ? 'cancelled' : 'failed', error: message }).catch(() => undefined)
      await this.appendEvent(id, { type: 'final', text: message }).catch(() => undefined)
    } finally {
      this.controllers.delete(id)
      await this.appendEvent(id, { type: 'done' }).catch(() => undefined)
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
