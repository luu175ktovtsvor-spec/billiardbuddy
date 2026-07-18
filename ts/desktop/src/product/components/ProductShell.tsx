import { useEffect, useMemo } from 'react'
import { TaskIndex } from './TaskIndex'
import { useProductTaskStore } from '../stores/productTaskStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { launchProductTask, type ProductTaskInitialMessage } from '../taskLaunch'
import type { CreateProductTaskInput, ProductTaskRecord } from '../domain/types'
import { getProductTaskRuntimeState } from '../taskRuntime'

export function ProductShell() {
  const index = useProductTaskStore((state) => state.index)
  const isLoading = useProductTaskStore((state) => state.isLoading)
  const error = useProductTaskStore((state) => state.error)
  const mutations = useProductTaskStore((state) => state.mutations)
  const composerRequest = useProductTaskStore((state) => state.composerRequest)
  const refresh = useProductTaskStore((state) => state.refresh)
  const consumeTaskComposerRequest = useProductTaskStore((state) => state.consumeTaskComposerRequest)
  const createTask = useProductTaskStore((state) => state.createTask)
  const renameTask = useProductTaskStore((state) => state.renameTask)
  const pinTask = useProductTaskStore((state) => state.pinTask)
  const unpinTask = useProductTaskStore((state) => state.unpinTask)
  const archiveTask = useProductTaskStore((state) => state.archiveTask)
  const restoreTask = useProductTaskStore((state) => state.restoreTask)
  const continueTask = useProductTaskStore((state) => state.continueTask)
  const refreshSessions = useSessionStore((state) => state.fetchSessions)
  const openTab = useTabStore((state) => state.openTab)
  const tabs = useTabStore((state) => state.tabs)
  const chatSessions = useChatStore((state) => state.sessions)
  const sessionTabStatuses = useMemo(() => new Map(
    tabs
      .filter((tab) => tab.type === 'session')
      .map((tab) => [tab.sessionId, tab.status]),
  ), [tabs])
  const runtimeStatesBySessionId = useMemo(() => Object.fromEntries(
    index.tasks.map((task) => [
      task.coreSessionId,
      getProductTaskRuntimeState(chatSessions[task.coreSessionId], sessionTabStatuses.get(task.coreSessionId)),
    ]),
  ), [chatSessions, index.tasks, sessionTabStatuses])

  const openTaskTab = (task: ProductTaskRecord) => {
    openTab(task.coreSessionId, task.title, 'session')
  }

  const connectToTaskSession = (sessionId: string) => {
    useChatStore.getState().connectToSession(sessionId)
  }

  const openExistingTask = (task: ProductTaskRecord) => {
    openTaskTab(task)
    connectToTaskSession(task.coreSessionId)
  }

  const openTaskWorkbench = (task: ProductTaskRecord) => {
    openExistingTask(task)
    const workspace = useWorkspacePanelStore.getState()
    workspace.setMode(task.coreSessionId, 'workspace')
    workspace.openPanel(task.coreSessionId)
  }

  const openTaskTerminal = (task: ProductTaskRecord) => {
    openExistingTask(task)
    useTerminalPanelStore.getState().openPanel(task.coreSessionId)
  }

  const createAndOpenTask = async (input: CreateProductTaskInput, initialMessage?: ProductTaskInitialMessage) => (
    launchProductTask({
      createTask,
      refreshSessions,
      openTask: openTaskTab,
      connectToSession: connectToTaskSession,
      sendMessage: (sessionId, content, attachments) => useChatStore.getState().sendMessage(sessionId, content, attachments),
    }, input, initialMessage)
  )

  const continueAndOpenTask = async (...args: Parameters<typeof continueTask>) => {
    const task = await continueTask(...args)
    await refreshSessions()
    openExistingTask(task)
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
        onOpenTask={openExistingTask}
        onOpenTaskWorkbench={openTaskWorkbench}
        onOpenTaskTerminal={openTaskTerminal}
        runtimeStatesBySessionId={runtimeStatesBySessionId}
        composerRequest={composerRequest}
        onConsumeComposerRequest={consumeTaskComposerRequest}
      />
    </main>
  )
}
