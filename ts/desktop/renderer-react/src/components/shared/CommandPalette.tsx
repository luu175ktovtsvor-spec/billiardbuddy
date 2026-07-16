// 命令面板(⌘K · 照 Codex 顶部弹出的搜索/快捷操作面板)。搜对话 + 全局命令(对齐 Codex codex.command
// 注册面里我们有真实动作支撑的子集:主题/边栏/右面板/归档/复制 Markdown/查找/规划模式/上下任务),
// 键盘上下选、回车执行。入口:⌘K / 顶栏搜索 / 顶栏历史 / 侧栏搜索图标,统一开这个。纯前端。
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useChatStore } from '../../stores/chatStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { composeConversationText } from '../chat/ShareModal'
import { toast } from '../../stores/toastStore'
import {
  IconSearch, IconEdit, IconClock, IconPuzzle, IconSettings, IconMessage,
  IconSun, IconMoon, IconPanelLeft, IconPanelRight, IconArchive, IconCopy, IconChecklist, IconSparkles, IconZap,
} from './icons'

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
  const sessions = useSessionStore((s) => s.sessions)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = () => setOpen(false)

  const actions = useMemo<CmdItem[]>(
    () => [
      { id: 'new', label: '新建任务', icon: <IconEdit size={16} />, run: () => { setNav('chat'); openNewConversation() } },
      { id: 'scheduled', label: '已安排', icon: <IconClock size={16} />, run: () => setNav('scheduled') },
      { id: 'creation', label: '生成图片', icon: <IconSparkles size={16} />, run: () => setNav('creation') },
      { id: 'video', label: '剪视频', icon: <IconZap size={16} />, run: () => setNav('video') },
      { id: 'plugins', label: '插件', icon: <IconPuzzle size={16} />, run: () => setNav('plugins') },
      { id: 'settings', label: '设置', icon: <IconSettings size={16} />, run: () => setNav('settings') },
      // —— 全局命令(对齐 Codex codex.command 子集;只放有真实动作的) ——
      {
        id: 'theme-toggle', label: '切换深浅主题', icon: useUiStore.getState().effectiveTheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />,
        run: () => useUiStore.getState().toggleTheme(),
      },
      { id: 'toggle-sidebar', label: '切换边栏', sub: '⌘B', icon: <IconPanelLeft size={16} />, run: () => useUiStore.getState().toggleSidebar() },
      { id: 'toggle-panel', label: '切换右侧工作区面板', sub: '⌘\\', icon: <IconPanelRight size={16} />, run: () => useFilePreviewStore.getState().togglePanel() },
      { id: 'find', label: '在任务中查找', sub: '⌘F', icon: <IconSearch size={16} />, run: () => { setNav('chat'); window.dispatchEvent(new CustomEvent('qf-open-find')) } },
      {
        id: 'plan-mode', label: '切换规划模式', icon: <IconChecklist size={16} />,
        run: () => {
          const st = useSettingsStore.getState()
          const on = st.defaultPermissionMode === 'plan'
          st.setPermissionMode(on ? 'default' : 'plan')
          toast(on ? '已回到默认权限' : '已切换到规划模式(只读)')
        },
      },
      {
        id: 'copy-md', label: '复制整段对话', icon: <IconCopy size={16} />,
        run: () => { try { void navigator.clipboard?.writeText(composeConversationText(undefined)); toast('整段对话已复制') } catch { toast('复制失败') } },
      },
      {
        id: 'archive', label: '归档当前任务', icon: <IconArchive size={16} />,
        run: () => {
          const id = useChatStore.getState().conversationId
          if (!id) return
          void (async () => {
            const archived = await useSessionStore.getState().setArchived(id, true)
            if (!archived) {
              toast('归档失败，任务仍保留在侧栏')
              return
            }
            toast('已归档，可在设置「已归档任务」找回')
            openNewConversation()
          })()
        },
      },
      {
        id: 'prev-thread', label: '上一个任务', icon: <IconMessage size={16} />,
        run: () => stepThread(-1),
      },
      {
        id: 'next-thread', label: '下一个任务', icon: <IconMessage size={16} />,
        run: () => stepThread(1),
      },
    ],
    [setNav],
  )

  /** 相邻任务切换(对齐 Codex previous/nextThread):按会话列表顺序移动。 */
  function stepThread(d: number) {
    const list = useSessionStore.getState().sessions.filter((s) => !s.archived)
    if (list.length === 0) return
    const cur = useChatStore.getState().conversationId
    const idx = list.findIndex((s) => s.id === cur)
    const next = list[(idx === -1 ? 0 : idx + d + list.length) % list.length]
    if (next && next.id !== cur) { setNav('chat'); openExistingConversation(next.id, next.title) }
  }

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
        className="flex min-h-7 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors"
        style={{
          background: active ? 'var(--color-surface-hover)' : 'transparent',
          opacity: active ? 1 : 0.75,
        }}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: 'var(--color-text-secondary)' }}>{it.icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{it.label}</span>
        {it.sub && <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{it.sub}</span>}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4" style={{ background: '#00000022' }} onClick={close} data-testid="command-palette">
      <div
        className="flex h-fit max-h-[min(504px,90vh)] w-[min(520px,92vw)] flex-col gap-1 overflow-hidden rounded-2xl p-1"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="命令菜单"
      >
        <div className="flex min-h-11 items-center gap-2.5 px-2.5">
          <IconSearch size={17} style={{ color: 'var(--color-text-tertiary)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务或运行命令"
            className="w-full bg-transparent py-2.5 text-[14px] outline-none"
            style={{ color: 'var(--color-text-primary)' }}
            aria-label="搜索任务或运行命令"
          />
        </div>
        <div className="min-h-0 max-h-[min(440px,calc(90vh-64px))] flex-1 overflow-auto">
          {flat.length === 0 ? (
            <div className="flex h-12 items-center justify-center px-2.5 text-center text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>无匹配项</div>
          ) : (
            <>
              {shownActions.length > 0 && (
                <>
                  <div className="px-2 pt-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>操作</div>
                  {shownActions.map(Row)}
                </>
              )}
              {shownSessions.length > 0 && (
                <>
                  <div className="px-2 pt-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>任务</div>
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
