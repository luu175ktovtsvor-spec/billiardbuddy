// 左栏 —— 照 Codex(ChatGPT Codex)左栏信息架构(owner 2026-07-11:左栏直接改成 Codex 的)。
// 结构:红绿灯位+工具图标 → 品牌行 → 主导航(新建任务/已安排/插件) → 项目分组 → 对话分组 → 底部设置。
// 交互:新建任务/会话项接 chatStore 会话开合;会话右键 → 上下文菜单(置顶/重命名/归档/删除,动作后端就绪前占位)。
import { useState, type ReactNode } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { pickWorkspaceFolder } from '../../lib/workspace'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { DRAG, NODRAG } from '../../lib/dragRegion'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { ResizeHandle } from '../shared/ResizeHandle'
import { ContextMenu } from '../shared/Menu'
import { Smiley } from '../shared/Smiley'
import {
  IconPanelLeft, IconSearch, IconEdit, IconClock, IconPuzzle,
  IconFolder, IconSettings, IconChevronDown, IconSun, IconMoon,
  IconPin, IconArchive, IconTrash, IconSparkles, IconZap,
} from '../shared/icons'
import { t } from '../../i18n'

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  if (!ts || Number.isNaN(diff)) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  try {
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  } catch {
    return ''
  }
}

function ToolBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-tertiary)', ...NODRAG }}
    >
      {children}
    </button>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-primary)', background: active ? 'var(--color-surface-selected)' : undefined }}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}>{icon}</span>
      <span className="flex-1 truncate text-[13.5px]">{label}</span>
    </button>
  )
}

function SectionHeader({ label, count, open, onToggle }: { label: string; count?: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 flex w-full items-center gap-1 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide transition-colors hover:text-[var(--color-text-secondary)]"
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      <span className="transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>
        <IconChevronDown size={12} />
      </span>
      <span>{label}</span>
      {count !== undefined && <span style={{ opacity: 0.7 }}>{count}</span>}
    </button>
  )
}

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions)
  const refresh = useSessionStore((s) => s.refresh)
  const renameSession = useSessionStore((s) => s.renameSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const togglePin = useSessionStore((s) => s.togglePin)
  const toggleArchive = useSessionStore((s) => s.toggleArchive)
  const activeId = useChatStore((s) => s.conversationId)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const effective = useUiStore((s) => s.effectiveTheme)
  const openSettings = useUiStore((s) => s.setSettingsOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const nav = useUiStore((s) => s.nav)
  const setNav = useUiStore((s) => s.setNav)
  const openWorkspace = useFilePreviewStore((s) => s.setPanelOpen)
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)
  const workspaceName = workspaceRoot ? (workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspaceRoot) : t('sidebar.workspaceDefault')
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [convOpen, setConvOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; title: string } | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const matched = query.trim() ? sessions.filter((s) => (s.title || '').toLowerCase().includes(query.toLowerCase())) : sessions
  // 未归档:置顶优先;已归档单列一区。
  const liveSessions = matched.filter((s) => !s.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
  const archivedSessions = matched.filter((s) => s.archived)

  const commitRename = () => {
    if (editingId) {
      const v = editValue.trim()
      if (v) renameSession(editingId, v)
    }
    setEditingId(null)
  }
  const doDelete = (id: string) => {
    removeSession(id)
    if (id === activeId) openNewConversation()
  }
  const ctxSession = ctx ? sessions.find((s) => s.id === ctx.id) : null

  const renderRow = (s: (typeof sessions)[number]) => {
    const active = s.id === activeId
    if (editingId === s.id) {
      return (
        <div key={s.id} className="mb-0.5 px-1">
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setEditingId(null)
            }}
            className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none"
            style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-primary)', border: '1px solid var(--color-brand)' }}
          />
        </div>
      )
    }
    return (
      <button
        key={s.id}
        type="button"
        onClick={() => {
          setNav('chat')
          openExistingConversation(s.id, s.title)
          void refresh()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtx({ x: e.clientX, y: e.clientY, id: s.id, title: s.title || '' })
        }}
        className="mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ background: active ? 'var(--color-surface-selected)' : 'transparent' }}
      >
        {s.pinned && <IconPin size={11} style={{ color: 'var(--color-text-tertiary)', transform: 'rotate(45deg)' }} />}
        <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>{s.title || t('sidebar.newChat')}</span>
        <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{fmtRelative(s.updatedAt)}</span>
      </button>
    )
  }
  const { width, onHandleDown, onHandleMove, endDrag } = useResizableWidth({ initial: 240, min: 200, max: 420, edge: 'right' })

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col"
      style={{ width, background: 'var(--color-app-sidebar)', borderRight: '1px solid var(--color-border)' }}
      data-testid="sidebar"
    >
      <ResizeHandle side="right" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={endDrag} />

      {/* 顶:红绿灯位(左) + 工具图标(右) */}
      <div className="flex h-[46px] items-center justify-end gap-0.5 px-2 pl-[78px]" style={DRAG}>
        <ToolBtn label={t('sidebar.collapse')} onClick={toggleSidebar}><IconPanelLeft size={17} /></ToolBtn>
        <ToolBtn label={t('sidebar.search')} onClick={() => setSearching((v) => !v)}><IconSearch size={17} /></ToolBtn>
      </div>

      {/* 品牌行 */}
      <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
        <Smiley size={20} />
        <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('app.name')}</span>
      </div>

      {/* 搜索(点顶部🔍展开,过滤会话) */}
      {searching && (
        <div className="px-3 pb-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话…"
            className="w-full rounded-md px-2.5 py-1.5 text-[13px] outline-none"
            style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
          />
        </div>
      )}

      {/* 主导航:新建任务 / 已安排 / 插件(照 Codex,点选切主区视图) */}
      <nav className="px-2 pb-1">
        <NavItem icon={<IconEdit size={17} />} label={t('sidebar.newTask')} onClick={() => { setNav('chat'); openNewConversation() }} />
        <NavItem icon={<IconSparkles size={17} />} label="生图工作台" active={nav === 'creation'} onClick={() => setNav('creation')} />
        <NavItem icon={<IconZap size={17} />} label="剪视频工作台" active={nav === 'video'} onClick={() => setNav('video')} />
        <NavItem icon={<IconClock size={17} />} label={t('sidebar.scheduled')} active={nav === 'scheduled'} onClick={() => setNav('scheduled')} />
        <NavItem icon={<IconPuzzle size={17} />} label={t('sidebar.plugins')} active={nav === 'plugins'} onClick={() => setNav('plugins')} />
      </nav>

      {/* 项目 + 对话 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <SectionHeader label={t('sidebar.sectionProjects')} open={projectsOpen} onToggle={() => setProjectsOpen((v) => !v)} />
        {projectsOpen && (
          <div className="flex w-full items-center rounded-lg pr-1 transition-colors hover:bg-[var(--color-surface-hover)]">
            <button
              type="button"
              onClick={() => { setNav('chat'); openWorkspace(true) }}
              className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left"
              style={{ color: 'var(--color-text-primary)' }}
              title={workspaceRoot ?? '未选,用默认工作目录'}
            >
              <span className="shrink-0" style={{ color: 'var(--color-text-secondary)' }}><IconFolder size={16} /></span>
              <span className="flex-1 truncate text-[13px]">{workspaceName}</span>
            </button>
            <button
              type="button"
              onClick={() => void pickWorkspaceFolder()}
              className="shrink-0 rounded px-1.5 py-1 text-[11px] font-medium opacity-70 transition-opacity hover:opacity-100"
              style={{ color: 'var(--color-brand)' }}
              title="选择/切换工作目录(程序在这个文件夹里读写)"
            >
              选目录
            </button>
          </div>
        )}

        <SectionHeader label={t('sidebar.sectionConversations')} count={liveSessions.length || undefined} open={convOpen} onToggle={() => setConvOpen((v) => !v)} />
        {convOpen && (
          <div className="mb-2">
            {sessions.length === 0 ? (
              <button
                type="button"
                onClick={() => { setNav('chat'); openNewConversation() }}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left"
                style={{ background: 'var(--color-surface-selected)' }}
              >
                <span className="truncate text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{t('sidebar.newChat')}</span>
                <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>刚刚</span>
              </button>
            ) : liveSessions.length === 0 ? (
              <div className="px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>没有匹配的对话</div>
            ) : (
              liveSessions.map(renderRow)
            )}
          </div>
        )}

        {/* 已归档(有归档项才出现,默认折叠) */}
        {archivedSessions.length > 0 && (
          <>
            <SectionHeader label={t('sidebar.archived')} count={archivedSessions.length} open={archivedOpen} onToggle={() => setArchivedOpen((v) => !v)} />
            {archivedOpen && <div className="mb-2">{archivedSessions.map(renderRow)}</div>}
          </>
        )}
      </div>

      {/* 底部:设置 + 主题切换(照 Codex 底部) */}
      <div className="flex items-center gap-1 px-2 py-2" style={{ borderTop: '1px solid var(--color-border)' }}>
        <button
          type="button"
          onClick={() => openSettings(true)}
          className="flex h-9 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ color: 'var(--color-text-primary)' }}
        >
          <span className="shrink-0" style={{ color: 'var(--color-text-secondary)' }}><IconSettings size={17} /></span>
          <span className="text-[13.5px]">{t('sidebar.settings')}</span>
        </button>
        <ToolBtn label="切换主题" onClick={toggleTheme}>
          {effective === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
        </ToolBtn>
      </div>

      {/* 会话右键上下文菜单(照 Codex 任务卡右键;前端本地生效,后端持久化后端接) */}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: ctxSession?.pinned ? '取消置顶' : '置顶任务',
              icon: <IconPin size={15} />,
              shortcut: '⌥⌘P',
              onClick: () => togglePin(ctx.id),
            },
            {
              label: '重命名',
              icon: <IconEdit size={15} />,
              shortcut: '⌥⌘R',
              onClick: () => { setEditingId(ctx.id); setEditValue(ctx.title) },
            },
            {
              label: ctxSession?.archived ? '取消归档' : '归档任务',
              icon: <IconArchive size={15} />,
              shortcut: '⇧⌘A',
              separatorBefore: true,
              onClick: () => toggleArchive(ctx.id),
            },
            {
              label: '删除',
              icon: <IconTrash size={15} />,
              danger: true,
              separatorBefore: true,
              onClick: () => doDelete(ctx.id),
            },
          ]}
        />
      )}
    </aside>
  )
}
