import type { ProductTaskEvent, ProductTaskRunSnapshot } from '../../../shared/product/taskEvents.js'

type Listener = (taskId: string, event: ProductTaskEvent) => void

class ProductTaskWorkerRuntimeEvents {
  private readonly listeners = new Set<Listener>()
  private readonly snapshots = new Map<string, ProductTaskRunSnapshot>()
  private readonly pendingApprovals = new Map<string, Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'action' }>>()

  publish(taskId: string, event: ProductTaskEvent): void {
    if (event.type === 'status') {
      this.snapshots.set(taskId, { state: event.state, activities: [] })
      if (event.state !== 'awaiting_approval') this.pendingApprovals.delete(taskId)
    }
    if (event.type === 'approval_required' && event.kind === 'action') {
      this.rememberApproval(taskId, event)
      this.snapshots.set(taskId, { state: 'awaiting_approval', activities: [] })
    }
    if (event.type === 'turn_complete' || (event.type === 'error' && !event.retryable)) {
      this.snapshots.set(taskId, { state: 'idle', activities: [] })
      this.pendingApprovals.delete(taskId)
    }
    for (const listener of this.listeners) listener(taskId, event)
  }

  rememberApproval(taskId: string, event: Extract<ProductTaskEvent, { type: 'approval_required'; kind: 'action' }>): void {
    this.pendingApprovals.set(taskId, event)
  }

  ownsApproval(taskId: string, requestId: string): boolean {
    return this.pendingApprovals.get(taskId)?.requestId === requestId
  }

  snapshot(taskId: string): ProductTaskRunSnapshot {
    return this.snapshots.get(taskId) ?? { state: 'idle', activities: [] }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const productTaskWorkerRuntimeEvents = new ProductTaskWorkerRuntimeEvents()
