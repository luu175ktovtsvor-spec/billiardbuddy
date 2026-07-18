import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { useTabStore } from '../../stores/tabStore'
import type { ProductProject, ProductTaskRecord } from '../domain/types'
import { useProductTaskStore } from '../stores/productTaskStore'

const RECENT_LIMIT = 8
const SEARCH_LIMIT = 50

type TaskSearchModalProps = {
  open: boolean
  onClose: () => void
}

type TaskSearchResult = {
  task: ProductTaskRecord
  project: ProductProject | undefined
}

function updatedAtDescending(left: ProductTaskRecord, right: ProductTaskRecord): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

function matchesTask(result: TaskSearchResult, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true

  return [
    result.task.title,
    result.task.workDir,
    result.project?.title,
    result.project?.workDir,
    result.task.lifecycle,
  ].some((value) => value?.toLocaleLowerCase().includes(normalized))
}

export function TaskSearchModal({ open, onClose }: TaskSearchModalProps) {
  const t = useTranslation()
  const index = useProductTaskStore((state) => state.index)
  const isLoading = useProductTaskStore((state) => state.isLoading)
  const error = useProductTaskStore((state) => state.error)
  const refresh = useProductTaskStore((state) => state.refresh)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return

    setQuery('')
    setActiveIndex(0)
    void refresh()

    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open, refresh])

  const results = useMemo<TaskSearchResult[]>(() => {
    const projectsById = new Map(index.projects.map((project) => [project.id, project]))
    const limit = query.trim() ? SEARCH_LIMIT : RECENT_LIMIT
    return [...index.tasks]
      .sort(updatedAtDescending)
      .map((task) => ({ task, project: projectsById.get(task.projectId) }))
      .filter((result) => matchesTask(result, query))
      .slice(0, limit)
  }, [index.projects, index.tasks, query])

  const isSearching = query.trim().length > 0

  const openTask = (result: TaskSearchResult) => {
    useTabStore.getState().openTab(result.task.coreSessionId, result.task.title, 'session')
    useChatStore.getState().connectToSession(result.task.coreSessionId)
    onClose()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const active = results[activeIndex]
      if (active) openTask(active)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]" data-testid="task-search-modal">
      <button
        type="button"
        aria-label={t('search.global.close')}
        className="absolute inset-0 cursor-default bg-[var(--color-overlay-scrim)]"
        onClick={onClose}
      />
      <section
        className="glass-panel relative z-10 flex max-h-[70vh] w-[640px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[var(--radius-xl)]"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.global.trigger')}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('search.global.placeholder')}
            aria-label={t('search.global.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
          {isLoading ? (
            <span className="material-symbols-outlined animate-spin text-[16px] text-[var(--color-text-tertiary)]" aria-label={t('search.global.loading')}>
              progress_activity
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('search.global.close')}
            title={t('search.global.close')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1.5" role="listbox">
          {!isSearching && results.length > 0 ? (
            <div className="px-4 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)]">
              {t('search.global.recentTitle')}
            </div>
          ) : null}

          {isLoading && results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">{t('search.global.loading')}</div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-error)]">{t('search.global.error')}</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[var(--color-text-tertiary)]">{t('search.global.noResults')}</div>
          ) : (
            results.map((result, index) => (
              <TaskSearchRow
                key={result.task.id}
                result={result}
                active={index === activeIndex}
                onActivate={() => setActiveIndex(index)}
                onOpen={() => openTask(result)}
              />
            ))
          )}
        </div>
      </section>
    </div>,
    document.body,
  )
}

function TaskSearchRow({
  result,
  active,
  onActivate,
  onOpen,
}: {
  result: TaskSearchResult
  active: boolean
  onActivate: () => void
  onOpen: () => void
}) {
  const t = useTranslation()
  const project = result.project?.title || t('search.global.unassignedProject')
  const workDir = result.task.workDir || result.project?.workDir || '—'
  const lifecycle = result.task.lifecycle === 'archived'
    ? t('search.global.archived')
    : t('search.global.active')

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseEnter={onActivate}
      onClick={onOpen}
      className={`flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors focus-visible:outline-none ${
        active ? 'bg-[var(--color-surface-hover)]' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text-primary)]">{result.task.title}</span>
        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
          {lifecycle}
        </span>
      </div>
      <div className="min-w-0 truncate text-[11px] text-[var(--color-text-secondary)]">
        {t('search.global.project')}: {project}
      </div>
      <div className="min-w-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
        {t('search.global.workDir')}: {workDir}
      </div>
    </button>
  )
}
