// 工作目录树(照 Codex 右侧「工作树」= 第 4 栏):接真实 /api/v1/agent/workspace-status 的 tree,
// 彩色扩展名图标、筛选搜索、目录展开/折叠(更深目录懒加载 /api/v1/agent/fs/list)、点文件 → openFile。
import { useMemo, useState } from 'react'
import { useFilePreviewStore, type TreeEntry } from '../../stores/filePreviewStore'
import { api } from '../../api/client'
import { IconChevronRight, IconChevronDown, IconSearch } from '../shared/icons'

const EXT_COLOR: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', js: '#d9b400', jsx: '#d9b400', mjs: '#d9b400', cjs: '#d9b400',
  json: '#c98a2b', md: '#4a90d9', mdx: '#4a90d9', css: '#8a63d2', scss: '#c6538c', html: '#e34c26',
  py: '#3572a5', go: '#00add8', rs: '#c98a5a', sh: '#8bc34a', zsh: '#8bc34a',
  yml: '#cb171e', yaml: '#cb171e', toml: '#9c4221', lock: '#8a8a8a', txt: '#8a8a8a',
  csv: '#1d6f42', xlsx: '#1d6f42', xls: '#1d6f42',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', webp: '#a074c4', gif: '#a074c4', svg: '#ffb13b',
}
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
export function fileColor(name: string): string {
  return EXT_COLOR[extOf(name)] ?? 'var(--color-text-tertiary)'
}

function FileGlyph({ name }: { name: string }) {
  return <span className="shrink-0" style={{ width: 8, height: 8, borderRadius: 2, background: fileColor(name) }} />
}
function FolderGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
    </svg>
  )
}

function TreeNode({ entry, depth, root }: { entry: TreeEntry; depth: number; root: string | null }) {
  const activePath = useFilePreviewStore((s) => s.activePath)
  const openFile = useFilePreviewStore((s) => s.openFile)
  const [expanded, setExpanded] = useState(depth < 1)
  const [lazy, setLazy] = useState<TreeEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const abs = root ? `${root}/${entry.path}` : entry.path

  if (entry.type === 'directory') {
    const children = entry.children ?? lazy
    const toggle = () => {
      const next = !expanded
      setExpanded(next)
      if (next && !children && !loading && root) {
        setLoading(true)
        void api
          .get<{ entries?: { name: string; isDir: boolean }[] }>(`/api/v1/agent/fs/list?path=${encodeURIComponent(abs)}`)
          .then((res) => setLazy((res.entries ?? []).map((e) => ({ name: e.name, path: `${entry.path}/${e.name}`, type: e.isDir ? 'directory' : 'file' }))))
          .catch(() => setLazy([]))
          .finally(() => setLoading(false))
      }
    }
    return (
      <div>
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ paddingLeft: 8 + depth * 12, color: 'var(--color-text-secondary)' }}
        >
          <span className="shrink-0" style={{ opacity: 0.65 }}>{expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</span>
          <span className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }}><FolderGlyph /></span>
          <span className="truncate text-[12.5px]">{entry.name}</span>
        </button>
        {expanded && children && <div>{children.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} root={root} />)}</div>}
      </div>
    )
  }

  const active = activePath === abs
  return (
    <button
      type="button"
      onClick={() => openFile(abs)}
      className="flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ paddingLeft: 8 + depth * 12 + 14, background: active ? 'var(--color-surface-selected)' : undefined, color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}
    >
      <FileGlyph name={entry.name} />
      <span className="truncate text-[12.5px]">{entry.name}</span>
    </button>
  )
}

export function FileTree() {
  const tree = useFilePreviewStore((s) => s.tree)
  const root = useFilePreviewStore((s) => s.root)
  const loading = useFilePreviewStore((s) => s.treeLoading)
  const error = useFilePreviewStore((s) => s.treeError)
  const openFile = useFilePreviewStore((s) => s.openFile)
  const activePath = useFilePreviewStore((s) => s.activePath)
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !tree) return null
    const out: TreeEntry[] = []
    const walk = (nodes: TreeEntry[]) => {
      for (const n of nodes) {
        if (n.type === 'file' && n.name.toLowerCase().includes(q)) out.push(n)
        if (n.children) walk(n.children)
      }
    }
    walk(tree)
    return out.slice(0, 200)
  }, [query, tree])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2">
        <div className="flex items-center gap-1.5 rounded-md px-2 py-1" style={{ background: 'var(--color-surface-container)' }}>
          <IconSearch size={13} style={{ color: 'var(--color-text-tertiary)' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选文件…"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
            style={{ color: 'var(--color-text-primary)' }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {loading ? (
          <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>正在读工作目录…</div>
        ) : error ? (
          <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--color-error)' }}>{error}</div>
        ) : matches ? (
          matches.length ? (
            matches.map((m) => {
              const abs = root ? `${root}/${m.path}` : m.path
              return (
                <button
                  key={m.path}
                  type="button"
                  onClick={() => openFile(abs)}
                  className="flex w-full items-center gap-1.5 rounded-md px-3 py-[3px] text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                  style={{ background: activePath === abs ? 'var(--color-surface-selected)' : undefined, color: 'var(--color-text-secondary)' }}
                >
                  <FileGlyph name={m.name} />
                  <span className="truncate text-[12.5px]" style={{ fontFamily: 'var(--font-mono)' }}>{m.path}</span>
                </button>
              )
            })
          ) : (
            <div className="px-3 py-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>没有匹配的文件</div>
          )
        ) : (
          (tree ?? []).map((e) => <TreeNode key={e.path} entry={e} depth={0} root={root} />)
        )}
      </div>
    </div>
  )
}
