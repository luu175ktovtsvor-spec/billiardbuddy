// Desktop product navigation backed by the current session and workbench stores.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  PanelLeft, Search, SquarePen, Clock, Puzzle,
  Folder, FolderOpen, Settings as SettingsIcon, ChevronDown, Sun, Moon,
  Sparkles, Zap, Plus, Loader2, Trash2, Pencil,
} from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'
import { useUIStore, resolveEffectiveTheme } from '../../stores/uiStore'
import {
  useTabStore,
  SETTINGS_TAB_ID,
  SCHEDULED_TAB_ID,
  IMAGE_WORKBENCH_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  type TabType,
} from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { Smiley } from '../shared/Smiley'
import { getDesktopHost } from '../../lib/desktopHost'
import type { SessionListItem } from '../../types/session'

const EXPANDED_KEY = 'billiardbuddy-sidebar-expanded-projects'
const PROJECT_TASKS_EXPANDED_KEY = 'billiardbuddy-sidebar-expanded-project-tasks'
const PROJECT_TASK_PAGE_SIZE = 5

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 满/禁用忽略 */ }
}

function baseName(root: string): string {
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || root
}

type ProjectGroup = { root: string; name: string; sessions: SessionListItem[] }

/**
 * 薄 adapter：把当前仓库 store 映射成旧 Sidebar 消费的数据/动作形状。
 * 唯一职责是数据接线，不含任何视觉/布局；旧结构只依赖这里返回的字段。
 */
function useSidebarData() {
  const sessions = useSessionStore((s) => s.sessions)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const renameSession = useSessionStore((s) => s.renameSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const createSession = useSessionStore((s) => s.createSession)

  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTabType = useTabStore(
    (s) => s.tabs.find((tab) => tab.sessionId === s.activeTabId)?.type ?? null,
  )
  const openTab = useTabStore((s) => s.openTab)

  const connectToSession = useChatStore((s) => s.connectToSession)
  const runningActive = useChatStore(
    (s) => (activeTabId ? (s.sessions[activeTabId]?.chatState ?? 'idle') !== 'idle' : false),
  )

  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setActiveSettingsTab = useUIStore((s) => s.setActiveSettingsTab)

  const t = useTranslation()

  // 项目分组：项目 = 会话的 projectRoot/workDir；无 root 的会话落「任务」组。
  const { projects, ungrouped } = useMemo(() => {
    const map = new Map<string, SessionListItem[]>()
    const loose: SessionListItem[] = []
    for (const s of sessions) {
      const root = (s.projectRoot ?? s.workDir ?? '').trim()
      if (!root) { loose.push(s); continue }
      const list = map.get(root) ?? []
      list.push(s)
      map.set(root, list)
    }
    const groups: ProjectGroup[] = [...map.entries()].map(([root, list]) => ({
      root,
      name: baseName(root),
      sessions: list,
    }))
    return { projects: groups, ungrouped: loose }
  }, [sessions])

  const openSession = (id: string, title: string) => {
    openTab(id, title || t('session.untitled'), 'session')
    connectToSession(id)
  }
  const openNewSession = async (workDir?: string) => {
    const id = await createSession(workDir)
    openTab(id, t('sidebar.newSession'), 'session')
    connectToSession(id)
  }
  const openTabView = (id: string, title: string, type: TabType) => openTab(id, title, type)

  const addProject = async () => {
    const host = getDesktopHost()
    if (!host.isDesktop || !host.dialogs?.open) return
    const picked = await host.dialogs.open({ directory: true })
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (dir) void openNewSession(dir)
  }

  return {
    t,
    sessions,
    activeId: activeTabId,
    activeTabType,
    runningActive,
    projects,
    ungrouped,
    effectiveTheme: resolveEffectiveTheme(theme),
    sidebarOpen,
    toggleTheme,
    toggleSidebar,
    refresh: fetchSessions,
    renameSession,
    deleteSession,
    openSession,
    openNewSession,
    openScheduled: () => openTabView(SCHEDULED_TAB_ID, t('sidebar.scheduled'), 'scheduled'),
    openImageWorkbench: () => openTabView(IMAGE_WORKBENCH_TAB_ID, '生成图片', 'image-workbench'),
    openVideoStudio: () => openTabView(VIDEO_STUDIO_TAB_ID, '剪视频', 'video-studio'),
    openSettings: () => {
      setActiveSettingsTab('general')
      openTabView(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
    },
    openPlugins: () => { openTabView(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings'); setActiveSettingsTab('plugins') },
    addProject,
    canAddProject: getDesktopHost().isDesktop && !!getDesktopHost().dialogs?.open,
  }
}

function ToolBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)]"
    >
      {children}
    </button>
  )
}

function NavItem({
  icon, label, active, disabled, title, onClick,
}: { icon: ReactNode; label: string; active?: boolean; disabled?: boolean; title?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      title={title}
      className="flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[var(--color-text-primary)] transition-colors enabled:hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-40"
      style={{ background: active ? 'var(--color-surface-selected)' : undefined }}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center"
        style={{ color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}
      >
        {icon}
      </span>
      <span className="flex-1 truncate text-[13.5px]">{label}</span>
    </button>
  )
}

function SectionHeader({
  label, open, onToggle, action,
}: { label: string; open: boolean; onToggle: () => void; action?: ReactNode }) {
  return (
    <div className="group/sect mt-2 flex w-full items-center gap-1 pr-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 px-2.5 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
      >
        <span className="transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>
          <ChevronDown size={12} />
        </span>
        <span>{label}</span>
      </button>
      {action && <span className="shrink-0 opacity-0 transition-opacity group-hover/sect:opacity-100">{action}</span>}
    </div>
  )
}

type CtxMenuItem = { label: string; icon: ReactNode; danger?: boolean; onClick: () => void }
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[176px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1.5"
      style={{ left: x, top: y, boxShadow: 'var(--shadow-popover)' }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => { onClose(); item.onClick() }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ color: item.danger ? 'var(--color-error)' : 'var(--color-text-primary)' }}
        >
          <span className="shrink-0">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  )
}

export interface DesktopSidebarProps {
  /** 移动抽屉里复用时传入；桌面默认无参渲染。 */
  isMobile?: boolean
  onRequestClose?: () => void
}

export function DesktopSidebar(_props: DesktopSidebarProps = {}) {
  const d = useSidebarData()
  const { t } = d

  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [tasksOpen, setTasksOpen] = useState(true)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => readJson(EXPANDED_KEY, {}))
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>(() => readJson(PROJECT_TASKS_EXPANDED_KEY, {}))
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; title: string } | null>(null)

  useEffect(() => { void d.refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setProjectOpen = (root: string, open: boolean) => {
    setExpandedProjects((m) => { const next = { ...m, [root]: open }; writeJson(EXPANDED_KEY, next); return next })
  }
  const setTasksExpanded = (root: string, open: boolean) => {
    setExpandedTasks((m) => { const next = { ...m, [root]: open }; writeJson(PROJECT_TASKS_EXPANDED_KEY, next); return next })
  }

  const q = query.trim().toLowerCase()
  const match = (s: SessionListItem) => !q || (s.title || '').toLowerCase().includes(q)

  const projectRows = d.projects
    .map((p) => ({ ...p, sessions: p.sessions.filter(match) }))
    .filter((p) => p.sessions.length > 0 || !q)
  const overflow = projectRows.length > 5
  const visibleProjects = overflow && !showAllProjects ? projectRows.slice(0, 5) : projectRows
  const ungrouped = d.ungrouped.filter(match)

  const commitRename = () => {
    if (editingId) {
      const v = editValue.trim()
      if (v) void d.renameSession(editingId, v)
    }
    setEditingId(null)
  }

  const renderRow = (s: SessionListItem) => {
    const active = s.id === d.activeId
    if (editingId === s.id) {
      return (
        <div key={s.id} className="mb-0.5 px-1">
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setEditingId(null) }}
            className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none"
            style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-primary)', border: '1px solid var(--color-brand)' }}
          />
        </div>
      )
    }
    const runningHere = active && d.runningActive
    return (
      <div
        key={s.id}
        className="group/row relative mb-0.5 flex w-full items-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ background: active ? 'var(--color-surface-selected)' : 'transparent' }}
      >
        <button
          type="button"
          onClick={() => d.openSession(s.id, s.title)}
          onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, id: s.id, title: s.title || '' }) }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pl-2.5 pr-7 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
            {s.title || t('sidebar.newSession')}
          </span>
          {runningHere && <Loader2 size={12} className="shrink-0 animate-spin text-[var(--color-text-tertiary)]" />}
        </button>
      </div>
    )
  }

  const host = getDesktopHost()
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  const macTrafficLightPad = host.isDesktop && isMac

  return (
    <aside
      data-testid="sidebar"
      className="relative flex h-full w-full min-w-0 shrink-0 flex-col"
      style={{ background: 'var(--color-app-sidebar)', borderRight: '1px solid var(--color-border)' }}
    >
      {/* 顶：红绿灯位(左) + 工具图标(右)。桌面 macOS 让出红绿灯位。 */}
      <div
        data-desktop-drag-region
        className={`flex h-[46px] items-center justify-end gap-0.5 px-2 ${macTrafficLightPad ? 'pl-[78px]' : ''}`}
      >
        <ToolBtn label={t('sidebar.collapse')} onClick={d.toggleSidebar}><PanelLeft size={17} /></ToolBtn>
        <ToolBtn label="搜索" onClick={() => setSearching((v) => !v)}><Search size={17} /></ToolBtn>
      </div>

      {/* 品牌行 */}
      <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
        <Smiley size={20} />
        <span className="text-[15px] font-semibold text-[var(--color-text-primary)]">BilliardBuddy</span>
      </div>

      {/* 搜索(点顶部🔍展开，过滤会话) */}
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

      {/* 主导航：新建任务 / 生成图片 / 剪视频 / 已安排 / 插件 */}
      <nav className="px-2 pb-1">
        <NavItem icon={<SquarePen size={17} />} label={t('sidebar.newSession')} onClick={() => void d.openNewSession()} />
        <NavItem icon={<Sparkles size={17} />} label="生成图片" active={d.activeTabType === 'image-workbench'} onClick={d.openImageWorkbench} />
        <NavItem icon={<Zap size={17} />} label="剪视频" active={d.activeTabType === 'video-studio'} onClick={d.openVideoStudio} />
        <NavItem icon={<Clock size={17} />} label={t('sidebar.scheduled')} active={d.activeTabType === 'scheduled'} onClick={d.openScheduled} />
        <NavItem icon={<Puzzle size={17} />} label="插件" active={d.activeTabType === 'settings'} onClick={d.openPlugins} />
      </nav>

      {/* 项目 + 任务 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <SectionHeader
          label="项目"
          open={projectsOpen}
          onToggle={() => setProjectsOpen((v) => !v)}
          action={
            d.canAddProject ? (
              <button
                type="button"
                onClick={() => void d.addProject()}
                title="添加新项目：选择一个文件夹"
                aria-label="添加新项目"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                <Plus size={14} />
              </button>
            ) : undefined
          }
        />
        {projectsOpen && (
          <div className="mb-1">
            {visibleProjects.map((p) => {
              const open = expandedProjects[p.root] ?? true
              const tasksExpanded = expandedTasks[p.root] === true
              const visibleTasks = tasksExpanded ? p.sessions : p.sessions.slice(0, PROJECT_TASK_PAGE_SIZE)
              const hasMore = p.sessions.length > PROJECT_TASK_PAGE_SIZE
              return (
                <div key={p.root} className="mb-0.5">
                  <div className="group/proj flex h-[34px] w-full items-center rounded-lg pr-1 transition-colors hover:bg-[var(--color-surface-hover)]">
                    <button
                      type="button"
                      onClick={() => setProjectOpen(p.root, !open)}
                      className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left"
                      title={p.root}
                      aria-expanded={open}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
                        {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-primary)]">{p.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void d.openNewSession(p.root)}
                      title={`在 ${p.name} 中新建任务`}
                      aria-label={`在 ${p.name} 中新建任务`}
                      className="shrink-0 rounded p-1 text-[var(--color-text-secondary)] opacity-0 transition-opacity hover:bg-[var(--color-surface-hover)] group-hover/proj:opacity-70"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {open && (
                    p.sessions.length > 0 ? (
                      <div className="ml-6 mt-1">
                        {visibleTasks.map(renderRow)}
                        {hasMore && (
                          <button
                            type="button"
                            onClick={() => setTasksExpanded(p.root, !tasksExpanded)}
                            className="mb-0.5 w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-hover)]"
                          >
                            {tasksExpanded ? '折叠显示' : '展开显示'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="ml-6 px-2.5 py-1 text-[12px] text-[var(--color-text-tertiary)]">还没有任务，点 + 开一个</div>
                    )
                  )}
                </div>
              )
            })}
            {overflow && (
              <button
                type="button"
                onClick={() => setShowAllProjects((v) => !v)}
                className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-text-tertiary)] opacity-75 transition-opacity hover:opacity-100"
              >
                {showAllProjects ? '收起' : `显示更多（${projectRows.length - visibleProjects.length}）`}
              </button>
            )}
          </div>
        )}

        <SectionHeader label="任务" open={tasksOpen} onToggle={() => setTasksOpen((v) => !v)} />
        {tasksOpen && (
          <div className="mb-2">
            {d.sessions.length === 0 ? (
              <button
                type="button"
                onClick={() => void d.openNewSession()}
                className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left"
                style={{ background: 'var(--color-surface-selected)' }}
              >
                <span className="truncate text-[13px] text-[var(--color-text-primary)]">{t('sidebar.newSession')}</span>
              </button>
            ) : ungrouped.length === 0 ? (
              q ? <div className="px-2.5 py-1.5 text-[12px] text-[var(--color-text-tertiary)]">没有匹配的任务</div> : null
            ) : (
              ungrouped.map(renderRow)
            )}
          </div>
        )}
      </div>

      {/* 底部：设置 + 主题切换 */}
      <div className="flex items-center gap-1 px-2 py-2" style={{ borderTop: '1px solid var(--color-border)' }}>
        <button
          type="button"
          onClick={d.openSettings}
          className="flex h-9 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <span className="shrink-0 text-[var(--color-text-secondary)]"><SettingsIcon size={17} /></span>
          <span className="text-[13.5px]">{t('sidebar.settings')}</span>
        </button>
        <ToolBtn label="切换主题" onClick={d.toggleTheme}>
          {d.effectiveTheme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </ToolBtn>
      </div>

      {/* 会话右键菜单：当前后端有真实支撑的 重命名 / 删除（旧的 置顶/归档/fork 无后端字段，暂不挂）。 */}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: '重命名',
              icon: <Pencil size={15} />,
              onClick: () => { setEditingId(ctx.id); setEditValue(ctx.title) },
            },
            {
              label: '删除',
              icon: <Trash2 size={15} />,
              danger: true,
              onClick: () => { void d.deleteSession(ctx.id) },
            },
          ]}
        />
      )}
    </aside>
  )
}
