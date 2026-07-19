import { useEffect, useMemo } from 'react'
import { TaskComposer, TaskIndex } from './TaskIndex'
import { useProductTaskStore } from '../stores/productTaskStore'
import { useSessionStore } from '../../stores/sessionStore'
import {
  NEW_PRODUCT_TASK_TAB_ID,
  PRODUCT_TASKS_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import {
  continueProductTask,
  launchProductTask,
  type ProductTaskInitialMessage,
} from '../taskLaunch'
import type { CreateProductTaskInput, ProductTaskRecord } from '../domain/types'
import { getProductTaskRuntimeState } from '../taskRuntime'

type ProductShellProps = {
  page?: 'task-index' | 'new-task'
  initialWorkDir?: string
}

export function ProductShell({ page = 'task-index', initialWorkDir }: ProductShellProps) {
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
  const openNewProductTask = useTabStore((state) => state.openNewProductTask)
  const closeTab = useTabStore((state) => state.closeTab)
  const tabs = useTabStore((state) => state.tabs)
  const chatSessions = useChatStore((state) => state.sessions)
  const sessionTabStatuses = useMemo(() => new Map(
    tabs
      .filter((tab) => tab.type === 'session')
      .map((tab) => [tab.sessionId, tab.status]),
  ), [tabs])
  const runtimeStatesBySessionId = useMemo(() => Object.fromEntries(
    index.tasks.map((task) => [
      task.id,
      getProductTaskRuntimeState(chatSessions[task.id], sessionTabStatuses.get(task.id)),
    ]),
  ), [chatSessions, index.tasks, sessionTabStatuses])

  const openTaskTab = (task: ProductTaskRecord) => {
    openTab(task.id, task.title, 'session')
  }

  const connectToTaskSession = (sessionId: string) => {
    useChatStore.getState().connectToSession(sessionId)
  }

  const openExistingTask = (task: ProductTaskRecord) => {
    openTaskTab(task)
    connectToTaskSession(task.id)
  }

  const openTaskWorkbench = (task: ProductTaskRecord) => {
    openExistingTask(task)
    const workspace = useWorkspacePanelStore.getState()
    workspace.setMode(task.id, 'workspace')
    workspace.openPanel(task.id)
  }

  const openTaskTerminal = (task: ProductTaskRecord) => {
    openExistingTask(task)
    useTerminalPanelStore.getState().openPanel(task.id)
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

  const continueAndOpenTask = async (...args: Parameters<typeof continueTask>) => continueProductTask({
    continueTask,
    refreshSessions,
    openTask: openTaskTab,
    connectToSession: connectToTaskSession,
  }, ...args)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const cancelNewTask = () => {
    openTab(PRODUCT_TASKS_TAB_ID, '任务中心', 'product-tasks')
    closeTab(NEW_PRODUCT_TASK_TAB_ID)
  }

  if (page === 'new-task') {
    return (
      <main className="flex h-full min-h-0 flex-col overflow-y-auto bg-[var(--color-app-main)]" data-testid="new-product-task-page">
        <header className="border-b border-[var(--color-border)] px-5 py-4">
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">新建任务</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">选择项目或工作目录后，说明希望完成的事情。</p>
        </header>
        {error ? <div role="alert" className="mx-5 mt-4 rounded-lg border border-[var(--color-error)]/30 px-3 py-2 text-sm text-[var(--color-error)]">{error}</div> : null}
        <TaskComposer
          key={initialWorkDir ?? 'manual'}
          projects={index.projects}
          initialWorkDir={initialWorkDir}
          isSubmitting={mutations.create === true}
          onCancel={cancelNewTask}
          onSubmit={async (input, initialMessage) => {
            try {
              await createAndOpenTask(input, initialMessage)
              closeTab(NEW_PRODUCT_TASK_TAB_ID)
            } catch {
              // The product store exposes the server error in this page.
            }
          }}
        />
      </main>
    )
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-app-main)]" data-testid="product-shell">
      <TaskIndex
        index={index}
        isLoading={isLoading}
        error={error}
        mutations={mutations}
        onRefresh={refresh}
        onRenameTask={renameTask}
        onPinTask={pinTask}
        onUnpinTask={unpinTask}
        onArchiveTask={archiveTask}
        onRestoreTask={restoreTask}
        onContinueTask={continueAndOpenTask}
        onRequestNewTask={() => openNewProductTask()}
        onOpenTask={openExistingTask}
        onOpenTaskWorkbench={openTaskWorkbench}
        onOpenTaskTerminal={openTaskTerminal}
        runtimeStatesBySessionId={runtimeStatesBySessionId}
      />
    </main>
  )
}
