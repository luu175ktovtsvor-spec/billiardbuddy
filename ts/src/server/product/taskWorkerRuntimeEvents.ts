import type { ProductTaskEvent, ProductTaskRunSnapshot } from '../../../shared/product/taskEvents.js'

const MAX_SNAPSHOT_ACTIVITIES = 256

function upsertSnapshotActivity(
  snapshot: ProductTaskRunSnapshot,
  event: Extract<ProductTaskEvent, { type: 'activity' }>,
): ProductTaskRunSnapshot {
  const activity = {
    id: event.id,
    ...(event.parentId ? { parentId: event.parentId } : {}),
    kind: event.kind,
    phase: event.phase,
    summary: event.summary,
    ...(event.progress ? { progress: { ...event.progress } } : {}),
  }
  const index = snapshot.activities.findIndex(candidate => candidate.id === event.id)
  const activities = index === -1
    ? [...snapshot.activities, activity]
    : snapshot.activities.map((candidate, candidateIndex) => candidateIndex === index ? activity : candidate)
  return { state: snapshot.state, activities: activities.slice(-MAX_SNAPSHOT_ACTIVITIES), ...(snapshot.plan ? { plan: { id: snapshot.plan.id, steps: snapshot.plan.steps.map(step => ({ ...step })) } } : {}) }
}

type Listener = (taskId: string, event: ProductTaskEvent) => void

/**
 * Ephemeral projection of already-durable task events for one Product Server.
 *
 * This intentionally belongs to the server composition root: it carries live
 * sockets and approval ownership, neither of which may leak across a second
 * server lifetime or a test process.
 */
export class ProductTaskWorkerRuntimeEvents {
  private readonly listeners = new Set<Listener>()
  private readonly snapshots = new Map<string, ProductTaskRunSnapshot>()
  private readonly pendingApprovals = new Map<string, Extract<ProductTaskEvent, { type: 'approval_required' }>>()

  publish(taskId: string, event: ProductTaskEvent): void {
    if (event.type === 'status') {
      const previous = this.snapshots.get(taskId) ?? { state: 'idle' as const, activities: [] }
      this.snapshots.set(taskId, {
        state: event.state,
        activities: previous.state === 'idle' && event.state === 'working' ? [] : previous.activities,
        ...(previous.state === 'idle' && event.state === 'working' ? {} : previous.plan ? { plan: previous.plan } : {}),
      })
      if (event.state !== 'awaiting_approval') this.pendingApprovals.delete(taskId)
    }
    if (event.type === 'activity') {
      this.snapshots.set(taskId, upsertSnapshotActivity(
        this.snapshots.get(taskId) ?? { state: 'working', activities: [] },
        event,
      ))
    }
    if (event.type === 'plan_updated') {
      const previous = this.snapshots.get(taskId) ?? { state: 'working' as const, activities: [] }
      this.snapshots.set(taskId, { ...previous, plan: { id: event.plan.id, steps: event.plan.steps.map(step => ({ ...step })) } })
    }
    if (event.type === 'approval_required') {
      this.rememberApproval(taskId, event)
      const previous = this.snapshots.get(taskId)
      this.snapshots.set(taskId, { state: 'awaiting_approval', activities: previous?.activities ?? [], ...(previous?.plan ? { plan: previous.plan } : {}) })
    }
    if (event.type === 'turn_complete' || (event.type === 'error' && !event.retryable)) {
      const previous = this.snapshots.get(taskId)
      this.snapshots.set(taskId, { state: 'idle', activities: [], ...(previous?.plan ? { plan: previous.plan } : {}) })
      this.pendingApprovals.delete(taskId)
    }
    for (const listener of this.listeners) {
      try {
        listener(taskId, event)
      } catch {
        // A disconnected or faulty presentation subscriber cannot turn an
        // already-durable worker event into an execution persistence failure.
      }
    }
  }

  rememberApproval(taskId: string, event: Extract<ProductTaskEvent, { type: 'approval_required' }>): void {
    this.pendingApprovals.set(taskId, event)
  }

  ownsApproval(taskId: string, requestId: string): boolean {
    return this.pendingApprovals.get(taskId)?.requestId === requestId
  }

  snapshot(taskId: string): ProductTaskRunSnapshot {
    const snapshot = this.snapshots.get(taskId)
    return snapshot
      ? {
          state: snapshot.state,
          activities: snapshot.activities.map(activity => ({
            ...activity,
            ...(activity.progress ? { progress: { ...activity.progress } } : {}),
          })),
          ...(snapshot.plan ? { plan: { id: snapshot.plan.id, steps: snapshot.plan.steps.map(step => ({ ...step })) } } : {}),
        }
      : { state: 'idle', activities: [] }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
