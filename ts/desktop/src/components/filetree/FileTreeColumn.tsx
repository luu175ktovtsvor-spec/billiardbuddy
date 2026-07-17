import { useEffect, useMemo, useState } from 'react'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import type { WorkspaceChangedFile, WorkspaceFileStatus, WorkspaceTreeEntry } from '../../api/sessions'

/**
 * 栏4 · 独立文件树列（Codex 四栏）。消费现有 workspacePanelStore（数据零改），
 * 提供「变更 / 全部文件」两视图 + 筛选 + 变更徽标 + 点击→openPreview（跨栏联动到栏3）。
 *
 * 精简自 WorkspacePanel 的 navigator 半边（未直接抽 1500 行组件，避免大refactor风险）；
 * 切壳阶段（Phase C/D）再与 WorkspacePanel 去重。
 */
const EMPTY_TREE: Record<string, undefined> = {}
const EMPTY_EXPANDED: string[] = []

function statusMeta(status: WorkspaceFileStatus): { sym: string; varName: string } {
  switch (status) {
    case 'added':
    case 'untracked':
      return { sym: '+', varName: '--diff-added-fg' }
    case 'deleted':
      return { sym: '−', varName: '--diff-deleted-fg' }
    case 'renamed':
      return { sym: '›', varName: '--diff-modified-fg' }
    default:
      return { sym: '●', varName: '--diff-modified-fg' }
  }
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

interface TreeNodeProps {
  sessionId: string
  entry: WorkspaceTreeEntry
  depth: number
  expanded: Set<string>
  treeByPath: Record<string, { state: string; entries: WorkspaceTreeEntry[] } | undefined>
  filter: string
  activePath: string | null
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
}

function TreeNode({ sessionId, entry, depth, expanded, treeByPath, filter, activePath, onToggle, onOpenFile }: TreeNodeProps) {
  const isOpen = expanded.has(entry.path) || filter.length > 0
  const matches = filter.length === 0 || entry.name.toLowerCase().includes(filter)
  const children = entry.isDirectory && isOpen ? treeByPath[entry.path]?.entries ?? [] : []
  // 目录本身不匹配但子孙可能匹配：筛选时始终递归。
  if (filter.length > 0 && !entry.isDirectory && !matches) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => (entry.isDirectory ? onToggle(entry.path) : onOpenFile(entry.path))}
        title={entry.path}
        className={`flex w-full items-center gap-1.5 truncate rounded-[var(--radius-sm)] pr-2 text-left text-[13px] transition-colors ${
          activePath === entry.path
            ? 'bg-[var(--color-sidebar-item-active)] text-[var(--color-primary)]'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
        }`}
        style={{ height: 'var(--h-nav-row)', paddingLeft: `${8 + depth * 14}px` }}
      >
        <span className="material-symbols-outlined shrink-0 text-[16px] text-[var(--color-text-tertiary)]">
          {entry.isDirectory ? (isOpen ? 'folder_open' : 'folder') : 'description'}
        </span>
        <span className="truncate">{entry.name}</span>
      </button>
      {children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.path}
              sessionId={sessionId}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              treeByPath={treeByPath}
              filter={filter}
              activePath={activePath}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileTreeColumn({ sessionId }: { sessionId: string }) {
  const [filterRaw, setFilterRaw] = useState('')
  const filter = filterRaw.trim().toLowerCase()

  const activeView = useWorkspacePanelStore((s) => s.getActiveView(sessionId))
  const status = useWorkspacePanelStore((s) => s.statusBySession[sessionId])
  const treeByPath = useWorkspacePanelStore((s) => s.treeBySessionPath[sessionId] ?? EMPTY_TREE)
  const expandedPaths = useWorkspacePanelStore((s) => s.expandedPathsBySession[sessionId] ?? EMPTY_EXPANDED)
  const statusLoading = useWorkspacePanelStore((s) => s.loading.statusBySession[sessionId] ?? false)
  const setActiveView = useWorkspacePanelStore((s) => s.setActiveView)
  const loadStatus = useWorkspacePanelStore((s) => s.loadStatus)
  const loadTree = useWorkspacePanelStore((s) => s.loadTree)
  const toggleTreeNode = useWorkspacePanelStore((s) => s.toggleTreeNode)
  const openPreview = useWorkspacePanelStore((s) => s.openPreview)

  useEffect(() => {
    if (!sessionId) return
    void loadStatus(sessionId)
    void loadTree(sessionId)
  }, [sessionId, loadStatus, loadTree])

  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths])
  const rootTree = treeByPath['']
  const changedFiles: WorkspaceChangedFile[] = useMemo(
    () => (status?.changedFiles ?? []).filter((f) => filter.length === 0 || f.path.toLowerCase().includes(filter)),
    [status?.changedFiles, filter],
  )
  const rootEntries = useMemo(
    () => (rootTree?.state === 'ok' ? rootTree.entries : []),
    [rootTree],
  )

  const changedCount = status?.changedFiles?.length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]">
      {/* 视图切换 + 分支 */}
      <div
        className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border)] px-2"
        style={{ height: 'var(--h-toolbar-pane)' }}
      >
        <button
          type="button"
          onClick={() => setActiveView(sessionId, 'changed')}
          className={`rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium transition-colors ${
            activeView === 'changed'
              ? 'bg-[var(--color-sidebar-item-active)] text-[var(--color-primary)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          变更{changedCount > 0 ? ` ${changedCount}` : ''}
        </button>
        <button
          type="button"
          onClick={() => setActiveView(sessionId, 'all')}
          className={`rounded-[var(--radius-sm)] px-2 py-1 text-xs font-medium transition-colors ${
            activeView === 'all'
              ? 'bg-[var(--color-sidebar-item-active)] text-[var(--color-primary)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
          }`}
        >
          全部文件
        </button>
        {status?.branch && (
          <span className="ml-auto truncate text-[11px] text-[var(--color-text-tertiary)]" title={status.branch}>
            {status.branch}
          </span>
        )}
      </div>

      {/* 筛选 */}
      <div className="shrink-0 px-2 py-1.5">
        <input
          value={filterRaw}
          onChange={(e) => setFilterRaw(e.target.value)}
          placeholder="筛选文件…"
          className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-2.5 text-[13px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
          style={{ height: 'var(--h-toolbar-sm)' }}
        />
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {activeView === 'changed' ? (
          changedFiles.length === 0 ? (
            <p className="px-3 py-4 text-xs text-[var(--color-text-tertiary)]">
              {statusLoading ? '加载中…' : changedCount === 0 ? '没有变更' : '无匹配文件'}
            </p>
          ) : (
            changedFiles.map((file) => {
              const meta = statusMeta(file.status)
              return (
                <button
                  key={`${file.path}:${file.status}`}
                  type="button"
                  onClick={() => void openPreview(sessionId, file.path, 'diff')}
                  title={file.path}
                  className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                  style={{ height: 'var(--h-nav-row)' }}
                >
                  <span className="shrink-0 font-mono text-[13px]" style={{ color: `var(${meta.varName})` }}>
                    {meta.sym}
                  </span>
                  <span className="truncate">{baseName(file.path)}</span>
                  {(file.additions > 0 || file.deletions > 0) && (
                    <span className="ml-auto shrink-0 font-mono text-[11px]">
                      {file.additions > 0 && <span style={{ color: 'var(--diff-added-fg)' }}>+{file.additions}</span>}
                      {file.deletions > 0 && <span className="ml-1" style={{ color: 'var(--diff-deleted-fg)' }}>−{file.deletions}</span>}
                    </span>
                  )}
                </button>
              )
            })
          )
        ) : rootEntries.length === 0 ? (
          <p className="px-3 py-4 text-xs text-[var(--color-text-tertiary)]">
            {rootTree ? (filter ? '无匹配文件' : '空目录') : '加载中…'}
          </p>
        ) : (
          rootEntries.map((entry) => (
            <TreeNode
              key={entry.path}
              sessionId={sessionId}
              entry={entry}
              depth={0}
              expanded={expandedSet}
              treeByPath={treeByPath}
              filter={filter}
              activePath={null}
              onToggle={(path) => void toggleTreeNode(sessionId, path)}
              onOpenFile={(path) => void openPreview(sessionId, path, 'file')}
            />
          ))
        )}
      </div>
    </div>
  )
}
