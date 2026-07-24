import type { ProductTaskEvent, ProductTaskRunSnapshot } from '../../../shared/product/taskEvents.js'

type Listener = (taskId: string, event: ProductTaskEvent) => void

class ProductTaskWorkerRuntimeEvents {
  private readonly listeners = new Set<Listener>()
  private readonly snapshots = new Map<string, ProductTaskRunSnapshot>()

  publish(taskId: string, event: ProductTaskEvent): void {
    if (event.type === 'status') this.snapshots.set(taskId, { state: event.state, activities: [] })
    if (event.type === 'turn_complete' || (event.type === 'error' && !event.retryable)) {
      this.snapshots.set(taskId, { state: 'idle', activities: [] })
    }
    for (const listener of this.listeners) listener(taskId, event)
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
