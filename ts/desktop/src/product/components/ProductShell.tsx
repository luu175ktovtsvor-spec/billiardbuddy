import { useEffect } from 'react'
import { TaskIndex } from './TaskIndex'
import { useProductTaskStore } from '../stores/productTaskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { launchProductTask } from '../taskLaunch'
import type { CreateProductTaskInput, ProductTaskRecord } from '../domain/types'

export function ProductShell() {
  const index = useProductTaskStore((state) => state.index)
  const isLoading = useProductTaskStore((state) => state.isLoading)
  const error = useProductTaskStore((state) => state.error)
  const mutations = useProductTaskStore((state) => state.mutations)
  const refresh = useProductTaskStore((state) => state.refresh)
  const createTask = useProductTaskStore((state) => state.createTask)
  const renameTask = useProductTaskStore((state) => state.renameTask)
  const pinTask = useProductTaskStore((state) => state.pinTask)
  const unpinTask = useProductTaskStore((state) => state.unpinTask)
  const archiveTask = useProductTaskStore((state) => state.archiveTask)
  const restoreTask = useProductTaskStore((state) => state.restoreTask)
  const continueTask = useProductTaskStore((state) => state.continueTask)
  const refreshSessions = useSessionStore((state) => state.fetchSessions)
  const openTab = useTabStore((state) => state.openTab)

  const openTask = (task: ProductTaskRecord) => {
    openTab(task.coreSessionId, task.title, 'session')
  }

  const createAndOpenTask = async (input: CreateProductTaskInput, initialText?: string) => (
    launchProductTask({
      createTask,
      refreshSessions,
      openTask,
      connectToSession: (sessionId) => useChatStore.getState().connectToSession(sessionId),
      sendMessage: (sessionId, content) => useChatStore.getState().sendMessage(sessionId, content),
    }, input, initialText)
  )

  const continueAndOpenTask = async (...args: Parameters<typeof continueTask>) => {
    const task = await continueTask(...args)
    await refreshSessions()
    openTask(task)
    return task
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-app-main)]" data-testid="product-shell">
      <TaskIndex
        index={index}
        isLoading={isLoading}
        error={error}
        mutations={mutations}
        onRefresh={refresh}
        onCreateTask={createAndOpenTask}
        onRenameTask={renameTask}
        onPinTask={pinTask}
        onUnpinTask={unpinTask}
        onArchiveTask={archiveTask}
        onRestoreTask={restoreTask}
        onContinueTask={continueAndOpenTask}
        onOpenTask={openTask}
      />
    </main>
  )
}
