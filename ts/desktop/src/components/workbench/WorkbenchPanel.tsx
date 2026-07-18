import { FolderOpen, Globe, Maximize2, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  useWorkspacePanelStore,
  type WorkbenchMode,
} from '../../stores/workspacePanelStore'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useTabStore } from '../../stores/tabStore'
import { WorkspacePanel } from '../workspace/WorkspacePanel'
import { BrowserSurface } from '../browser/BrowserSurface'

type WorkbenchPanelProps = {
  sessionId: string
  variant?: 'panel' | 'tab'
  onClose?: () => void
}

const MODE_ITEMS: ReadonlyArray<{
  mode: WorkbenchMode
  labelKey: 'workbench.modeWorkspace' | 'workbench.modeBrowser'
  Icon: typeof FolderOpen
}> = [
  { mode: 'workspace', labelKey: 'workbench.modeWorkspace', Icon: FolderOpen },
  { mode: 'browser', labelKey: 'workbench.modeBrowser', Icon: Globe },
]

/**
 * Right-side task dock. The file workspace and browser each retain their own
 * open state; the mode switch merely selects which open panel occupies the
 * shared dock, so they never squeeze the task thread side-by-side.
 */
export function WorkbenchPanel({ sessionId, variant = 'panel', onClose }: WorkbenchPanelProps) {
  const t = useTranslation()
  const mode = useWorkspacePanelStore((state) => state.getMode(sessionId))
  const setMode = useWorkspacePanelStore((state) => state.setMode)
  const workspaceOpen = useWorkspacePanelStore((state) => state.isPanelOpen(sessionId))
  const closePanel = useWorkspacePanelStore((state) => state.closePanel)
  const ensureBlankBrowser = useBrowserPanelStore((state) => state.ensureBlank)
  const browserOpen = useBrowserPanelStore((state) => state.bySession[sessionId]?.isOpen ?? false)
  const closeBrowser = useBrowserPanelStore((state) => state.close)
  const isTabVariant = variant === 'tab'
  const activeMode: WorkbenchMode = isTabVariant
    ? mode
    : mode === 'browser' && browserOpen
      ? 'browser'
      : mode === 'workspace' && workspaceOpen
        ? 'workspace'
        : browserOpen
          ? 'browser'
          : 'workspace'

  const handleModeSelect = (nextMode: WorkbenchMode) => {
    if (nextMode === 'browser') {
      ensureBlankBrowser(sessionId)
    } else if (!isTabVariant) {
      useWorkspacePanelStore.getState().openPanel(sessionId)
    }
    setMode(sessionId, nextMode)
  }

  const handleExpand = () => {
    useTabStore.getState().openWorkbenchTab(sessionId, t('workbench.tabTitle'))
  }

  const handleClose = () => {
    if (onClose) {
      onClose()
      return
    }
    if (activeMode === 'browser') {
      closeBrowser(sessionId)
      return
    }
    closePanel(sessionId)
    if (browserOpen) {
      setMode(sessionId, 'browser')
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-app-main)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-app-main)] px-2">
        <div
          role="tablist"
          aria-label={t('workbench.modeSwitch')}
          className="inline-flex items-center gap-0.5"
        >
          {MODE_ITEMS.map(({ mode: itemMode, labelKey, Icon }) => {
            const isActive = activeMode === itemMode
            return (
              <button
                key={itemMode}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleModeSelect(itemMode)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35 ${
                  isActive
                    ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                <Icon size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                <span>{t(labelKey)}</span>
              </button>
            )
          })}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!isTabVariant && (
            <button
              type="button"
              aria-label={t('workbench.expand')}
              title={t('workbench.expand')}
              onClick={handleExpand}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
            >
              <Maximize2 size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            aria-label={t('workbench.close')}
            onClick={handleClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/35"
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {activeMode === 'browser' ? (
          <BrowserSurface sessionId={sessionId} />
        ) : (
          <WorkspacePanel sessionId={sessionId} embedded forceVisible={isTabVariant} />
        )}
      </div>
    </div>
  )
}
