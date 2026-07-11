// 命令面板(⌘K · 照 Codex 顶部弹出的搜索/快捷操作面板)。搜对话 + 跳快捷操作,键盘上下选、回车执行。
// 入口:⌘K / 顶栏搜索 / 顶栏历史 / 侧栏搜索图标,统一开这个。纯前端。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { IconSearch, IconEdit, IconClock, IconPuzzle, IconSettings, IconMessage } from './icons'

interface CmdItem {
  id: string
  label: string
  sub?: string
  icon: ReactNode
  run: () => void
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  if (!ts || Number.isNaN(diff)) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  return `${d}天前`
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen)
  const setOpen = useUiStore((s) => s.setPaletteOpen)
  const setNav = useUiStore((s) => s.setNav)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = () => setOpen(false)

  const actions = useMemo<CmdItem[]>(
    () => [
      { id: 'new', label: '新建任务', icon: <IconEdit size={16} />, run: () => { setNav('chat'); openNewConversation() } },
      { id: 'scheduled', label: '已安排', icon: <IconClock size={16} />, run: () => setNav('scheduled') },
      { id: 'plugins', label: '插件', icon: <IconPuzzle size={16} />, run: () => setNav('plugins') },
      { id: 'settings', label: '设置', icon: <IconSettings size={16} />, run: () => setSettingsOpen(true) },
    ],
    [setNav, setSettingsOpen],
  )

  const q = query.trim().toLowerCase()
  const shownActions = useMemo(() => (q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions), [actions, q])
  const shownSessions = useMemo<CmdItem[]>(() => {
    const list = sessions.filter((s) => !s.archived && (!q || (s.title || '').toLowerCase().includes(q)))
    return list.slice(0, 8).map((s) => ({
      id: s.id,
      label: s.title || '新对话',
      sub: fmtRelative(s.updatedAt),
      icon: <IconMessage size={16} />,
      run: () => { setNav('chat'); openExistingConversation(s.id, s.title) },
    }))
  }, [sessions, q, setNav])

  const flat = useMemo(() => [...shownActions, ...shownSessions], [shownActions, shownSessions])

  // 打开时重置 + 聚焦;query 变化时选中回到 0。
  useEffect(() => {
    if (open) {
      setQuery('')
      setSel(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])
  useEffect(() => setSel(0), [query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, flat.length - 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)) }
      else if (e.key === 'Enter') { e.preventDefault(); const it = flat[sel]; if (it) { it.run(); close() } }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, flat, sel])

  if (!open) return null

  let idx = -1
  const Row = (it: CmdItem) => {
    idx += 1
    const active = idx === sel
    const myIdx = idx
    return (
      <button
        key={it.id}
        type="button"
        onMouseEnter={() => setSel(myIdx)}
        onClick={() => { it.run(); close() }}
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left"
        style={{ background: active ? 'var(--color-surface-selected)' : 'transparent' }}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: active ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }}>{it.icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13.5px]" style={{ color: 'var(--color-text-primary)' }}>{it.label}</span>
        {it.sub && <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{it.sub}</span>}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[75] flex justify-center px-6 pt-[14vh]" style={{ background: 'color-mix(in srgb, #000 30%, transparent)' }} onClick={close} data-testid="command-palette">
      <div
        className="flex h-fit max-h-[64vh] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <IconSearch size={17} style={{ color: 'var(--color-text-tertiary)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话,或跳到操作…"
            className="w-full bg-transparent py-3.5 text-[14px] outline-none"
            style={{ color: 'var(--color-text-primary)' }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {flat.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>没有匹配的结果</div>
          ) : (
            <>
              {shownActions.length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>操作</div>
                  {shownActions.map(Row)}
                </>
              )}
              {shownSessions.length > 0 && (
                <>
                  <div className="px-3 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>对话</div>
                  {shownSessions.map(Row)}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
