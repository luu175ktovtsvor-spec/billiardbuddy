import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const STRUCTURED_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type StructuredTaskStatus = typeof STRUCTURED_TASK_STATUSES[number]

export interface StructuredTask {
  id: string
  subject: string
  description: string
  activeForm?: string
  owner?: string
  status: StructuredTaskStatus
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface StructuredTaskListState {
  nextId: number
  tasks: StructuredTask[]
}

export interface TaskListScope {
  conversationId?: string
  workspaceRoot?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStatus(value: unknown): value is StructuredTaskStatus {
  return STRUCTURED_TASK_STATUSES.includes(value as StructuredTaskStatus)
}

function cleanText(value: string | undefined, fallback = ''): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

function normalizeId(value: string): string {
  const id = value.trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('非法 task id')
  return id
}

function normalizeTask(raw: unknown): StructuredTask | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null
  if (typeof raw.subject !== 'string' || !raw.subject.trim()) return null
  if (!isStatus(raw.status)) return null
  const timestamp = typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso()
  return {
    id: normalizeId(raw.id),
    subject: raw.subject.trim(),
    description: typeof raw.description === 'string' ? raw.description : '',
    activeForm: typeof raw.activeForm === 'string' && raw.activeForm.trim() ? raw.activeForm.trim() : undefined,
    owner: typeof raw.owner === 'string' && raw.owner.trim() ? raw.owner.trim() : undefined,
    status: raw.status,
    blocks: Array.isArray(raw.blocks) ? raw.blocks.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()) : [],
    blockedBy: Array.isArray(raw.blockedBy) ? raw.blockedBy.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()) : [],
    metadata: isRecord(raw.metadata) ? raw.metadata : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : timestamp,
    updatedAt: timestamp,
  }
}

function scopeKey(scope: TaskListScope): string {
  const source = scope.conversationId?.trim()
    ? `conversation:${scope.conversationId.trim()}`
    : `workspace:${scope.workspaceRoot?.trim() || 'default'}`
  return createHash('sha1').update(source).digest('hex')
}

function mergeMetadata(current: Record<string, unknown> | undefined, patch: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!patch) return current
  const next = { ...(current ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return Object.keys(next).length ? next : undefined
}

export class TaskListService {
  private queues = new Map<string, Promise<unknown>>()

  constructor(private readonly rootDir: string) {}

  async list(scope: TaskListScope): Promise<StructuredTask[]> {
    const state = await this.readState(scope)
    return state.tasks
  }

  async get(scope: TaskListScope, taskId: string): Promise<StructuredTask | null> {
    const id = normalizeId(taskId)
    return (await this.readState(scope)).tasks.find(task => task.id === id) ?? null
  }

  async create(scope: TaskListScope, input: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }): Promise<StructuredTask> {
    let created: StructuredTask | null = null
    await this.mutateState(scope, state => {
      const id = String(state.nextId)
      const timestamp = nowIso()
      created = {
        id,
        subject: cleanText(input.subject, '未命名任务'),
        description: cleanText(input.description),
        activeForm: cleanText(input.activeForm) || undefined,
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: input.metadata && Object.keys(input.metadata).length ? input.metadata : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      state.nextId += 1
      state.tasks.push(created)
    })
    if (!created) throw new Error('task create failed')
    return created
  }

  async update(scope: TaskListScope, taskId: string, patch: {
    subject?: string
    description?: string
    activeForm?: string
    status?: StructuredTaskStatus | 'deleted'
    owner?: string
    addBlocks?: string[]
    addBlockedBy?: string[]
    metadata?: Record<string, unknown>
  }): Promise<{ task: StructuredTask | null; deleted: boolean; updatedFields: string[]; statusChange?: { from: StructuredTaskStatus; to: StructuredTaskStatus | 'deleted' } }> {
    const id = normalizeId(taskId)
    let result: { task: StructuredTask | null; deleted: boolean; updatedFields: string[]; statusChange?: { from: StructuredTaskStatus; to: StructuredTaskStatus | 'deleted' } } = {
      task: null,
      deleted: false,
      updatedFields: [],
    }
    await this.mutateState(scope, state => {
      const index = state.tasks.findIndex(task => task.id === id)
      if (index < 0) return
      const current = state.tasks[index]!
      const timestamp = nowIso()
      if (patch.status === 'deleted') {
        state.tasks.splice(index, 1)
        for (const task of state.tasks) {
          task.blocks = task.blocks.filter(item => item !== id)
          task.blockedBy = task.blockedBy.filter(item => item !== id)
          task.updatedAt = timestamp
        }
        result = {
          task: current,
          deleted: true,
          updatedFields: ['deleted'],
          statusChange: { from: current.status, to: 'deleted' },
        }
        return
      }
      const next: StructuredTask = { ...current, updatedAt: timestamp }
      const updatedFields: string[] = []
      if (patch.subject !== undefined && cleanText(patch.subject) !== current.subject) {
        next.subject = cleanText(patch.subject, current.subject)
        updatedFields.push('subject')
      }
      if (patch.description !== undefined && patch.description !== current.description) {
        next.description = cleanText(patch.description)
        updatedFields.push('description')
      }
      if (patch.activeForm !== undefined && cleanText(patch.activeForm) !== (current.activeForm ?? '')) {
        next.activeForm = cleanText(patch.activeForm) || undefined
        updatedFields.push('activeForm')
      }
      if (patch.owner !== undefined && cleanText(patch.owner) !== (current.owner ?? '')) {
        next.owner = cleanText(patch.owner) || undefined
        updatedFields.push('owner')
      }
      if (patch.status && patch.status !== current.status) {
        next.status = patch.status
        updatedFields.push('status')
        result.statusChange = { from: current.status, to: patch.status }
      }
      if (patch.metadata !== undefined) {
        next.metadata = mergeMetadata(current.metadata, patch.metadata)
        updatedFields.push('metadata')
      }
      state.tasks[index] = next
      const addedBlocks = this.addEdges(state.tasks, id, patch.addBlocks, 'blocks', timestamp)
      if (addedBlocks > 0) updatedFields.push('blocks')
      const addedBlockedBy = this.addEdges(state.tasks, id, patch.addBlockedBy, 'blockedBy', timestamp)
      if (addedBlockedBy > 0) updatedFields.push('blockedBy')
      result = { task: state.tasks.find(task => task.id === id) ?? next, deleted: false, updatedFields, statusChange: result.statusChange }
    })
    return result
  }

  private addEdges(tasks: StructuredTask[], taskId: string, ids: string[] | undefined, direction: 'blocks' | 'blockedBy', timestamp: string): number {
    if (!ids?.length) return 0
    const task = tasks.find(item => item.id === taskId)
    if (!task) return 0
    let added = 0
    for (const rawId of ids) {
      const otherId = normalizeId(rawId)
      if (otherId === taskId) continue
      const other = tasks.find(item => item.id === otherId)
      if (!other) continue
      const [blocker, blocked] = direction === 'blocks' ? [task, other] : [other, task]
      if (!blocker.blocks.includes(blocked.id)) {
        blocker.blocks.push(blocked.id)
        blocker.updatedAt = timestamp
        added++
      }
      if (!blocked.blockedBy.includes(blocker.id)) {
        blocked.blockedBy.push(blocker.id)
        blocked.updatedAt = timestamp
      }
    }
    return added
  }

  private statePath(scope: TaskListScope): string {
    return join(this.rootDir, `${scopeKey(scope)}.json`)
  }

  private async readState(scope: TaskListScope): Promise<StructuredTaskListState> {
    try {
      const raw = await readFile(this.statePath(scope), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed)) return { nextId: 1, tasks: [] }
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(normalizeTask).filter((task): task is StructuredTask => !!task) : []
      const highest = tasks.reduce((max, task) => Math.max(max, Number.parseInt(task.id, 10) || 0), 0)
      const nextId = typeof parsed.nextId === 'number' && Number.isInteger(parsed.nextId) && parsed.nextId > highest ? parsed.nextId : highest + 1
      return { nextId: Math.max(1, nextId), tasks }
    } catch {
      return { nextId: 1, tasks: [] }
    }
  }

  private async writeState(scope: TaskListScope, state: StructuredTaskListState): Promise<void> {
    const path = this.statePath(scope)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  private async mutateState(scope: TaskListScope, mutator: (state: StructuredTaskListState) => void | Promise<void>): Promise<void> {
    const key = scopeKey(scope)
    const prev = this.queues.get(key) ?? Promise.resolve()
    const run = prev.then(async () => {
      const state = await this.readState(scope)
      await mutator(state)
      await this.writeState(scope, state)
    })
    this.queues.set(key, run.catch(() => undefined))
    await run
  }
}
