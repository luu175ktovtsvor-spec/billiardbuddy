import type { ContinueProductTaskInput, CreateProductTaskInput } from './domain/types'
import type { ProductTaskRecord } from './domain/types'
import type { ProductTaskAttachment } from './api/taskSocket'

export type ProductTaskInitialMessage = {
  text?: string
  attachments?: ProductTaskAttachment[]
}

export type ProductTaskLaunchDependencies = {
  createTask: (input: CreateProductTaskInput) => Promise<ProductTaskRecord>
  openTask: (task: ProductTaskRecord) => void
  connectTask: (taskId: string) => void | Promise<void>
  sendMessage: (taskId: string, content: string, attachments?: ProductTaskAttachment[]) => boolean | Promise<boolean>
}

export type ProductTaskContinuationDependencies = {
  openTask: (task: ProductTaskRecord) => void
  continueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskRecord>
}

export async function launchProductTask(
  dependencies: ProductTaskLaunchDependencies,
  input: CreateProductTaskInput,
  initialMessage?: ProductTaskInitialMessage,
): Promise<ProductTaskRecord> {
  const task = await dependencies.createTask(input)
  dependencies.openTask(task)
  void dependencies.connectTask(task.id)

  const message = initialMessage?.text?.trim() ?? ''
  const attachments = initialMessage?.attachments ?? []
  if (message || attachments.length > 0) {
    await dependencies.sendMessage(task.id, message, attachments)
  }

  return task
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
