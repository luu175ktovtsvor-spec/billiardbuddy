// Desktop product navigation backed by the BilliardBuddy task model and its
// restricted product-task runtime.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  PanelLeft, Search, SquarePen, Clock, Puzzle,
  Folder, FolderOpen, Settings as SettingsIcon, ChevronDown, Sun, Moon,
  Sparkles, Zap, Plus, Loader2, ListTodo, Pin,
} from 'lucide-react'
import { useUIStore, resolveEffectiveTheme } from '../../stores/uiStore'
import {
  useTabStore,
  SETTINGS_TAB_ID,
  SCHEDULED_TAB_ID,
  IMAGE_WORKBENCH_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  PRODUCT_TASKS_TAB_ID,
  type OpenTabType,
} from '../../stores/tabStore'
import { useTranslation } from '../../i18n'
import { Smiley } from '../shared/Smiley'
import { getDesktopHost } from '../../lib/desktopHost'
import { useProductTaskStore } from '../../product/stores/productTaskStore'
import type { ProductProject, ProductTaskRecord } from '../../product/domain/types'
import { openProductTaskComposer } from '../../product/openTaskComposer'
import { orderProductProjects, orderProductTasks } from '../../product/taskOrdering'
import { useProductTaskRuntimeStore } from '../../product/stores/productTaskRuntimeStore'
import { getProductTaskRuntimeStateFromStream } from '../../product/taskRuntime'

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

type ProductProjectGroup = ProductProject & { tasks: ProductTaskRecord[] }

/** 仅负责将产品任务映射为桌面导航与受限运行时状态。 */
function useSidebarData() {
  const index = useProductTaskStore((s) => s.index)
  const refresh = useProductTaskStore((s) => s.refresh)

  const activeTab = useTabStore((s) => s.tabs.find((tab) => tab.sessionId === s.activeTabId))
  const activeTabType = activeTab?.type ?? null
  const openTab = useTabStore((s) => s.openTab)
  const openProductTaskTab = useTabStore((s) => s.openProductTaskTab)
  const taskRuntimes = useProductTaskRuntimeStore((s) => s.tasks)
  const activeTaskId = activeTab?.type === 'product-task' ? activeTab.taskId ?? null : null
  const activeTaskRuntime = getProductTaskRuntimeStateFromStream(
    activeTaskId ? taskRuntimes[activeTaskId] : undefined,
  )
  const runningActive = activeTaskRuntime === 'running' || activeTaskRuntime === 'connecting'

  const theme = useUIStore((s) => s.theme)
  const toggleTheme = useUIStore((s) => s.toggleTheme)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const setActiveSettingsTab = useUIStore((s) => s.setActiveSettingsTab)

  const t = useTranslation()

  const { activeTasks, projects, ungrouped } = useMemo(() => {
    const activeTasks = orderProductTasks(index.tasks.filter((task) => task.lifecycle !== 'archived'))
    const orderedProjects = orderProductProjects(index.projects, activeTasks)
    const projectIds = new Set(orderedProjects.map((project) => project.id))
    const groups: ProductProjectGroup[] = orderedProjects
      .map((project) => ({
        ...project,
        tasks: activeTasks.filter((task) => task.projectId === project.id),
      }))
      .filter((project) => project.tasks.length > 0)
    return {
      activeTasks,
      projects: groups,
      ungrouped: activeTasks.filter((task) => !projectIds.has(task.projectId)),
    }
  }, [index])

  const openTask = (task: ProductTaskRecord) => {
    openProductTaskTab(task.id, task.title || t('session.untitled'))
  }
  const openProductTasks = () => {
    openTab(PRODUCT_TASKS_TAB_ID, '任务中心', 'product-tasks')
  }
  const openNewTask = (workDir?: string) => {
    openProductTaskComposer(workDir)
  }
  const openTabView = (id: string, title: string, type: OpenTabType) => openTab(id, title, type)

  return {
    t,
    tasks: activeTasks,
    activeId: activeTaskId,
    activeTabType,
    runningActive,
    projects,
    ungrouped,
    effectiveTheme: resolveEffectiveTheme(theme),
    toggleTheme,
    toggleSidebar,
    refresh,
    openTask,
    openNewTask,
    openScheduled: () => openTabView(SCHEDULED_TAB_ID, t('sidebar.scheduled'), 'scheduled'),
    openProductTasks,
    openImageWorkbench: () => openTabView(IMAGE_WORKBENCH_TAB_ID, '生成图片', 'image-workbench'),
    openVideoStudio: () => openTabView(VIDEO_STUDIO_TAB_ID, '剪视频', 'video-studio'),
    openSettings: () => {
      setActiveSettingsTab('general')
      openTabView(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
    },
    openPlugins: () => { openTabView(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings'); setActiveSettingsTab('plugins') },
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
  label, open, onToggle,
}: { label: string; open: boolean; onToggle: () => void }) {
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
    </div>
  )
}

export function DesktopSidebar() {
  const d = useSidebarData()
  const { t } = d

  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [tasksOpen, setTasksOpen] = useState(true)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => readJson(EXPANDED_KEY, {}))
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>(() => readJson(PROJECT_TASKS_EXPANDED_KEY, {}))
  const [showAllProjects, setShowAllProjects] = useState(false)

  useEffect(() => { void d.refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const setProjectOpen = (projectId: string, open: boolean) => {
    setExpandedProjects((m) => { const next = { ...m, [projectId]: open }; writeJson(EXPANDED_KEY, next); return next })
  }
  const setTasksExpanded = (projectId: string, open: boolean) => {
    setExpandedTasks((m) => { const next = { ...m, [projectId]: open }; writeJson(PROJECT_TASKS_EXPANDED_KEY, next); return next })
  }

  const q = query.trim().toLowerCase()
  const match = (task: ProductTaskRecord) => !q || [task.title, task.workDir]
    .some((value) => value.toLowerCase().includes(q))

  const projectRows = d.projects
    .map((project) => ({ ...project, tasks: project.tasks.filter(match) }))
    .filter((project) => project.tasks.length > 0 || !q)
  const overflow = projectRows.length > 5
  const visibleProjects = overflow && !showAllProjects ? projectRows.slice(0, 5) : projectRows
  const ungrouped = d.ungrouped.filter(match)

  const renderRow = (task: ProductTaskRecord) => {
    const active = task.id === d.activeId
    const runningHere = active && d.runningActive
    return (
      <div
        key={task.id}
        className="group/row relative mb-0.5 flex w-full items-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ background: active ? 'var(--color-surface-selected)' : 'transparent' }}
      >
        <button
          type="button"
          onClick={() => d.openTask(task)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1.5 pl-2.5 pr-7 text-left"
        >
          <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
            {task.title || t('sidebar.newSession')}
          </span>
          {task.pinnedAt ? (
            <span title="已置顶" aria-label="已置顶" className="shrink-0 text-[var(--color-text-tertiary)]">
              <Pin size={12} aria-hidden="true" />
            </span>
          ) : null}
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

      {/* 搜索（点顶部放大镜展开，过滤任务） */}
      {searching && (
        <div className="px-3 pb-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务…"
            className="w-full rounded-md px-2.5 py-1.5 text-[13px] outline-none"
            style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
          />
        </div>
      )}

      {/* 主导航：新建任务 / 任务中心 / 生成图片 / 剪视频 / 已安排 / 插件 */}
      <nav className="px-2 pb-1">
        <NavItem icon={<SquarePen size={17} />} label={t('sidebar.newSession')} onClick={() => d.openNewTask()} />
        <NavItem icon={<ListTodo size={17} />} label="任务中心" active={d.activeTabType === 'product-tasks'} onClick={d.openProductTasks} />
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
        />
        {projectsOpen && (
          <div className="mb-1">
            {visibleProjects.map((project) => {
              const open = expandedProjects[project.id] ?? true
              const tasksExpanded = expandedTasks[project.id] === true
              const visibleTasks = tasksExpanded ? project.tasks : project.tasks.slice(0, PROJECT_TASK_PAGE_SIZE)
              const hasMore = project.tasks.length > PROJECT_TASK_PAGE_SIZE
              return (
                <div key={project.id} className="mb-0.5">
                  <div className="group/proj flex h-[34px] w-full items-center rounded-lg pr-1 transition-colors hover:bg-[var(--color-surface-hover)]">
                    <button
                      type="button"
                      onClick={() => setProjectOpen(project.id, !open)}
                      className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-2.5 text-left"
                      title={project.workDir}
                      aria-expanded={open}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
                        {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-primary)]">{project.title}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => d.openNewTask(project.workDir)}
                      title={`在 ${project.title} 中新建任务`}
                      aria-label={`在 ${project.title} 中新建任务`}
                      className="shrink-0 rounded p-1 text-[var(--color-text-secondary)] opacity-0 transition-opacity hover:bg-[var(--color-surface-hover)] group-hover/proj:opacity-70"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {open && (
                    project.tasks.length > 0 ? (
                      <div className="ml-6 mt-1">
                        {visibleTasks.map(renderRow)}
                        {hasMore && (
                          <button
                            type="button"
                            onClick={() => setTasksExpanded(project.id, !tasksExpanded)}
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
            {d.tasks.length === 0 ? (
              <button
                type="button"
                onClick={() => d.openNewTask()}
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

    </aside>
  )
}
