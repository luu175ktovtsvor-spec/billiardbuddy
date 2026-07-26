import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  productRecentProjectsApi,
  type ProductRecentProject,
} from '../../product/api/projects'
import { useTranslation } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import {
  getCachedRecentProjects,
  invalidateRecentProjectsCache,
  setCachedRecentProjects,
} from '../../lib/recentProjectsCache'

type Props = {
  value: string
  onChange: (path: string) => void
  variant?: 'chip' | 'workbar'
  isGitProject?: boolean
}

const DESKTOP_WORKTREE_MARKER = '/.BilliardBuddy/worktrees/'
const DROPDOWN_WIDTH = 400
const DROPDOWN_VIEWPORT_MARGIN = 12
const DROPDOWN_HEIGHT = 380 // approximate max height

function projectNameFromPath(filePath: string) {
  const displayRoot = filePath.includes(DESKTOP_WORKTREE_MARKER)
    ? filePath.slice(0, filePath.indexOf(DESKTOP_WORKTREE_MARKER))
    : filePath
  return displayRoot.split('/').filter(Boolean).pop() || filePath
}

export function DirectoryPicker({ value, onChange, variant = 'chip', isGitProject = false }: Props) {
  const t = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [projects, setProjects] = useState<ProductRecentProject[]>([])
  const [loading, setLoading] = useState(false)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number; direction: 'up' | 'down' } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const updateDropdownPos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceAbove = rect.top
    const spaceBelow = window.innerHeight - rect.bottom
    const direction = spaceBelow >= DROPDOWN_HEIGHT || spaceBelow >= spaceAbove ? 'down' : 'up'
    const width = Math.min(DROPDOWN_WIDTH, Math.max(0, window.innerWidth - DROPDOWN_VIEWPORT_MARGIN * 2))
    const maxLeft = Math.max(DROPDOWN_VIEWPORT_MARGIN, window.innerWidth - width - DROPDOWN_VIEWPORT_MARGIN)
    const left = Math.min(Math.max(rect.left, DROPDOWN_VIEWPORT_MARGIN), maxLeft)
    setDropdownPos({
      top: direction === 'down' ? rect.bottom + 4 : rect.top - 4,
      left,
      width,
      direction,
    })
  }, [])

  // Close on outside click (checks both trigger and portal dropdown)
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  // Recalculate position on scroll/resize while open
  useEffect(() => {
    if (!isOpen) return
    updateDropdownPos()
    window.addEventListener('scroll', updateDropdownPos, true)
    window.addEventListener('resize', updateDropdownPos)
    return () => {
      window.removeEventListener('scroll', updateDropdownPos, true)
      window.removeEventListener('resize', updateDropdownPos)
    }
  }, [isOpen, updateDropdownPos])

  // Load recent projects when opened (with client-side cache)
  useEffect(() => {
    if (!isOpen) return
    // Use cache if fresh
    const cachedProjects = getCachedRecentProjects()
    if (cachedProjects) {
      setProjects(cachedProjects)
      return
    }
    setLoading(true)
    productRecentProjectsApi.list()
      .then(({ projects: p }) => {
        setCachedRecentProjects(p)
        setProjects(p)
      })
      .catch(() => setProjects([]))
      .finally(() => setLoading(false))
  }, [isOpen])

  const handleSelect = (path: string) => {
    onChange(path)
    setIsOpen(false)
    // Invalidate cache so next open reflects the new selection
    invalidateRecentProjectsCache()
  }

  const handleChooseFolder = async () => {
    const host = getDesktopHost()
    if (host.isDesktop && host.capabilities.dialogs) {
      // Desktop: native OS folder dialog
      setIsOpen(false)
      try {
        const selected = await host.dialogs.open({
          directory: true,
          multiple: false,
          title: t('dirPicker.chooseProjectFolder'),
        })
        if (typeof selected === 'string' && selected.length > 0) onChange(selected)
      } catch (err) {
        console.error('[DirectoryPicker] Failed to open folder dialog:', err)
      }
    }
  }

  // Find selected project info
  const selectedProject = projects.find((p) => p.realPath === value)
  const isWorkbar = variant === 'workbar'
  const canChooseFolder = getDesktopHost().isDesktop && getDesktopHost().capabilities.dialogs
  const selectedLabel = selectedProject?.repoName || selectedProject?.projectName || projectNameFromPath(value)
  const showGitIcon = selectedProject?.isGit || isGitProject
  const triggerClassName = isWorkbar
    ? 'inline-flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-[7px] border border-transparent px-2.5 text-[13px] font-medium leading-none text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-container-lowest)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35'
    : 'flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-container-low)] hover:bg-[var(--color-surface-hover)] rounded-full text-xs transition-colors border border-[var(--color-border)]'
  const emptyTriggerClassName = isWorkbar
    ? 'flex h-9 min-w-0 items-center gap-1.5 rounded-[7px] border border-transparent px-2.5 text-[13px] font-medium leading-none text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-container-lowest)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35'
    : 'flex items-center gap-2 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors'

  const dropdownClassName = 'overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-dropdown)]'
  const dropdownStyle = {
    position: 'fixed' as const,
    left: dropdownPos?.left,
    width: dropdownPos?.width,
    ...(dropdownPos?.direction === 'down'
      ? { top: dropdownPos.top }
      : { bottom: window.innerHeight - (dropdownPos?.top ?? 0) }),
    zIndex: 9999,
  }
  const dropdownContent = (
    <>
      <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-outline)]">
        {t('dirPicker.recent')}
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {loading ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--color-text-tertiary)]">{t('common.loading')}</div>
        ) : projects.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[var(--color-text-tertiary)]">{t('dirPicker.noRecent')}</div>
        ) : (
          projects.map((project) => {
            const isSelected = project.realPath === value
            return (
              <button
                key={project.projectPath}
                onClick={() => handleSelect(project.realPath)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${
                  isSelected ? 'bg-[var(--color-surface-selected)]' : ''
                }`}
              >
                {project.isGit ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                    <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
                    <path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
                  </svg>
                ) : (
                  <span className="material-symbols-outlined flex-shrink-0 text-[20px] text-[var(--color-text-secondary)]">folder</span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">
                    {project.repoName || project.projectName}
                  </div>
                  <div className="truncate font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
                    {project.realPath}
                  </div>
                </div>
                {isSelected && (
                  <span className="material-symbols-outlined flex-shrink-0 text-[18px] text-[var(--color-brand)]" style={{ fontVariationSettings: "'FILL' 1" }}>
                    check
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
      {canChooseFolder ? (
        <div className="border-t border-[var(--color-border)]">
          <button
            onClick={handleChooseFolder}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          >
            <span className="material-symbols-outlined text-[20px] text-[var(--color-text-tertiary)]">create_new_folder</span>
            <span className="text-sm text-[var(--color-text-secondary)]">{t('dirPicker.chooseFolder')}</span>
          </button>
        </div>
      ) : null}
    </>
  )

  return (
    <div ref={ref} className={isWorkbar ? 'relative max-w-[320px] shrink min-w-0' : 'relative'}>
      {/* Trigger — shows selected project chip or placeholder */}
      {value ? (
        <button
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={triggerClassName}
          title={value}
        >
          {showGitIcon ? (
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 text-[var(--color-text-secondary)]">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          ) : (
            <span className={`material-symbols-outlined shrink-0 ${isWorkbar ? 'text-[17px]' : 'text-[14px]'} text-[var(--color-text-secondary)]`}>folder</span>
          )}
          <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">
            {selectedLabel}
          </span>
          <span className={`${isWorkbar ? 'text-[15px]' : 'text-[12px]'} material-symbols-outlined shrink-0 text-[var(--color-text-tertiary)]`}>expand_more</span>
        </button>
      ) : (
        <button
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={emptyTriggerClassName}
          title={t('dirPicker.selectProject')}
        >
          <span className={`material-symbols-outlined shrink-0 ${isWorkbar ? 'text-[17px]' : 'text-[14px]'}`}>folder_open</span>
          <span className="min-w-0 truncate">{t('dirPicker.selectProject')}</span>
        </button>
      )}

      {isOpen && dropdownPos && createPortal(
          <div
            ref={dropdownRef}
            data-testid="directory-picker-menu"
            className={dropdownClassName}
            style={dropdownStyle}
          >
            {dropdownContent}
          </div>,
          document.body,
        )}
    </div>
  )
}
