import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
  ProductTaskEvent,
  ProductTaskRunActivity,
  ProductTaskRunSnapshot,
  ProductTaskRunState,
} from '../../../shared/product/taskEvents.js'
import type { ServerMessage } from '../ws/events.js'
import { ProductTaskRunActivityProjector } from './taskEventProjection.js'

const MAX_RUN_ACTIVITIES = 256
const ACTIVITY_ID_PATTERN = /^activity_[a-f0-9]{32}$/

const ACTIVITY_KINDS = new Set<ProductTaskActivityKind>([
  'workspace',
  'command',
  'research',
  'browser',
  'media',
  'subtask',
  'tool',
])
const ACTIVITY_PHASES = new Set<ProductTaskActivityPhase>([
  'started',
  'running',
  'completed',
  'failed',
])
const ACTIVITY_SUMMARIES = new Set([
  '正在整理任务计划',
  '已整理任务计划',
  '任务计划整理未完成',
  '正在整理工作内容',
  '已整理工作内容',
  '工作内容整理未完成',
  '正在处理任务操作',
  '已完成任务操作',
  '任务操作未完成',
  '正在查询资料',
  '已完成资料查询',
  '资料查询未完成',
  '正在查看网页',
  '已完成网页查看',
  '网页查看未完成',
  '正在处理素材',
  '已完成素材处理',
  '素材处理未完成',
  '正在协同处理事项',
  '已完成协同事项',
  '协同事项未完成',
  '正在处理任务',
  '已完成任务处理',
  '任务处理未完成',
])

type TaskRunRecord = {
  sessionId: string
  projector: ProductTaskRunActivityProjector
  snapshot: ProductTaskRunSnapshot
}

function emptySnapshot(): ProductTaskRunSnapshot {
  return { state: 'idle', activities: [] }
}

function cloneSnapshot(snapshot: ProductTaskRunSnapshot): ProductTaskRunSnapshot {
  return {
    state: snapshot.state,
    activities: snapshot.activities.map((activity) => ({
      ...activity,
      ...(activity.progress ? { progress: { ...activity.progress } } : {}),
    })),
  }
}

function isActivityProgress(value: unknown): value is ProductTaskActivityProgress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 2 &&
    typeof record.completed === 'number' &&
    typeof record.total === 'number' &&
    Number.isSafeInteger(record.completed) &&
    Number.isSafeInteger(record.total) &&
    record.total >= 1 &&
    record.total <= 10_000 &&
    record.completed >= 0 &&
    record.completed <= record.total
}

/**
 * The run registry is deliberately process-local. Its opaque IDs are keyed by
 * a process secret, and a Core turn cannot survive a server restart in a way
 * that would make a restored `working` state trustworthy. The only retained
 * values are a bounded, product-safe activity tree and its current state.
 */
export class ProductTaskRunProjection {
  private readonly tasks = new Map<string, TaskRunRecord>()
  private readonly taskIdsBySession = new Map<string, Set<string>>()
  private readonly projectedEvents = new WeakMap<object, Map<string, ProductTaskEvent[]>>()

  register(taskId: string, sessionId: string): ProductTaskRunSnapshot {
    const existing = this.tasks.get(taskId)
    if (existing?.sessionId === sessionId) return cloneSnapshot(existing.snapshot)

    if (existing) this.removeTaskFromSession(taskId, existing.sessionId)
    const record: TaskRunRecord = {
      sessionId,
      projector: new ProductTaskRunActivityProjector(taskId),
      snapshot: emptySnapshot(),
    }
    this.tasks.set(taskId, record)
    const taskIds = this.taskIdsBySession.get(sessionId) ?? new Set<string>()
    taskIds.add(taskId)
    this.taskIdsBySession.set(sessionId, taskIds)
    return cloneSnapshot(record.snapshot)
  }

  beginRun(taskId: string, sessionId: string): ProductTaskRunSnapshot {
    this.register(taskId, sessionId)
    const record = this.tasks.get(taskId)
    if (!record) throw new Error('Product task run registry was not initialized')
    // A new product turn must not inherit a prior Core tool cache or its
    // visible activity tree. The task/session binding remains private here.
    record.projector = new ProductTaskRunActivityProjector(taskId)
    record.snapshot = { state: 'working', activities: [] }
    return cloneSnapshot(record.snapshot)
  }

  clearRun(taskId: string, sessionId: string): ProductTaskRunSnapshot {
    return this.beginIdleRun(taskId, sessionId)
  }

  getSnapshot(taskId: string, sessionId: string): ProductTaskRunSnapshot {
    return this.register(taskId, sessionId)
  }

  hasActiveRunForSession(sessionId: string): boolean {
    return [...(this.taskIdsBySession.get(sessionId) ?? [])].some((taskId) => {
      const state = this.tasks.get(taskId)?.snapshot.state
      return state === 'working' || state === 'awaiting_approval'
    })
  }

  projectTaskMessage(
    taskId: string,
    sessionId: string,
    message: ServerMessage,
  ): ProductTaskEvent[] {
    this.register(taskId, sessionId)
    const cached = this.projectedEvents.get(message)?.get(taskId)
    if (cached) return cached

    const record = this.tasks.get(taskId)
    if (!record) return []
    const events = record.projector.project(message)
    this.applyEvents(record, events)

    let byTask = this.projectedEvents.get(message)
    if (!byTask) {
      byTask = new Map<string, ProductTaskEvent[]>()
      this.projectedEvents.set(message, byTask)
    }
    byTask.set(taskId, events)
    return events
  }

  projectSessionMessage(
    sessionId: string,
    message: ServerMessage,
  ): ReadonlyMap<string, ProductTaskEvent[]> {
    const eventsByTask = new Map<string, ProductTaskEvent[]>()
    for (const taskId of this.taskIdsBySession.get(sessionId) ?? []) {
      eventsByTask.set(taskId, this.projectTaskMessage(taskId, sessionId, message))
    }
    return eventsByTask
  }

  removeSession(sessionId: string): void {
    for (const taskId of this.taskIdsBySession.get(sessionId) ?? []) {
      this.tasks.delete(taskId)
    }
    this.taskIdsBySession.delete(sessionId)
  }

  reset(): void {
    this.tasks.clear()
    this.taskIdsBySession.clear()
  }

  private beginIdleRun(taskId: string, sessionId: string): ProductTaskRunSnapshot {
    this.register(taskId, sessionId)
    const record = this.tasks.get(taskId)
    if (!record) throw new Error('Product task run registry was not initialized')
    record.projector = new ProductTaskRunActivityProjector(taskId)
    record.snapshot = emptySnapshot()
    return cloneSnapshot(record.snapshot)
  }

  private removeTaskFromSession(taskId: string, sessionId: string): void {
    const taskIds = this.taskIdsBySession.get(sessionId)
    if (!taskIds) return
    taskIds.delete(taskId)
    if (taskIds.size === 0) this.taskIdsBySession.delete(sessionId)
  }

  private applyEvents(record: TaskRunRecord, events: readonly ProductTaskEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'status':
          record.snapshot.state = event.state
          break

        case 'activity':
          if (isSafeRunActivity(event)) {
            record.snapshot.activities = upsertActivity(record.snapshot.activities, event)
          }
          break

        case 'approval_required':
          // Approval payloads are intentionally never retained. Reconnect
          // replays the live server-owned request separately.
          record.snapshot.state = 'awaiting_approval'
          break

        case 'turn_complete':
          record.snapshot.state = 'idle'
          break

        case 'error':
          if (!event.retryable) record.snapshot.state = 'idle'
          break

        case 'connected':
        case 'user_text':
        case 'assistant_text_start':
        case 'assistant_text_delta':
        case 'title_updated':
          break
      }
    }
  }
}

function isSafeRunActivity(
  event: Extract<ProductTaskEvent, { type: 'activity' }>,
): event is Extract<ProductTaskEvent, { type: 'activity' }> & ProductTaskRunActivity {
  return typeof event.id === 'string' &&
    ACTIVITY_ID_PATTERN.test(event.id) &&
    (event.parentId === undefined || (
      ACTIVITY_ID_PATTERN.test(event.parentId) && event.parentId !== event.id
    )) &&
    ACTIVITY_KINDS.has(event.kind) &&
    ACTIVITY_PHASES.has(event.phase) &&
    typeof event.summary === 'string' &&
    ACTIVITY_SUMMARIES.has(event.summary) &&
    (event.progress === undefined || isActivityProgress(event.progress))
}

function upsertActivity(
  activities: readonly ProductTaskRunActivity[],
  event: ProductTaskRunActivity,
): ProductTaskRunActivity[] {
  const index = activities.findIndex((activity) => activity.id === event.id)
  const previous = index === -1 ? undefined : activities[index]
  const activity: ProductTaskRunActivity = {
    id: event.id,
    ...(event.parentId
      ? { parentId: event.parentId }
      : previous?.parentId
        ? { parentId: previous.parentId }
        : {}),
    kind: event.kind,
    phase: event.phase,
    summary: event.summary,
    ...(event.progress
      ? { progress: { ...event.progress } }
      : previous?.progress
        ? { progress: { ...previous.progress } }
        : {}),
  }
  const next = index === -1
    ? [...activities, activity]
    : activities.map((current, currentIndex) => currentIndex === index ? activity : current)
  return next.length > MAX_RUN_ACTIVITIES ? next.slice(-MAX_RUN_ACTIVITIES) : next
}

export const productTaskRunProjection = new ProductTaskRunProjection()
