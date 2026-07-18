import type { CreateProductTaskInput } from './domain/types'
import type { ProductTaskRecord } from './domain/types'

export type ProductTaskLaunchDependencies = {
  createTask: (input: CreateProductTaskInput) => Promise<ProductTaskRecord>
  refreshSessions: () => Promise<void>
  openTask: (task: ProductTaskRecord) => void
  connectToSession: (sessionId: string) => void
  sendMessage: (sessionId: string, content: string) => void
}

export async function launchProductTask(
  dependencies: ProductTaskLaunchDependencies,
  input: CreateProductTaskInput,
  initialText?: string,
): Promise<ProductTaskRecord> {
  const task = await dependencies.createTask(input)
  await dependencies.refreshSessions()
  dependencies.openTask(task)
  dependencies.connectToSession(task.coreSessionId)

  const message = initialText?.trim()
  if (message) dependencies.sendMessage(task.coreSessionId, message)

  return task
}
