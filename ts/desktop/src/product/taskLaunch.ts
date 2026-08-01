import type { ContinueProductTaskInput } from './domain/types'
import type { ProductTaskRecord } from './domain/types'

export type ProductTaskContinuationDependencies = {
  openTask: (task: ProductTaskRecord) => void
  continueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskRecord>
}

export async function continueProductTask(
  dependencies: ProductTaskContinuationDependencies,
  taskId: string,
  input: ContinueProductTaskInput,
): Promise<ProductTaskRecord> {
  const task = await dependencies.continueTask(taskId, input)
  dependencies.openTask(task)
  return task
}
