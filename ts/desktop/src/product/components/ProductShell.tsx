import { useEffect, useMemo } from 'react'
import { TaskComposer, TaskIndex } from './TaskIndex'
import { useProductTaskStore } from '../stores/productTaskStore'
import {
  NEW_PRODUCT_TASK_TAB_ID,
  PRODUCT_TASKS_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'
import { useProductTaskRuntimeStore } from '../stores/productTaskRuntimeStore'
import { continueProductTask } from '../taskLaunch'
import type { ProductTaskRecord } from '../domain/types'
import { getProductTaskRuntimeStateFromStream } from '../taskRuntime'

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
  const submitNewTask = useProductTaskStore((state) => state.submitNewTask)
  const renameTask = useProductTaskStore((state) => state.renameTask)
  const pinTask = useProductTaskStore((state) => state.pinTask)
  const unpinTask = useProductTaskStore((state) => state.unpinTask)
  const archiveTask = useProductTaskStore((state) => state.archiveTask)
  const restoreTask = useProductTaskStore((state) => state.restoreTask)
  const continueTask = useProductTaskStore((state) => state.continueTask)
  const openTab = useTabStore((state) => state.openTab)
  const openNewProductTask = useTabStore((state) => state.openNewProductTask)
  const openProductTaskTab = useTabStore((state) => state.openProductTaskTab)
  const closeTab = useTabStore((state) => state.closeTab)
  const taskRuntimes = useProductTaskRuntimeStore((state) => state.tasks)
  const runtimeStatesBySessionId = useMemo(() => Object.fromEntries(
    index.tasks.map((task) => [
      task.id,
      getProductTaskRuntimeStateFromStream(taskRuntimes[task.id]),
    ]),
  ), [index.tasks, taskRuntimes])

  const openTaskTab = (task: ProductTaskRecord) => {
    openProductTaskTab(task.id, task.title)
  }

  const openExistingTask = (task: ProductTaskRecord) => openTaskTab(task)

  const createAndOpenTask = async (input: { text: string; attachment_ids: string[] }) => {
    const task = await submitNewTask(input)
    openTaskTab(task)
    void useProductTaskRuntimeStore.getState().connectTask(task.id)
    return task
  }

  const continueAndOpenTask = async (...args: Parameters<typeof continueTask>) => continueProductTask({
    continueTask,
    openTask: openTaskTab,
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
        <header className="px-5 pb-1 pt-8 text-center">
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">今天想完成什么？</h1>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)]">描述目标，BilliardBuddy 会创建任务并开始处理。</p>
        </header>
        {error ? <div role="alert" className="mx-5 mt-4 rounded-lg border border-[var(--color-error)]/30 px-3 py-2 text-sm text-[var(--color-error)]">{error}</div> : null}
        {isLoading && !index.capabilities.createTask ? (
          <p role="status" className="py-12 text-center text-sm text-[var(--color-text-secondary)]">正在准备任务能力…</p>
        ) : index.capabilities.createTask ? (
          <TaskComposer
            key={initialWorkDir ?? 'automatic'}
            initialWorkDir={initialWorkDir}
            isSubmitting={mutations.create === true}
            onCancel={cancelNewTask}
            onSubmit={async (input) => {
              try {
                await createAndOpenTask(input)
                closeTab(NEW_PRODUCT_TASK_TAB_ID)
              } catch {
                // The product store exposes the server error in this page.
              }
            }}
          />
        ) : (
          <div className="mx-auto w-full max-w-lg px-5 py-12 text-center">
            <p className="text-sm text-[var(--color-text-secondary)]">当前安装暂时无法创建任务。</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-4 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
            >
              重新检查
            </button>
          </div>
        )}
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
        runtimeStatesBySessionId={runtimeStatesBySessionId}
      />
    </main>
  )
}
