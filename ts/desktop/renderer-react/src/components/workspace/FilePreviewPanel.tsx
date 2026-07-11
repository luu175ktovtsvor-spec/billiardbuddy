// 右侧「工作区面板」(照 Codex artifact 面板):可开合、可拖宽;内部两栏 —
//   第 3 栏 文件展示 = tab 条(每个打开的文件一个 tab,可关) + 面包屑 + 文件内容(带行号);无文件时显示「环境信息」卡。
//   第 4 栏 工作树   = FileTree(工作目录浏览器)。
// 由 filePreviewStore.panelOpen 控制显隐;TopBar 的面板按钮 togglePanel;点工具行/树里文件 → openFile。
import { useEffect, useState, type ReactNode } from 'react'
import { useFilePreviewStore, type GitSummary, type OpenFile } from '../../stores/filePreviewStore'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { ResizeHandle } from '../shared/ResizeHandle'
import { FileTree, fileColor } from './FileTree'
import { ContextMenu } from '../shared/Menu'
import { IconX } from '../shared/icons'

function baseName(p: string): string {
  return p.split('/').pop() || p
}
function relTo(root: string | null, p: string): string {
  if (root && p.startsWith(root)) return p.slice(root.length).replace(/^\//, '')
  return p
}

function FileContent({ file }: { file: OpenFile }) {
  if (file.loading) return <div className="min-h-full p-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>正在加载…</div>
  if (file.error) return <div className="min-h-full p-3 text-[12px]" style={{ color: 'var(--color-error)' }}>{file.error}</div>
  const lines = file.content.length ? file.content.replace(/\r\n?/g, '\n').split('\n') : []
  // min-h-full:短文件也把整栏背景撑满到底,不留"顶部一块、下面空白"的断层(对齐 Codex 编辑区铺满)。
  return (
    <div className="min-h-full py-1" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, background: 'var(--color-app-main)' }}>
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="shrink-0 select-none text-right" style={{ width: 44, padding: '0 8px', color: 'var(--color-text-tertiary)', opacity: 0.55 }}>{i + 1}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3" style={{ color: 'var(--color-text-primary)' }}>{line.length ? line : ' '}</span>
        </div>
      ))}
    </div>
  )
}

function EnvRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label}</span>
      <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{value}</span>
    </div>
  )
}

function EnvCard({ git }: { git: GitSummary | null }) {
  return (
    <div className="p-4">
      <div className="mb-3 text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>环境信息</div>
      {!git ? (
        <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>正在读取工作区状态…</div>
      ) : !git.isGit ? (
        <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>当前工作目录不是 git 仓库。</div>
      ) : (
        <div className="flex flex-col gap-2 text-[12.5px]">
          <EnvRow label="分支" value={git.branch ?? '—'} />
          <EnvRow
            label="变更"
            value={
              <>
                <span style={{ color: 'var(--color-success)' }}>{git.changed} 处改动</span>
                <span style={{ color: 'var(--color-text-tertiary)' }}> · 未跟踪 {git.untracked}</span>
              </>
            }
          />
          <EnvRow label="领先 / 落后" value={`↑${git.ahead}  ↓${git.behind}`} />
        </div>
      )}
      <div className="mt-4 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        右边是工作目录,点任意文件在这里打开查看。
      </div>
    </div>
  )
}

export function FilePreviewPanel() {
  const panelOpen = useFilePreviewStore((s) => s.panelOpen)
  const tabs = useFilePreviewStore((s) => s.tabs)
  const activePath = useFilePreviewStore((s) => s.activePath)
  const root = useFilePreviewStore((s) => s.root)
  const git = useFilePreviewStore((s) => s.git)
  const setActive = useFilePreviewStore((s) => s.setActive)
  const closeTab = useFilePreviewStore((s) => s.closeTab)
  const closeOthers = useFilePreviewStore((s) => s.closeOthers)
  const closeAll = useFilePreviewStore((s) => s.closeAll)
  const setPanelOpen = useFilePreviewStore((s) => s.setPanelOpen)
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; path: string } | null>(null)
  const { width, onHandleDown, onHandleMove, endDrag } = useResizableWidth({ initial: 640, min: 440, max: 960, edge: 'left' })

  // Esc 关闭面板(在输入框里按 Esc 不关,避免误触筛选/输入)。
  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panelOpen, setPanelOpen])

  if (!panelOpen) return null
  const active = tabs.find((tb) => tb.path === activePath) ?? null

  return (
    <div
      className="relative flex h-full shrink-0"
      style={{ width, borderLeft: '1px solid var(--color-border)', background: 'var(--color-app-main)' }}
      data-testid="file-preview-panel"
    >
      <ResizeHandle side="left" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={endDrag} />

      {/* 第 3 栏:文件展示 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* tab 条 */}
        <div className="flex items-center gap-1 overflow-x-auto px-2 py-1.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
          {tabs.length === 0 ? (
            <span className="px-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>工作区</span>
          ) : (
            tabs.map((tb) => {
              const on = tb.path === activePath
              return (
                <div
                  key={tb.path}
                  onContextMenu={(e) => { e.preventDefault(); setTabCtx({ x: e.clientX, y: e.clientY, path: tb.path }) }}
                  className="flex shrink-0 items-center gap-1 rounded-md py-1 pl-2 pr-1 text-[12px] transition-colors"
                  style={{ background: on ? 'var(--color-surface-selected)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}
                >
                  <span className="shrink-0" style={{ width: 7, height: 7, borderRadius: 2, background: fileColor(baseName(tb.path)) }} />
                  <button type="button" className="max-w-[150px] truncate" onClick={() => setActive(tb.path)} title={tb.path}>
                    {baseName(tb.path)}
                  </button>
                  <button type="button" aria-label="关闭标签" onClick={() => closeTab(tb.path)} className="rounded p-0.5 opacity-55 transition-opacity hover:bg-[var(--color-surface-hover)] hover:opacity-100">
                    <IconX size={11} />
                  </button>
                </div>
              )
            })
          )}
          <div className="flex-1" />
          <button type="button" aria-label="收起面板" onClick={() => setPanelOpen(false)} className="shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-tertiary)' }}>
            <IconX size={14} />
          </button>
        </div>

        {/* 面包屑 */}
        {active && (
          <div className="truncate px-3 py-1.5 text-[11px]" style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {relTo(root, active.path).split('/').join('  ›  ')}
          </div>
        )}

        {/* 文件内容(工作目录原本的样子,铺满整栏到底)/ 无文件时环境卡。
            普通打开不做 diff 对比——红绿修改/删除是后续「审查」tab 的事(对齐 Codex)。 */}
        <div className="min-h-0 flex-1 overflow-auto">
          {active ? <FileContent file={active} /> : <EnvCard git={git} />}
        </div>
      </div>

      {/* 第 4 栏:工作树 */}
      <div className="w-[232px] shrink-0" style={{ borderLeft: '1px solid var(--color-border)' }}>
        <FileTree />
      </div>

      {tabCtx && (
        <ContextMenu
          x={tabCtx.x}
          y={tabCtx.y}
          onClose={() => setTabCtx(null)}
          items={[
            { label: '关闭', onClick: () => closeTab(tabCtx.path) },
            { label: '关闭其他', onClick: () => closeOthers(tabCtx.path) },
            { label: '全部关闭', onClick: () => closeAll(), separatorBefore: true },
          ]}
        />
      )}
    </div>
  )
}
