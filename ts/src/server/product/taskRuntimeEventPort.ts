import type { ProductTaskEvent } from '../../../shared/product/taskEvents.js'

export type ProductTaskRuntimeEventPort = {
  publish(taskId: string, event: ProductTaskEvent): void
}

export function createProductTaskRuntimeEventPort(
  events: ProductTaskRuntimeEventPort,
): ProductTaskRuntimeEventPort {
  return {
    publish(taskId, event) {
      events.publish(taskId, event)
    },
  }
}
