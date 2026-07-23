import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { shouldSubmitOnEnter } from '../../components/chat/sendShortcut'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  PRODUCT_TASK_SAFE_ERROR_LABEL,
  canSendProductTaskText,
  useProductTaskRuntimeStore,
} from '../stores/productTaskRuntimeStore'
import type { ProductTaskRecord } from '../domain/types'
import {
  productSideTaskMutationKey,
  useProductSideTaskStore,
} from '../stores/productSideTaskStore'
import {
  ProductTaskApprovalCard,
  ProductTaskThreadEntryView,
} from './ProductTaskPage'

const EMPTY_SIDE_TASKS: [] = []

export type SideTaskPanelProps = {
  parentTask: ProductTaskRecord
}

/**
 * A side task is rendered through the same restricted product-task stream as
 * its parent. The browser only knows the public `taskId`; its Core session
 * binding stays in the server-side product store.
 */
export function SideTaskPanel({ parentTask }: SideTaskPanelProps) {
  const t = useTranslation()
  const parentTaskId = parentTask.id
  const sideTasks = useProductSideTaskStore(
    (state) => state.sideTasksByParentTaskId[parentTaskId] ?? EMPTY_SIDE_TASKS,
  )
  const isLoading = useProductSideTaskStore(
    (state) => state.loadingByParentTaskId[parentTaskId] === true,
  )
  const error = useProductSideTaskStore((state) => state.errorsByParentTaskId[parentTaskId])
  const mutations = useProductSideTaskStore((state) => state.mutations)
  const panel = useProductSideTaskStore((state) => state.panelByParentTaskId[parentTaskId])
  const refreshSideTasks = useProductSideTaskStore((state) => state.refreshSideTasks)
  const closeSideTask = useProductSideTaskStore((state) => state.closeSideTask)
  const closeSideTaskPanel = useProductSideTaskStore((state) => state.closeSideTaskPanel)
  const selectSideTask = useProductSideTaskStore((state) => state.selectSideTask)
  const connectTask = useProductTaskRuntimeStore((state) => state.connectTask)
  const disconnectTask = useProductTaskRuntimeStore((state) => state.disconnectTask)
  const sendText = useProductTaskRuntimeStore((state) => state.sendText)
  const stopTask = useProductTaskRuntimeStore((state) => state.stopTask)
  const respondToApproval = useProductTaskRuntimeStore((state) => state.respondToApproval)
  const respondToQuestions = useProductTaskRuntimeStore((state) => state.respondToQuestions)
  const respondToComputerUseApproval = useProductTaskRuntimeStore((state) => state.respondToComputerUseApproval)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isOpen = panel?.isOpen === true

  const openSideTasks = useMemo(
    () => sideTasks.filter((sideTask) => sideTask.status === 'open'),
    [sideTasks],
  )
  const selectedSideTask = useMemo(
    () => openSideTasks.find((sideTask) => sideTask.id === panel?.selectedSideTaskId)
      ?? openSideTasks[0]
      ?? null,
    [openSideTasks, panel?.selectedSideTaskId],
  )
  const selectedSideTaskId = selectedSideTask?.id
  const selectedTaskId = selectedSideTask?.taskId
  const runtime = useProductTaskRuntimeStore((state) => (
    selectedTaskId ? state.tasks[selectedTaskId] : undefined
  ))
  const isClosingSelectedSideTask = selectedSideTaskId
    ? mutations[productSideTaskMutationKey(parentTaskId, selectedSideTaskId, 'close')] === true
    : false

  useEffect(() => {
    if (!isOpen) return
    void refreshSideTasks(parentTaskId)
  }, [isOpen, parentTaskId, refreshSideTasks])

  useEffect(() => {
    if (!isOpen || !selectedSideTask || !selectedTaskId) return
    if (panel?.selectedSideTaskId !== selectedSideTask.id) {
      selectSideTask(parentTaskId, selectedSideTask.id)
    }
    void connectTask(selectedTaskId)
    return () => disconnectTask(selectedTaskId)
  }, [
    connectTask,
    disconnectTask,
    isOpen,
    panel?.selectedSideTaskId,
    parentTaskId,
    selectSideTask,
    selectedSideTask,
    selectedTaskId,
  ])

  useEffect(() => {
    setDraft('')
    setSendError(null)
    setIsSubmitting(false)
  }, [selectedTaskId])

  if (!isOpen) return null

  const handleCloseSelectedSideTask = async () => {
    if (!selectedSideTask || !selectedTaskId || isClosingSelectedSideTask) return

    try {
      disconnectTask(selectedTaskId)
      await closeSideTask(parentTaskId, selectedSideTask.id)

      const remainingOpenSideTasks = useProductSideTaskStore.getState()
        .sideTasksByParentTaskId[parentTaskId]
        ?.filter((sideTask) => sideTask.status === 'open' && sideTask.id !== selectedSideTask.id)
        ?? []

      if (remainingOpenSideTasks[0]) {
        selectSideTask(parentTaskId, remainingOpenSideTasks[0].id)
      } else {
        closeSideTaskPanel(parentTaskId)
      }
    } catch {
      // The side-task store retains the safe server error for this panel.
    }
  }

  const submit = async () => {
    if (isSubmitting) return
    if (!selectedTaskId || !canSendProductTaskText(draft)) {
      setSendError('请输入要继续处理的内容。')
      return
    }
    setIsSubmitting(true)
    let accepted = false
    try {
      accepted = await sendText(selectedTaskId, draft)
    } finally {
      setIsSubmitting(false)
    }
    if (!accepted) {
      setSendError('暂时无法发送这条内容，请稍后重试。')
      return
    }
    setDraft('')
    setSendError(null)
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!shouldSubmitOnEnter(event, chatSendBehavior)) return
    event.preventDefault()
    void submit()
  }

  return (
    <section
      data-testid="side-task-panel"
      aria-label={t('sideTask.title')}
      className="mx-4 mb-3 flex max-h-[min(52vh,640px)] min-h-0 shrink-0 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-3 py-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('sideTask.title')}</h2>
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">{t('sideTask.description')}</p>
        </div>
        <button
          type="button"
          aria-label={t('sideTask.closePanel')}
          title={t('sideTask.closePanel')}
          onClick={() => closeSideTaskPanel(parentTaskId)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
        </button>
      </header>

      {error ? (
        <div role="alert" className="mx-3 mt-3 rounded-lg border border-[var(--color-error)]/30 px-3 py-2 text-xs text-[var(--color-error)]">
          {error}
        </div>
      ) : null}

      {openSideTasks.length > 0 ? (
        <div role="tablist" aria-label={t('sideTask.openList')} className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-2 py-2">
          {openSideTasks.map((sideTask) => {
            const isSelected = sideTask.id === selectedSideTaskId
            return (
              <button
                key={sideTask.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                onClick={() => selectSideTask(parentTaskId, sideTask.id)}
                className={`max-w-[240px] shrink-0 truncate rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  isSelected
                    ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
                title={sideTask.title}
              >
                {sideTask.title}
              </button>
            )
          })}
        </div>
      ) : null}

      {isLoading && openSideTasks.length === 0 ? (
        <div role="status" className="flex min-h-28 items-center justify-center px-4 py-8 text-sm text-[var(--color-text-secondary)]">
          {t('sideTask.loading')}
        </div>
      ) : selectedSideTask && selectedTaskId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2">
            <p className="min-w-0 truncate text-sm font-medium text-[var(--color-text-primary)]" title={selectedSideTask.title}>
              {selectedSideTask.title}
            </p>
            <div className="flex shrink-0 gap-2">
              {runtime?.runState === 'working' || runtime?.runState === 'awaiting_approval' ? (
                <button type="button" onClick={() => stopTask(selectedTaskId)} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]">停止</button>
              ) : null}
              <button
                type="button"
                aria-label={t('sideTask.closeSelected', { title: selectedSideTask.title })}
                title={t('sideTask.closeTask')}
                onClick={() => void handleCloseSelectedSideTask()}
                disabled={isClosingSelectedSideTask}
                className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-wait disabled:opacity-50"
              >
                {isClosingSelectedSideTask ? t('sideTask.closing') : t('sideTask.closeTask')}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {runtime?.historyStatus === 'loading' && runtime.entries.length === 0 ? <p role="status" className="py-6 text-center text-xs text-[var(--color-text-tertiary)]">正在读取侧边任务…</p> : null}
            {runtime?.historyStatus === 'error' && runtime.entries.length === 0 ? <p role="alert" className="py-6 text-center text-xs text-[var(--color-error)]">侧边任务记录暂时无法读取。</p> : null}
            {runtime?.entries.map((entry) => (
              <div key={entry.id} className="mb-3">
                <ProductTaskThreadEntryView
                  taskId={selectedTaskId}
                  entry={entry}
                  streaming={entry.id === runtime.streamingEntryId}
                />
              </div>
            ))}
            {runtime?.pendingApproval ? (
              <ProductTaskApprovalCard
                approval={runtime.pendingApproval}
                responding={runtime.approvalResponsePending}
                onRespondToAction={(allowed) => { void respondToApproval(selectedTaskId, allowed) }}
                onRespondToQuestions={(answers) => { void respondToQuestions(selectedTaskId, answers) }}
                onRespondToComputerUse={(allowed) => { void respondToComputerUseApproval(selectedTaskId, allowed) }}
              />
            ) : null}
            {runtime?.error ? <p role="alert" className="mt-3 text-xs text-[var(--color-error)]">{PRODUCT_TASK_SAFE_ERROR_LABEL[runtime.error.code]}</p> : null}
          </div>

          <form onSubmit={onSubmit} className="shrink-0 border-t border-[var(--color-border)] p-3">
            <textarea
              aria-label="继续侧边任务"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              className="block w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-app-main)] px-2.5 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
              placeholder="继续处理这个分支…"
            />
            {sendError ? <p role="alert" className="mt-1 text-xs text-[var(--color-error)]">{sendError}</p> : null}
            <div className="mt-2 flex justify-end">
              <button type="submit" disabled={isSubmitting} className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{isSubmitting ? '发送中…' : '发送'}</button>
            </div>
          </form>
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-[var(--color-text-secondary)]">{t('sideTask.empty')}</p>
      )}
    </section>
  )
}
