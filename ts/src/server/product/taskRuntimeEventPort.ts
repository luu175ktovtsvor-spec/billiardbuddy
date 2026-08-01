import type { ProductTaskEvent } from '../../../shared/product/taskEvents.js'
import { productTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'

export type ProductTaskRuntimeEventPort = {
  publish(taskId: string, event: ProductTaskEvent): void
}

export const productTaskRuntimeEventPort: ProductTaskRuntimeEventPort = {
  publish(taskId, event) {
    productTaskWorkerRuntimeEvents.publish(taskId, event)
  },
}
