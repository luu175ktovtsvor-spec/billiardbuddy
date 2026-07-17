import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { WorkspaceDiffSurface } from '../workspace/WorkspaceCodeSurface'
import type { WorkspacePreviewTab } from '../../stores/workspacePanelStore'

/**
 * 栏3 · 独立工作区列（Codex 四栏）：审阅/Diff/文件预览的 tab 宿主。
 * 消费现有 workspacePanelStore 的 previewTabs（数据零改）——栏4 点文件→openPreview 开 tab→这里显示。
 * Diff 复用 WorkspaceDiffSurface；文本/图片直接从 tab 自带的 content/dataUrl 渲染。
 * 切壳阶段（Phase C/D）与 WorkspacePanel 去重。
 */
const EMPTY_TABS: WorkspacePreviewTab[] = []

function Breadcrumb({ path }: { path: string }) {
  const segments = path.split('/')
  return (
    <div className="flex min-w-0 items-center gap-1 truncate text-[12px]">
      {segments.map((seg, i) => (
        <span key={`${seg}:${i}`} className="flex min-w-0 items-center gap-1">
          {i > 0 && <span className="text-[var(--color-text-tertiary)]">›</span>}
          <span className={`truncate ${i === segments.length - 1 ? 'font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
            {seg}
          </span>
        </span>
      ))}
    </div>
  )
}

function PreviewBody({ tab, loading }: { tab: WorkspacePreviewTab; loading: boolean }) {
  const state = tab.state ?? (loading ? 'loading' : 'ok')
  if (state === 'loading') {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-[var(--color-text-tertiary)]">加载中…</div>
  }
  if (state === 'error') {
    return <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-[var(--color-error)]">{tab.error || '加载失败'}</div>
  }
  if (tab.kind === 'diff') {
    return <WorkspaceDiffSurface value={tab.diff ?? ''} path={tab.path} />
  }
  if (tab.previewType === 'image' && tab.dataUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[var(--color-code-bg)] p-4">
        <img src={tab.dataUrl} alt={tab.title} className="max-h-full max-w-full object-contain" />
      </div>
    )
  }
  return (
    <pre className="min-h-0 flex-1 overflow-auto bg-[var(--color-code-bg)] px-4 py-3 font-mono text-[var(--color-code-fg)]" style={{ fontSize: 'var(--chat-code-font)' }}>
      {tab.content ?? ''}
    </pre>
  )
}

export function WorkspaceColumn({ sessionId }: { sessionId: string }) {
  const tabs = useWorkspacePanelStore((s) => s.previewTabsBySession[sessionId] ?? EMPTY_TABS)
  const activeTabId = useWorkspacePanelStore((s) => s.activePreviewTabIdBySession[sessionId] ?? null)
  const openPreview = useWorkspacePanelStore((s) => s.openPreview)
  const closePreview = useWorkspacePanelStore((s) => s.closePreview)
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[tabs.length - 1] ?? null
  const activeLoading = useWorkspacePanelStore((s) => (activeTabId ? s.loading.previewByTabId[`${sessionId}::${activeTabId}`] ?? false : false))

  if (tabs.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 bg-[var(--color-surface)] text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined text-[32px]">difference</span>
        <p className="text-xs">从文件树点开文件或变更,在此审阅</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      {/* tab 条 */}
      <div
        className="flex shrink-0 items-stretch overflow-x-auto border-b border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]"
        style={{ height: 'var(--h-toolbar-pane)' }}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTab?.id
          return (
            <div
              key={tab.id}
              className={`group flex shrink-0 items-center gap-1.5 border-r border-[var(--color-border)] pl-3 pr-1.5 text-[12px] transition-colors ${
                active
                  ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <button
                type="button"
                onClick={() => void openPreview(sessionId, tab.path, tab.kind)}
                className="max-w-[160px] truncate"
                title={tab.path}
              >
                {tab.kind === 'diff' && <span className="mr-1 text-[var(--color-text-tertiary)]">±</span>}
                {tab.title}
              </button>
              <button
                type="button"
                onClick={() => closePreview(sessionId, tab.id)}
                aria-label="关闭"
                className={`flex h-4 w-4 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] ${active ? '' : 'opacity-0 group-hover:opacity-100'}`}
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          )
        })}
      </div>

      {/* 面包屑 */}
      {activeTab && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3" style={{ height: 'var(--h-toolbar-sm)' }}>
          <Breadcrumb path={activeTab.path} />
          <span className="ml-auto shrink-0 rounded-[5px] border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
            {activeTab.kind === 'diff' ? 'Diff' : 'File'}
          </span>
        </div>
      )}

      {/* body */}
      {activeTab && <PreviewBody tab={activeTab} loading={activeLoading} />}
    </div>
  )
}
