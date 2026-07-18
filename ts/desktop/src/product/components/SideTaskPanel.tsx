import { useEffect, useMemo } from 'react'
import { ChatInput } from '../../components/chat/ChatInput'
import { MessageList } from '../../components/chat/MessageList'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import type { ProductTaskRecord } from '../domain/types'
import {
  productSideTaskMutationKey,
  useProductSideTaskStore,
} from '../stores/productSideTaskStore'

const EMPTY_SIDE_TASKS: [] = []

export type SideTaskPanelProps = {
  parentTask: ProductTaskRecord
}

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
  const selectedCoreSessionId = selectedSideTask?.coreSessionId
  const isClosingSelectedSideTask = selectedSideTaskId
    ? mutations[productSideTaskMutationKey(parentTaskId, selectedSideTaskId, 'close')] === true
    : false

  useEffect(() => {
    if (!isOpen) return
    void refreshSideTasks(parentTaskId)
  }, [isOpen, parentTaskId, refreshSideTasks])

  useEffect(() => {
    if (!isOpen || !selectedSideTaskId || !selectedCoreSessionId) return
    if (panel?.selectedSideTaskId !== selectedSideTaskId) {
      selectSideTask(parentTaskId, selectedSideTaskId)
    }
    useChatStore.getState().connectToSession(selectedCoreSessionId)
  }, [
    isOpen,
    panel?.selectedSideTaskId,
    parentTaskId,
    selectSideTask,
    selectedCoreSessionId,
    selectedSideTaskId,
  ])

  if (!isOpen) return null

  const handleCloseSelectedSideTask = async () => {
    if (!selectedSideTask || isClosingSelectedSideTask) return

    try {
      await closeSideTask(parentTaskId, selectedSideTask.id)
      useChatStore.getState().disconnectSession(selectedSideTask.coreSessionId)

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
      // The side-task store retains the server error for this panel.
    }
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
        <div
          role="tablist"
          aria-label={t('sideTask.openList')}
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--color-border)] px-2 py-2"
        >
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
      ) : selectedSideTask ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2">
            <p className="min-w-0 truncate text-sm font-medium text-[var(--color-text-primary)]" title={selectedSideTask.title}>
              {selectedSideTask.title}
            </p>
            <button
              type="button"
              aria-label={t('sideTask.closeSelected', { title: selectedSideTask.title })}
              title={t('sideTask.closeTask')}
              onClick={() => void handleCloseSelectedSideTask()}
              disabled={isClosingSelectedSideTask}
              className="shrink-0 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:cursor-wait disabled:opacity-50"
            >
              {isClosingSelectedSideTask ? t('sideTask.closing') : t('sideTask.closeTask')}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <MessageList
              sessionId={selectedSideTask.coreSessionId}
              compact
              enableProductActions={false}
            />
          </div>
          <ChatInput
            sessionId={selectedSideTask.coreSessionId}
            workDir={parentTask.workDir}
            compact
          />
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-sm text-[var(--color-text-secondary)]">{t('sideTask.empty')}</p>
      )}
    </section>
  )
}
