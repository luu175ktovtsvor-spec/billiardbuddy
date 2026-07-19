import { useEffect } from 'react'
import { Globe2, MonitorPlay, X } from 'lucide-react'
import {
  BrowserSurface,
} from '../../components/browser/BrowserSurface'
import { getDesktopHost } from '../../lib/desktopHost'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import {
  productTaskBrowserPreviewKey,
  type ProductTaskBrowserPreviewMode,
} from '../stores/productTaskBrowserPreviewStore'

type ProductTaskBrowserPreviewDockProps = {
  taskId: string
  browserOpen: boolean
  previewOpen: boolean
  activeMode: ProductTaskBrowserPreviewMode | null
  onActivate: (mode: ProductTaskBrowserPreviewMode) => void
  onClose: (mode: ProductTaskBrowserPreviewMode) => void
}

const MODE_META: Record<ProductTaskBrowserPreviewMode, {
  label: string
  title: string
  Icon: typeof Globe2
  boundary: string
  unsupportedNavigationMessage: string
}> = {
  browser: {
    label: '浏览器',
    title: '浏览器',
    Icon: Globe2,
    boundary: '仅显示你手动输入的 HTTP(S) 地址；不会自动打开任务中的文件或其他链接。',
    unsupportedNavigationMessage: '浏览器仅支持手动输入 HTTP(S) 地址。',
  },
  preview: {
    label: '预览',
    title: '预览',
    Icon: MonitorPlay,
    boundary: '请输入已启动的 HTTP(S) 预览地址，例如 http://localhost:3000；不会读取任务中的文件路径。',
    unsupportedNavigationMessage: '预览仅支持手动输入 HTTP(S) 地址，例如 http://localhost:3000。',
  },
}

function resolveVisibleMode(
  activeMode: ProductTaskBrowserPreviewMode | null,
  browserOpen: boolean,
  previewOpen: boolean,
): ProductTaskBrowserPreviewMode | null {
  if (activeMode === 'browser' && browserOpen) return 'browser'
  if (activeMode === 'preview' && previewOpen) return 'preview'
  if (browserOpen) return 'browser'
  if (previewOpen) return 'preview'
  return null
}

/**
 * Product-owned Browser and Preview dock. Its persistent keys derive only from
 * the public task id; no Core session id, worktree path, or tool URL crosses
 * this boundary. The native host is a singleton, so only the selected open
 * mode mounts a surface while both panel open states remain independent.
 */
export function ProductTaskBrowserPreviewDock({
  taskId,
  browserOpen,
  previewOpen,
  activeMode,
  onActivate,
  onClose,
}: ProductTaskBrowserPreviewDockProps) {
  const visibleMode = resolveVisibleMode(activeMode, browserOpen, previewOpen)
  const host = getDesktopHost()
  const canUsePreviewHost = host.isDesktop && host.capabilities.previewWebview
  const browserKey = visibleMode ? productTaskBrowserPreviewKey(taskId, visibleMode) : null
  const meta = visibleMode ? MODE_META[visibleMode] : null

  useEffect(() => {
    if (!canUsePreviewHost || !browserKey) return
    useBrowserPanelStore.getState().ensureBlank(browserKey)
  }, [browserKey, canUsePreviewHost])

  if (!visibleMode || !meta || !browserKey) return null

  const handleClose = () => {
    onClose(visibleMode)
  }

  const renderModeTab = (mode: ProductTaskBrowserPreviewMode) => {
    const isOpen = mode === 'browser' ? browserOpen : previewOpen
    const isActive = visibleMode === mode
    const modeMeta = MODE_META[mode]
    const Icon = modeMeta.Icon
    return (
      <button
        key={mode}
        type="button"
        role="tab"
        aria-selected={isActive}
        disabled={!isOpen}
        onClick={() => onActivate(mode)}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-40 ${
          isActive
            ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
      >
        <Icon size={14} aria-hidden="true" />
        {modeMeta.label}
      </button>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="product-task-browser-preview-dock">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <div role="tablist" aria-label="Browser 与 Preview" className="inline-flex items-center gap-1">
          {renderModeTab('browser')}
          {renderModeTab('preview')}
        </div>
        <button
          type="button"
          aria-label={`关闭${meta.title}`}
          onClick={handleClose}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <p className="shrink-0 border-b border-[var(--color-border)] px-3 py-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
        {meta.boundary}
      </p>

      {canUsePreviewHost ? (
        <div className="min-h-0 flex-1">
          <BrowserSurface
            key={browserKey}
            sessionId={browserKey}
            navigationPolicy="http"
            unsupportedNavigationMessage={meta.unsupportedNavigationMessage}
            showPreviewActions={false}
          />
        </div>
      ) : (
        <p role="status" className="p-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          当前环境不支持内置 Browser/Preview。请在 macOS 或 Windows 桌面应用中使用。
        </p>
      )}
    </section>
  )
}
