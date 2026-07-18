import type { ContinueProductTaskInput, CreateProductTaskInput } from './domain/types'
import type { ProductTaskRecord } from './domain/types'
import type { AttachmentRef } from '../types/chat'

export type ProductTaskInitialMessage = {
  text?: string
  attachments?: AttachmentRef[]
}

export type ProductTaskLaunchDependencies = {
  createTask: (input: CreateProductTaskInput) => Promise<ProductTaskRecord>
  refreshSessions: () => Promise<void>
  openTask: (task: ProductTaskRecord) => void
  connectToSession: (sessionId: string) => void
  sendMessage: (sessionId: string, content: string, attachments?: AttachmentRef[]) => void
}

export type ProductTaskContinuationDependencies = Pick<
  ProductTaskLaunchDependencies,
  'refreshSessions' | 'openTask' | 'connectToSession'
> & {
  continueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskRecord>
}

export async function launchProductTask(
  dependencies: ProductTaskLaunchDependencies,
  input: CreateProductTaskInput,
  initialMessage?: ProductTaskInitialMessage,
): Promise<ProductTaskRecord> {
  const task = await dependencies.createTask(input)
  await dependencies.refreshSessions()
  dependencies.openTask(task)
  dependencies.connectToSession(task.coreSessionId)

  const message = initialMessage?.text?.trim() ?? ''
  const attachments = initialMessage?.attachments ?? []
  if (message || attachments.length > 0) {
    dependencies.sendMessage(task.coreSessionId, message, attachments)
  }

  return task
}

export async function continueProductTask(
  dependencies: ProductTaskContinuationDependencies,
  taskId: string,
  input: ContinueProductTaskInput,
): Promise<ProductTaskRecord> {
  const task = await dependencies.continueTask(taskId, input)
  await dependencies.refreshSessions()
  dependencies.openTask(task)
  dependencies.connectToSession(task.coreSessionId)
  return task
}
