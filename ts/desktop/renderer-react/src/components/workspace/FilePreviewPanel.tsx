// 右侧「工作区面板」(照 Codex artifact 面板):可开合、可拖宽;内部两栏 —
//   第 3 栏 文件展示 = tab 条(每个打开的文件一个 tab,可关) + 面包屑 + 文件内容(带行号);无文件时显示「环境信息」卡。
//   第 4 栏 工作树   = FileTree(工作目录浏览器)。
// 由 filePreviewStore.panelOpen 控制显隐;TopBar 的面板按钮 togglePanel;点工具行/树里文件 → openFile。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { fetchBinary } from '../../api/client'
import { useFilePreviewStore, rawFileUrl, type GitSummary, type OpenFile } from '../../stores/filePreviewStore'
import { toast } from '../../stores/toastStore'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { getDesktopHost } from '../../lib/desktopHost'
import { ResizeHandle } from '../shared/ResizeHandle'
import { FileTree, fileColor } from './FileTree'
import { ContextMenu } from '../shared/Menu'
import { IconChevronDown, IconFileText, IconRefresh, IconX } from '../shared/icons'

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

function ImagePreview({ file }: { file: OpenFile }) {
  const [errored, setErrored] = useState(false)
  // 图片实时渲染(对齐 Codex 右面板可开图):<img> 直接加载 fs/raw 原始字节,居中等比缩放、铺满整栏。
  return (
    <div className="flex min-h-full items-center justify-center p-4" style={{ background: 'var(--color-app-main)' }}>
      {errored ? (
        <div className="text-[12px]" style={{ color: 'var(--color-error)' }}>图片加载失败:{baseName(file.path)}</div>
      ) : (
        <img
          src={rawFileUrl(file.path, file.workspaceRoot)}
          alt={baseName(file.path)}
          onError={() => setErrored(true)}
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }}
        />
      )}
    </div>
  )
}

function VideoPreview({ file }: { file: OpenFile }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-black p-2">
      <video src={rawFileUrl(file.path, file.workspaceRoot)} controls preload="metadata" className="max-h-full max-w-full" data-testid="workspace-video-preview" />
    </div>
  )
}

function PdfPreview({ file }: { file: OpenFile }) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null })
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | null = null
    setState({ url: null, error: null })
    void fetchBinary(rawFileUrl(file.path, file.workspaceRoot), controller.signal)
      .then(blob => {
        objectUrl = URL.createObjectURL(blob)
        setState({ url: objectUrl, error: null })
      })
      .catch(error => {
        if (!controller.signal.aborted) setState({ url: null, error: error instanceof Error ? error.message : String(error) })
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [file.path, file.workspaceRoot])

  if (state.error) return <div className="p-3 text-[12px]" style={{ color: 'var(--color-error)' }}>{state.error}</div>
  if (!state.url) return <div className="p-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>正在读取 PDF…</div>
  return <iframe src={state.url} title={baseName(file.path)} className="h-full min-h-[480px] w-full border-0" data-testid="workspace-pdf-preview" />
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

function SpreadsheetPreview({ file }: { file: OpenFile }) {
  const selectSheet = useFilePreviewStore((state) => state.selectSpreadsheetSheet)
  if (file.loading) return <div className="p-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>正在读取表格…</div>
  if (file.error || file.preview?.kind !== 'spreadsheet') return <div className="p-3 text-[12px]" style={{ color: 'var(--color-error)' }}>{file.error ?? '无法读取表格'}</div>
  const sheet = file.preview.sheets[0]
  const columnCount = Math.max(0, ...(sheet?.rows.map(row => row.length) ?? []))
  if (!sheet || sheet.rows.length === 0) return <div className="p-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>表格是空的</div>
  return (
    <div className="min-w-max text-[12px]" data-testid="workspace-spreadsheet-preview">
      <div className="sticky left-0 top-0 z-20 flex items-center gap-1 overflow-x-auto border-b px-2 py-1" style={{ background: 'var(--color-surface-container)', borderColor: 'var(--color-border)' }}>
        {file.preview.sheet_names.map(name => (
          <button
            key={name}
            type="button"
            onClick={() => selectSheet(file.path, name)}
            className="shrink-0 rounded px-2 py-0.5 font-medium transition-colors"
            style={{ background: name === sheet.name ? 'var(--color-surface-selected)' : 'transparent', color: name === sheet.name ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}
          >
            {name}
          </button>
        ))}
      </div>
      <table className="border-collapse" style={{ color: 'var(--color-text-primary)' }}>
        <thead className="sticky top-[29px] z-10"><tr><th className="sticky left-0 min-w-10 border px-2 py-1" style={{ background: 'var(--color-surface-container)', borderColor: 'var(--color-border)' }} />{Array.from({ length: columnCount }, (_, index) => <th key={index} className="min-w-24 border px-2 py-1 text-left font-medium" style={{ background: 'var(--color-surface-container)', borderColor: 'var(--color-border)', color: 'var(--color-text-tertiary)' }}>{columnLabel(index)}</th>)}</tr></thead>
        <tbody>{sheet.rows.map((row, rowIndex) => <tr key={rowIndex}><th className="sticky left-0 border px-2 py-1 text-right font-normal" style={{ background: 'var(--color-surface-container-low)', borderColor: 'var(--color-border)', color: 'var(--color-text-tertiary)' }}>{rowIndex + 1}</th>{Array.from({ length: columnCount }, (_, colIndex) => <td key={colIndex} className="max-w-80 border px-2 py-1 align-top whitespace-pre-wrap" style={{ borderColor: 'var(--color-border)' }}>{row[colIndex] ?? ''}</td>)}</tr>)}</tbody>
      </table>
      {file.preview.truncated && <div className="sticky bottom-0 p-2 text-[11px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-warning)' }}>仅显示前 200 行和 200 列</div>}
    </div>
  )
}

function DocumentPreview({ file }: { file: OpenFile }) {
  if (file.loading) return <div className="p-3 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>正在读取文档…</div>
  if (file.error || file.preview?.kind !== 'document') return <div className="p-3 text-[12px]" style={{ color: 'var(--color-error)' }}>{file.error ?? '无法读取文档'}</div>
  return (
    <div className="mx-auto max-w-[760px] space-y-3 p-5" data-testid="workspace-document-preview">
      {file.preview.blocks.length === 0 ? <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>文档没有可预览的文字</div> : file.preview.blocks.map(block => (
        <p key={block.id} className="whitespace-pre-wrap text-[13px] leading-6" style={{ color: 'var(--color-text-primary)' }}>{block.text}</p>
      ))}
      {file.preview.truncated && <div className="text-[11px]" style={{ color: 'var(--color-warning)' }}>文档较长，仅显示前 2000 个文本块</div>}
    </div>
  )
}

function UnsupportedPreview({ file }: { file: OpenFile }) {
  return <div className="flex min-h-full items-center justify-center p-6 text-center text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>暂不支持在这里预览 {baseName(file.path)}<br />可从上方“打开”菜单使用系统程序查看</div>
}

function ActivePreview({ file }: { file: OpenFile }) {
  if (file.kind === 'image') return <ImagePreview file={file} />
  if (file.kind === 'video') return <VideoPreview file={file} />
  if (file.kind === 'pdf') return <PdfPreview file={file} />
  if (file.kind === 'spreadsheet') return <SpreadsheetPreview file={file} />
  if (file.kind === 'document') return <DocumentPreview file={file} />
  if (file.kind === 'unsupported') return <UnsupportedPreview file={file} />
  return <FileContent file={file} />
}

function EnvRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span style={{ color: 'var(--color-text-tertiary)' }}>{label}</span>
      <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{value}</span>
    </div>
  )
}

function LauncherRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-primary)' }}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: 'var(--color-text-tertiary)' }}>{icon}</span>
      {label}
    </button>
  )
}

const NOTABLE_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'package.json']

/** 空态 = Codex「新建标签页」轻量版:文件 入口 + 「推荐」文件(终端入口等真 xterm+pty 终端落地再加;侧边任务/浏览器暂略);环境卡保留下方。 */
function EmptyState({ git }: { git: GitSummary | null }) {
  const tree = useFilePreviewStore((s) => s.tree)
  const root = useFilePreviewStore((s) => s.root)
  const openFile = useFilePreviewStore((s) => s.openFile)
  const host = getDesktopHost()
  // 推荐文件:根目录的 README/CLAUDE.md 等打头,不够拿其余根文件补,最多 4 个(对齐 Codex「推荐」分区)。
  const suggested = useMemo(() => {
    const files = (tree ?? []).filter((e) => e.type === 'file')
    const notable = files.filter((f) => NOTABLE_FILES.includes(f.name))
    return [...notable, ...files.filter((f) => !NOTABLE_FILES.includes(f.name))].slice(0, 4)
  }, [tree])

  return (
    <div className="flex flex-col p-2" data-testid="panel-empty-state">
      <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>新建标签页</div>
      {host.pickPaths && (
        <LauncherRow
          icon={<IconFileText size={15} />}
          label="文件"
          onClick={() => { void host.pickPaths?.({ defaultPath: root ?? undefined }).then((paths) => paths?.forEach((p) => openFile(p))) }}
        />
      )}
      {suggested.length > 0 && (
        <>
          <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>推荐</div>
          {suggested.map((f) => {
            const abs = root ? `${root}/${f.path}` : f.path
            return (
              <button
                key={f.path}
                type="button"
                onClick={() => openFile(abs)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <span className="shrink-0" style={{ width: 7, height: 7, borderRadius: 2, background: fileColor(f.name) }} />
                <span className="truncate">{f.name}</span>
              </button>
            )
          })}
        </>
      )}
      <div className="mx-1 mt-3" style={{ borderTop: '1px solid var(--color-border)' }} />
      <EnvCard git={git} />
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
  const reloadFile = useFilePreviewStore((s) => s.reloadFile)
  const closeTab = useFilePreviewStore((s) => s.closeTab)
  const closeOthers = useFilePreviewStore((s) => s.closeOthers)
  const closeAll = useFilePreviewStore((s) => s.closeAll)
  const setPanelOpen = useFilePreviewStore((s) => s.setPanelOpen)
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; path: string } | null>(null)
  const [openMenu, setOpenMenu] = useState<{ x: number; y: number } | null>(null)
  const { width, onHandleDown, onHandleMove, endDrag } = useResizableWidth({ initial: 640, min: 440, max: 960, edge: 'left' })
  const host = getDesktopHost()

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

        {/* 面包屑 + 「打开」菜单(对齐 Codex:用默认程序打开 / 在 Finder 中显示;shell 能力只在桌面壳有,浏览器端不显示按钮) */}
        {active && (
          <div className="flex items-center gap-2 px-3 py-1 text-[11px]" style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' }}>
            <span className="min-w-0 flex-1 truncate" style={{ fontFamily: 'var(--font-mono)' }}>
              {relTo(root, active.path).split('/').join('  ›  ')}
            </span>
            {host.openPath && (
              <button
                type="button"
                data-testid="file-open-menu"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setOpenMenu({ x: r.right - 220, y: r.bottom + 4 })
                }}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                打开
                <IconChevronDown size={11} />
              </button>
            )}
            {['text', 'spreadsheet', 'document'].includes(active.kind) && (
              <button type="button" title="重新读取" aria-label="重新读取文件" onClick={() => reloadFile(active.path)} className="shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-tertiary)' }}>
                <IconRefresh size={12} />
              </button>
            )}
          </div>
        )}

        {/* 图片实时渲染 / 文件内容(工作目录原本的样子,铺满整栏)/ 无文件时「新建标签页」启动器+环境卡。
            普通打开不做 diff 对比——红绿修改/删除是后续「审查」tab 的事(对齐 Codex)。 */}
        <div className="min-h-0 flex-1 overflow-auto">
          {active ? <ActivePreview file={active} /> : <EmptyState git={git} />}
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

      {/* 「打开」下拉(锚在按钮下方;ContextMenu 自带遮罩关闭 + 视口钳制)。app 枚举(打开方式列具体应用)后续再做。 */}
      {openMenu && active && (
        <ContextMenu
          x={openMenu.x}
          y={openMenu.y}
          onClose={() => setOpenMenu(null)}
          items={[
            {
              label: '用默认程序打开',
              onClick: () => {
                void host.openPath?.(active.path).then((err) => { if (err) toast(`打不开:${err}`) })
              },
            },
            {
              label: host.platform === 'darwin' ? '在 Finder 中显示' : '在文件夹中显示',
              onClick: () => { void host.revealPath?.(active.path) },
            },
          ]}
        />
      )}
    </div>
  )
}
