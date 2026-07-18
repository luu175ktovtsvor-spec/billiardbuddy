// DesktopSidebar —— 视觉/布局/交互移植自旧仓库 renderer-react 的 Sidebar.tsx(Codex 风格:
// 红绿灯位+工具图标一行 → 品牌行 → 主导航 → 可折叠分组区 → 底部设置),但数据与能力全部
// 接当前仓库真实 store(sessionStore/tabStore/uiStore + chatStore/openTargetStore),
// 不引入旧仓库任何 store/api/lib。旧版按目录聚合“项目”的模型(项目/任务两个独立分组、
// resize 拖宽、超过 5 个项目折叠)在当前数据模型里没有对应物,已按当前真实实现改写——
// 逐条取舍见组件末尾的移植说明(仅供人读,不影响运行)。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  Clock,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation, type TranslationKey } from '../../i18n'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { Smiley } from '../shared/Smiley'
import { GlobalSearchModal } from '../search/GlobalSearchModal'
import type { SessionListItem } from '../../types/session'
import { useTabStore, SETTINGS_TAB_ID, SCHEDULED_TAB_ID } from '../../stores/tabStore'
import { useChatStore } from '../../stores/chatStore'
import { useOpenTargetStore } from '../../stores/openTargetStore'
import { desktopUiPreferencesApi, type SidebarProjectPreferences } from '../../api/desktopUiPreferences'
import { getDesktopHost } from '../../lib/desktopHost'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'

const desktopHost = getDesktopHost()
const isDesktopRuntime = desktopHost.isDesktop
const canUseNativeDialogs = desktopHost.capabilities.dialogs
const isWindows = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)
const SESSION_LIST_AUTO_REFRESH_MS = 30_000
const SESSION_LIST_FOCUS_REFRESH_MIN_MS = 5_000
// 沿用当前仓库既有的 localStorage key(与旧 Sidebar.tsx 同名 key 不同、与当前 Sidebar.tsx 相同),
// 目的是这个新组件换皮上线时用户的项目排序/置顶/隐藏偏好能直接接续,不会因为换组件丢失。
const PROJECT_ORDER_STORAGE_KEY = 'billiardbuddy-sidebar-project-order'
const PROJECT_PINNED_STORAGE_KEY = 'billiardbuddy-sidebar-pinned-projects'
const PROJECT_HIDDEN_STORAGE_KEY = 'billiardbuddy-sidebar-hidden-projects'
const PROJECT_ORGANIZATION_STORAGE_KEY = 'billiardbuddy-sidebar-project-organization'
const PROJECT_SORT_STORAGE_KEY = 'billiardbuddy-sidebar-project-sort'
const PROJECT_GROUP_VISIBLE_COUNT = 6
const PROJECT_GROUP_SCROLL_COUNT = 12

type SidebarProjectOrganization = 'project' | 'recentProject' | 'time'
type SidebarProjectSortBy = 'createdAt' | 'updatedAt'
type SidebarHeaderMenuType = 'main' | 'organize' | 'sort' | 'create'

type ProjectGroup = {
  key: string
  title: string
  subtitle: string | null
  workDir: string | undefined
  sessions: SessionListItem[]
}

type DesktopSidebarProps = {
  isMobile?: boolean
  onRequestClose?: () => void
}

// —— 旧版视觉小件(ToolBtn/NavItem/SectionHeader):按旧 Sidebar.tsx 的密度/圆角/取色抄一份,
// 但颜色只走当前 CSS token(旧版 --color-app-sidebar 当前不存在,已替换,见文末替换清单)。 ——
function ToolBtn({
  label,
  onClick,
  active,
  testId,
  children,
}: {
  label: string
  onClick?: () => void
  active?: boolean
  testId?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{
        color: active ? 'var(--color-brand)' : 'var(--color-text-tertiary)',
        background: active ? 'var(--color-surface-selected)' : undefined,
      }}
    >
      {children}
    </button>
  )
}

function NavItem({
  icon,
  label,
  active,
  collapsed,
  touchFriendly,
  onClick,
}: {
  icon: ReactNode
  label: string
  active?: boolean
  collapsed?: boolean
  touchFriendly?: boolean
  onClick?: () => void
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        aria-current={active ? 'page' : undefined}
        className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{
          color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)',
          background: active ? 'var(--color-surface-selected)' : undefined,
        }}
      >
        {icon}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] ${touchFriendly ? 'py-3' : ''}`}
      style={{ color: 'var(--color-text-primary)', background: active ? 'var(--color-surface-selected)' : undefined }}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: active ? 'var(--color-brand)' : 'var(--color-text-secondary)' }}>
        {icon}
      </span>
      <span className="flex-1 truncate text-[13.5px]">{label}</span>
    </button>
  )
}

function SectionHeader({
  label,
  count,
  open,
  onToggle,
  action,
}: {
  label: string
  count?: number
  open: boolean
  onToggle: () => void
  action?: ReactNode
}) {
  return (
    <div className="group/sect mt-1 flex w-full items-center gap-1 pr-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1 text-left text-[11px] font-medium uppercase tracking-wide transition-colors hover:text-[var(--color-text-secondary)]"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        <span className="transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>
          <ChevronDown size={12} />
        </span>
        <span>{label}</span>
        {count !== undefined && <span style={{ opacity: 0.7 }}>{count}</span>}
      </button>
      {/* 区头动作(对齐旧版:hover 才显示,如"项目"区的 ... / + )。 */}
      {action && (
        <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/sect:opacity-100 group-focus-within/sect:opacity-100">
          {action}
        </span>
      )}
    </div>
  )
}

// —— 统一菜单外观(右键菜单 / 项目区头下拉菜单都用它):照旧版 ContextMenu/MenuList 的圆角+
// 发丝边+阴影风格重画,颜色/阴影换成当前主题已有的 token(--shadow-dropdown 替代旧版
// --shadow-popover,--color-surface-container-lowest 替代旧版半透明+backdrop-blur,
// 与当前应用其余下拉菜单的实际做法保持一致)。 ——
function MenuPanel({ x, y, width = 220, children }: { x: number; y: number; width?: number; children: ReactNode }) {
  return (
    <div
      role="menu"
      className="fixed z-50 overflow-hidden rounded-[14px] border py-1.5"
      style={{
        left: x,
        top: y,
        width,
        borderColor: 'var(--color-border)',
        background: 'var(--color-surface-container-lowest)',
        boxShadow: 'var(--shadow-dropdown)',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  )
}

function MenuButton({
  icon,
  children,
  onClick,
  onMouseEnter,
  checked = false,
  trailing = false,
  danger = false,
  shortcut,
  disabled = false,
}: {
  icon?: ReactNode
  children: ReactNode
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onMouseEnter?: (event: React.MouseEvent<HTMLButtonElement>) => void
  checked?: boolean
  trailing?: boolean
  danger?: boolean
  shortcut?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className="flex min-h-8 w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-40"
      style={{ color: danger ? 'var(--color-error)' : 'var(--color-text-primary)' }}
    >
      {icon && (
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          style={{ color: danger ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && (
        <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {shortcut}
        </span>
      )}
      {checked && <Check className="h-[15px] w-[15px] shrink-0" style={{ color: 'var(--color-text-secondary)' }} aria-hidden="true" />}
      {trailing && !checked && (
        <ChevronDown className="h-[15px] w-[15px] shrink-0 -rotate-90" style={{ color: 'var(--color-text-tertiary)' }} aria-hidden="true" />
      )}
    </button>
  )
}

function MenuSeparator() {
  return <div className="mx-2 my-1 h-px" style={{ background: 'var(--color-border)' }} />
}

export function DesktopSidebar({ isMobile = false, onRequestClose }: DesktopSidebarProps) {
  const t = useTranslation()
  const sessions = useSessionStore((s) => s.sessions)
  const isLoading = useSessionStore((s) => s.isLoading)
  const error = useSessionStore((s) => s.error)
  const fetchSessions = useSessionStore((s) => s.fetchSessions)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const deleteSessions = useSessionStore((s) => s.deleteSessions)
  const isBatchMode = useSessionStore((s) => s.isBatchMode)
  const selectedSessionIds = useSessionStore((s) => s.selectedSessionIds)
  const enterBatchMode = useSessionStore((s) => s.enterBatchMode)
  const exitBatchMode = useSessionStore((s) => s.exitBatchMode)
  const toggleSessionSelected = useSessionStore((s) => s.toggleSessionSelected)
  const selectSessions = useSessionStore((s) => s.selectSessions)
  const deselectSessions = useSessionStore((s) => s.deselectSessions)
  const renameSession = useSessionStore((s) => s.renameSession)
  const addToast = useUIStore((s) => s.addToast)
  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const activeModal = useUIStore((s) => s.activeModal)
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const chatSessions = useChatStore((s) => s.sessions)
  const closeTab = useTabStore((s) => s.closeTab)
  const disconnectSession = useChatStore((s) => s.disconnectSession)

  // 旧版"项目"区可以整体折叠(SectionHeader + projectsOpen)。当前数据模型里所有会话都落在
  // 项目分组里(见 groupByProject),没有旧版"项目/任务"两个独立分组的区分——这里只保留
  // 一个可折叠的"项目"总区,单个项目行仍各自独立折叠/展开(collapsedProjectKeys)。
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [projectContextMenu, setProjectContextMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [projectHeaderMenu, setProjectHeaderMenu] = useState<{ type: SidebarHeaderMenuType; x: number; y: number } | null>(null)
  const [projectHeaderSubmenu, setProjectHeaderSubmenu] = useState<{ type: 'organize' | 'sort'; x: number; y: number } | null>(null)
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null)
  const [pendingBatchDeleteSessionIds, setPendingBatchDeleteSessionIds] = useState<string[] | null>(null)
  const [isBatchDeleting, setIsBatchDeleting] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [lastSelectedSessionId, setLastSelectedSessionId] = useState<string | null>(null)
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(new Set())
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<Set<string>>(new Set())
  const [projectOrder, setProjectOrder] = useState<string[]>(() => readStoredProjectOrder())
  const [pinnedProjectKeys, setPinnedProjectKeys] = useState<Set<string>>(() => readStoredProjectPins())
  const [hiddenProjectKeys, setHiddenProjectKeys] = useState<Set<string>>(() => readStoredProjectHidden())
  const [projectOrganization, setProjectOrganizationState] = useState<SidebarProjectOrganization>(() => readStoredProjectOrganization())
  const [projectSortBy, setProjectSortByState] = useState<SidebarProjectSortBy>(() => readStoredProjectSortBy())
  const [draggingProjectKey, setDraggingProjectKey] = useState<string | null>(null)
  const [projectDropTarget, setProjectDropTarget] = useState<{ key: string; position: 'before' | 'after' } | null>(null)
  const suppressProjectClickRef = useRef<string | null>(null)
  const sidebarPreferenceRevisionRef = useRef(0)
  const refreshSessionsNow = useSessionListAutoRefresh(fetchSessions)

  useEffect(() => {
    if (!contextMenu) return
    if (!sidebarOpen) setContextMenu(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen])

  useEffect(() => {
    if (!contextMenu && !projectContextMenu && !projectHeaderMenu && !projectHeaderSubmenu) return
    const close = () => {
      setContextMenu(null)
      setProjectContextMenu(null)
      setProjectHeaderMenu(null)
      setProjectHeaderSubmenu(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [contextMenu, projectContextMenu, projectHeaderMenu, projectHeaderSubmenu])

  // 标题过滤已经挪进全局搜索弹窗(Cmd+K),侧栏本身展示全部会话。
  const filteredSessions = sessions

  const projectGroups = useMemo(() => groupByProject(filteredSessions, projectSortBy), [filteredSessions, projectSortBy])
  const orderedProjectGroups = useMemo(
    () => applyProjectOrder(projectGroups, projectOrder, pinnedProjectKeys, projectOrganization, projectSortBy),
    [projectGroups, projectOrder, pinnedProjectKeys, projectOrganization, projectSortBy],
  )
  const visibleProjectGroups = useMemo(() => {
    if (hiddenProjectKeys.size === 0) return orderedProjectGroups
    return orderedProjectGroups.filter((project) => !hiddenProjectKeys.has(project.key))
  }, [hiddenProjectKeys, orderedProjectGroups])
  const showInitialLoading = isLoading && sessions.length === 0
  const showRefreshLoading = showInitialLoading
  const filteredSessionIds = useMemo(() => filteredSessions.map((session) => session.id), [filteredSessions])
  const selectedCount = selectedSessionIds.size
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions])
  const runningSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const tab of tabs) {
      if (tab.type === 'session' && tab.status === 'running') ids.add(tab.sessionId)
    }
    for (const [sessionId, sessionState] of Object.entries(chatSessions)) {
      if (sessionState.chatState !== 'idle' || hasRunningBackgroundTasks(sessionState.backgroundAgentTasks)) {
        ids.add(sessionId)
      }
    }
    return ids
  }, [chatSessions, tabs])
  const pendingBatchDeleteSessions = useMemo(
    () => (pendingBatchDeleteSessionIds ?? [])
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is SessionListItem => Boolean(session)),
    [pendingBatchDeleteSessionIds, sessionsById],
  )
  const expanded = isMobile ? true : sidebarOpen
  const closeMobileDrawer = useCallback(() => {
    if (isMobile) onRequestClose?.()
  }, [isMobile, onRequestClose])

  const applySidebarProjectPreferences = useCallback((preferences: SidebarProjectPreferences) => {
    setProjectOrder(preferences.projectOrder)
    setPinnedProjectKeys(new Set(preferences.pinnedProjects))
    setHiddenProjectKeys(new Set(preferences.hiddenProjects))
    setProjectOrganizationState(preferences.projectOrganization)
    setProjectSortByState(preferences.projectSortBy)
  }, [])

  const persistSidebarProjectPreferences = useCallback((preferences: SidebarProjectPreferences) => {
    const normalized = normalizeSidebarProjectPreferences(preferences)
    sidebarPreferenceRevisionRef.current += 1
    writeCachedSidebarProjectPreferences(normalized)
    void desktopUiPreferencesApi.updateSidebarPreferences(normalized).catch(() => undefined)
  }, [])

  const restoreHiddenProjectForWorkDir = useCallback((workDir: string | null | undefined) => {
    if (!workDir) return
    setHiddenProjectKeys((current) => {
      const next = new Set([...current].filter((projectKey) => !projectPathMatches(projectKey, workDir)))
      if (next.size === current.size) return current
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(
        projectOrder,
        pinnedProjectKeys,
        next,
        projectOrganization,
        projectSortBy,
      ))
      return next
    })
  }, [persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectOrganization, projectSortBy])

  useEffect(() => {
    let cancelled = false
    const startRevision = sidebarPreferenceRevisionRef.current

    void desktopUiPreferencesApi.getPreferences()
      .then((response) => {
        if (cancelled || startRevision !== sidebarPreferenceRevisionRef.current) return

        const localPreferences = readCachedSidebarProjectPreferences()
        const serverPreferences = normalizeSidebarProjectPreferences(response.preferences.sidebar)
        const effectivePreferences = response.exists ? serverPreferences : localPreferences

        applySidebarProjectPreferences(effectivePreferences)
        writeCachedSidebarProjectPreferences(effectivePreferences)

        if (!response.exists && hasSidebarProjectPreferences(localPreferences)) {
          void desktopUiPreferencesApi.updateSidebarPreferences(localPreferences).catch(() => undefined)
        }
      })
      .catch(() => {
        // 服务端还在启动时,侧栏仍用本地缓存保持可用。
      })

    return () => {
      cancelled = true
    }
  }, [applySidebarProjectPreferences])

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    if (isBatchMode) return
    setContextMenu({ id, x: e.clientX, y: e.clientY })
  }, [isBatchMode])

  const handleProjectDragStart = useCallback((event: React.DragEvent, projectKey: string) => {
    if (isBatchMode) {
      event.preventDefault()
      return
    }
    suppressProjectClickRef.current = projectKey
    setDraggingProjectKey(projectKey)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', projectKey)
  }, [isBatchMode])

  const handleProjectDragOver = useCallback((event: React.DragEvent<HTMLElement>, projectKey: string) => {
    const sourceProjectKey = draggingProjectKey || event.dataTransfer.getData('text/plain')
    if (!sourceProjectKey || sourceProjectKey === projectKey) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const position = getProjectDropPosition(event)
    setProjectDropTarget((current) => (
      current?.key === projectKey && current.position === position
        ? current
        : { key: projectKey, position }
    ))
  }, [draggingProjectKey])

  const clearProjectDragState = useCallback(() => {
    setDraggingProjectKey(null)
    setProjectDropTarget(null)
    window.setTimeout(() => {
      suppressProjectClickRef.current = null
    }, 0)
  }, [])

  const handleProjectDrop = useCallback((event: React.DragEvent<HTMLElement>, targetProjectKey: string) => {
    event.preventDefault()
    const sourceProjectKey = draggingProjectKey || event.dataTransfer.getData('text/plain')
    const dropPosition = projectDropTarget?.key === targetProjectKey
      ? projectDropTarget.position
      : getProjectDropPosition(event)
    if (!sourceProjectKey || sourceProjectKey === targetProjectKey) {
      clearProjectDragState()
      return
    }

    const nextOrder = moveProjectKey(
      orderedProjectGroups.map((project) => project.key),
      sourceProjectKey,
      targetProjectKey,
      dropPosition,
    )
    setProjectOrder(nextOrder)
    persistSidebarProjectPreferences(buildSidebarProjectPreferences(nextOrder, pinnedProjectKeys, hiddenProjectKeys, projectOrganization, projectSortBy))
    clearProjectDragState()
  }, [clearProjectDragState, draggingProjectKey, hiddenProjectKeys, orderedProjectGroups, persistSidebarProjectPreferences, pinnedProjectKeys, projectDropTarget, projectOrganization, projectSortBy])

  const createSessionForWorkDir = useCallback(async (workDir?: string) => {
    try {
      const sessionId = await useSessionStore.getState().createSession(workDir)
      restoreHiddenProjectForWorkDir(workDir)
      useTabStore.getState().openTab(sessionId, t('sidebar.newSession'))
      useChatStore.getState().connectToSession(sessionId)
      closeMobileDrawer()
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('sidebar.sessionListFailed'),
      })
    }
  }, [addToast, closeMobileDrawer, restoreHiddenProjectForWorkDir, t])

  const openProjectHeaderMenu = useCallback((event: React.MouseEvent, type: SidebarHeaderMenuType) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const width = type === 'create' ? 250 : 270
    setProjectContextMenu(null)
    setContextMenu(null)
    setProjectHeaderSubmenu(null)
    setProjectHeaderMenu({
      type,
      x: Math.max(10, Math.min(rect.right - width, window.innerWidth - width - 10)),
      y: rect.bottom + 8,
    })
  }, [])

  const openProjectHeaderSubmenu = useCallback((event: React.MouseEvent, type: 'organize' | 'sort') => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    const width = type === 'sort' ? 230 : 260
    setProjectHeaderSubmenu({
      type,
      x: Math.max(10, Math.min(rect.right + 8, window.innerWidth - width - 10)),
      y: Math.max(10, Math.min(rect.top - 8, window.innerHeight - 170)),
    })
  }, [])

  const updateProjectOrganization = useCallback((organization: SidebarProjectOrganization) => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    setProjectOrganizationState(organization)
    const nextOrder = organization === 'project' || organization === 'time' ? [] : projectOrder
    if (nextOrder !== projectOrder) setProjectOrder(nextOrder)
    persistSidebarProjectPreferences(buildSidebarProjectPreferences(
      nextOrder,
      pinnedProjectKeys,
      hiddenProjectKeys,
      organization,
      projectSortBy,
    ))
  }, [hiddenProjectKeys, persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectSortBy])

  const updateProjectSortBy = useCallback((sortBy: SidebarProjectSortBy) => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    setProjectSortByState(sortBy)
    const nextOrder: string[] = []
    setProjectOrder(nextOrder)
    persistSidebarProjectPreferences(buildSidebarProjectPreferences(
      nextOrder,
      pinnedProjectKeys,
      hiddenProjectKeys,
      projectOrganization,
      sortBy,
    ))
  }, [hiddenProjectKeys, persistSidebarProjectPreferences, pinnedProjectKeys, projectOrganization])

  const createSessionFromExistingFolder = useCallback(async () => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    if (!canUseNativeDialogs) {
      addToast({
        type: 'error',
        message: t('sidebar.chooseProjectFolderUnavailable'),
      })
      return
    }
    try {
      const selected = await getDesktopHost().dialogs.open({
        directory: true,
        multiple: false,
        title: t('sidebar.useExistingFolder'),
      })
      if (typeof selected === 'string' && selected.trim()) {
        await createSessionForWorkDir(selected)
      }
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('sidebar.sessionListFailed'),
      })
    }
  }, [addToast, createSessionForWorkDir, t])

  const togglePinnedProject = useCallback((projectKey: string) => {
    setProjectContextMenu(null)
    setPinnedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(projectOrder, next, hiddenProjectKeys, projectOrganization, projectSortBy))
      return next
    })
  }, [hiddenProjectKeys, persistSidebarProjectPreferences, projectOrder, projectOrganization, projectSortBy])

  const restoreAllHiddenProjects = useCallback(() => {
    setProjectHeaderMenu(null)
    setProjectHeaderSubmenu(null)
    setHiddenProjectKeys((current) => {
      if (current.size === 0) return current
      const next = new Set<string>()
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(
        projectOrder,
        pinnedProjectKeys,
        next,
        projectOrganization,
        projectSortBy,
      ))
      return next
    })
  }, [persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectOrganization, projectSortBy])

  const toggleHiddenProject = useCallback((project: ProjectGroup) => {
    const wasHidden = hiddenProjectKeys.has(project.key)
    setProjectContextMenu(null)
    setHiddenProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(project.key)) {
        next.delete(project.key)
      } else {
        next.add(project.key)
      }
      persistSidebarProjectPreferences(buildSidebarProjectPreferences(projectOrder, pinnedProjectKeys, next, projectOrganization, projectSortBy))
      return next
    })
    if (!wasHidden) {
      addToast({
        type: 'info',
        message: t('sidebar.projectHidden', { project: project.title }),
      })
    }
  }, [addToast, hiddenProjectKeys, persistSidebarProjectPreferences, pinnedProjectKeys, projectOrder, projectOrganization, projectSortBy, t])

  const openProjectInFinder = useCallback(async (project: ProjectGroup) => {
    setProjectContextMenu(null)
    try {
      if (!project.workDir) {
        throw new Error(t('sidebar.openInFinderUnavailable'))
      }
      const store = useOpenTargetStore.getState()
      await store.ensureTargets()
      const latest = useOpenTargetStore.getState()
      const target = latest.targets.find((item) => item.id === 'finder')
        ?? latest.targets.find((item) => item.kind === 'file_manager')
      if (!target) {
        throw new Error(t('sidebar.openInFinderUnavailable'))
      }
      await latest.openTarget(target.id, project.workDir)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('sidebar.openInFinderFailed'),
      })
    }
  }, [addToast, t])

  const handleDelete = useCallback((id: string) => {
    setContextMenu(null)
    setPendingDeleteSessionId(id)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteSessionId) return
    await deleteSession(pendingDeleteSessionId)
    disconnectSession(pendingDeleteSessionId)
    closeTab(pendingDeleteSessionId)
    setPendingDeleteSessionId(null)
  }, [closeTab, deleteSession, disconnectSession, pendingDeleteSessionId])

  const handleBatchSessionClick = useCallback((event: React.MouseEvent, id: string) => {
    if (event.shiftKey && lastSelectedSessionId) {
      const start = filteredSessionIds.indexOf(lastSelectedSessionId)
      const end = filteredSessionIds.indexOf(id)
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start]
        selectSessions(filteredSessionIds.slice(from, to + 1))
        setLastSelectedSessionId(id)
        return
      }
    }

    toggleSessionSelected(id)
    setLastSelectedSessionId(id)
  }, [filteredSessionIds, lastSelectedSessionId, selectSessions, toggleSessionSelected])

  const handleExitBatchMode = useCallback(() => {
    exitBatchMode()
    setLastSelectedSessionId(null)
    setPendingBatchDeleteSessionIds(null)
  }, [exitBatchMode])

  const requestBatchDelete = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    setPendingBatchDeleteSessionIds([...new Set(ids)])
  }, [])

  const confirmBatchDelete = useCallback(async () => {
    const ids = pendingBatchDeleteSessionIds ?? []
    if (ids.length === 0) return

    setIsBatchDeleting(true)
    try {
      const result = await deleteSessions(ids)
      for (const sessionId of result.successes) {
        disconnectSession(sessionId)
        closeTab(sessionId)
      }

      if (result.failures.length > 0) {
        addToast({
          type: 'error',
          message: t('sidebar.batchDeleteFailed', { count: result.failures.length }),
        })
      } else {
        addToast({
          type: 'success',
          message: t('sidebar.batchDeleteSucceeded', { count: result.successes.length }),
        })
        handleExitBatchMode()
      }
      setPendingBatchDeleteSessionIds(null)
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('sidebar.batchDeleteFailed', { count: ids.length }),
      })
    } finally {
      setIsBatchDeleting(false)
    }
  }, [addToast, closeTab, deleteSessions, disconnectSession, handleExitBatchMode, pendingBatchDeleteSessionIds, t])

  const toggleGroupSelection = useCallback((ids: string[]) => {
    const allSelected = ids.every((id) => selectedSessionIds.has(id))
    if (allSelected) {
      deselectSessions(ids)
    } else {
      selectSessions(ids)
    }
  }, [deselectSessions, selectSessions, selectedSessionIds])

  const toggleProjectCollapsed = useCallback((projectKey: string) => {
    if (suppressProjectClickRef.current === projectKey) {
      suppressProjectClickRef.current = null
      return
    }
    setCollapsedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      return next
    })
  }, [])

  const toggleProjectSessionExpansion = useCallback((projectKey: string) => {
    setExpandedProjectKeys((current) => {
      const next = new Set(current)
      if (next.has(projectKey)) {
        next.delete(projectKey)
      } else {
        next.add(projectKey)
      }
      return next
    })
  }, [])

  const handleStartRename = useCallback((id: string, currentTitle: string) => {
    setContextMenu(null)
    setRenamingId(id)
    setRenameValue(currentTitle)
  }, [])

  const handleFinishRename = useCallback(async () => {
    if (renamingId && renameValue.trim()) {
      await renameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, renameSession])

  useEffect(() => {
    if (!isBatchMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return

      if (event.key === 'Escape') {
        handleExitBatchMode()
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectSessions(filteredSessionIds)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [filteredSessionIds, handleExitBatchMode, isBatchMode, selectSessions])

  // —— 会话行(旧版视觉:圆角行 + hover 高亮 + 选中态背景;右侧常驻运行中转圈/worktree 分支角标
  // /相对时间——这三个是当前真实能力,不是 hover 才显,所以没有照抄旧版"只在 hover 显示置顶图钉"
  // 的做法,详见文末取舍说明)。 ——
  const renderSessionRow = (session: SessionListItem) => {
    const active = session.id === activeTabId
    const selected = selectedSessionIds.has(session.id)
    if (renamingId === session.id) {
      return (
        <div key={session.id} className="relative mb-0.5 last:mb-0 px-0.5">
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleFinishRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleFinishRename()
              if (e.key === 'Escape') {
                setRenamingId(null)
                setRenameValue('')
              }
            }}
            className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none"
            style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-primary)', border: '1px solid var(--color-brand)' }}
          />
        </div>
      )
    }
    return (
      <div key={session.id} className="relative mb-0.5 last:mb-0">
        <button
          type="button"
          onClick={(event) => {
            if (isBatchMode) {
              handleBatchSessionClick(event, session.id)
              return
            }
            useTabStore.getState().openTab(session.id, session.title)
            useChatStore.getState().connectToSession(session.id)
            closeMobileDrawer()
          }}
          onContextMenu={(e) => handleContextMenu(e, session.id)}
          className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pl-2.5 pr-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ background: selected || active ? 'var(--color-surface-selected)' : 'transparent' }}
          aria-pressed={isBatchMode ? selected : undefined}
          title={session.title || 'Untitled'}
        >
          {isBatchMode && (
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                selected ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white' : 'border-[var(--color-border)] bg-[var(--color-surface)]'
              }`}
              aria-hidden="true"
            >
              {selected && <Check className="h-3 w-3" strokeWidth={3} />}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
            {session.title || t('session.untitled')}
          </span>
          {!session.workDirExists && (
            <span className="shrink-0 text-[10px]" style={{ color: 'var(--color-warning)' }} title={session.workDir ?? ''}>
              {t('sidebar.missingDir')}
            </span>
          )}
          <SessionRowMeta
            isRunning={runningSessionIds.has(session.id)}
            isWorktree={isWorktreeSession(session)}
            modifiedAt={session.modifiedAt}
            t={t}
          />
        </button>
      </div>
    )
  }

  // ============ 折叠态(sidebarOpen=false):旧版从没有过"图标细栏"这个形态,当前真实能力里
  // 折叠侧栏是靠外层 #sidebar-shell 的宽度动画实现的图标细栏,不是整个隐藏——这里按当前真实
  // 行为画一版精简图标栏(logo + 展开按钮 + 新建会话 + 已安排 + 设置),取舍见文末说明。
  //
  // 重要:右键菜单/区头菜单/确认弹窗/全局搜索弹窗(Cmd+K)这几个浮层跟"侧栏是否展开"没有关系
  // (尤其 Cmd+K 是绑在 document 上的全局快捷键,折叠态下也能触发),所以不能用 if(!expanded)
  // 提前 return 把它们连带丢掉——必须和旧版一样,用同一个 <aside> + 内部条件分支,浮层作为
  // 不受 expanded 影响的兄弟节点始终挂载。 ============
  return (
    <aside
      className="sidebar-panel relative flex h-full shrink-0 flex-col"
      style={{ background: 'var(--color-surface-sidebar)', borderRight: '1px solid var(--color-border)' }}
      data-state={expanded ? 'open' : 'closed'}
      data-testid="sidebar"
      aria-label="Sidebar"
    >
      {/* 顶:红绿灯位(桌面端 macOS 左侧留白)+ 折叠/关闭/展开 + 搜索图标(旧版工具条位置)。
          折叠态(图标细栏)只留 logo + 展开按钮。 */}
      {expanded ? (
        <div
          data-desktop-drag-region
          data-testid="sidebar-title-region"
          className={`flex h-[46px] items-center justify-end gap-0.5 px-2 ${isDesktopRuntime && !isWindows ? 'pl-[78px]' : 'pl-2'}`}
        >
          {isMobile ? (
            <ToolBtn label={t('sidebar.collapse')} onClick={closeMobileDrawer}>
              <X size={17} />
            </ToolBtn>
          ) : (
            <ToolBtn label={t('sidebar.collapse')} onClick={toggleSidebar} testId="sidebar-collapse-button">
              <PanelLeftClose size={17} />
            </ToolBtn>
          )}
          <ToolBtn label={t('search.global.trigger')} onClick={() => openModal('globalSearch')}>
            <Search size={17} />
          </ToolBtn>
        </div>
      ) : (
        <div
          data-desktop-drag-region
          data-testid="sidebar-title-region"
          className={`flex w-full flex-col items-center gap-2 px-2 pb-2 ${isDesktopRuntime && !isWindows ? 'pt-[44px]' : 'pt-3'}`}
        >
          <Smiley size={26} />
          <ToolBtn label={t('sidebar.expand')} onClick={toggleSidebar} testId="sidebar-expand-button">
            <PanelLeftOpen size={16} />
          </ToolBtn>
        </div>
      )}

      {/* 品牌行(折叠态省掉文字,旧版没有这个折叠态,按当前图标细栏的真实需要精简)。 */}
      {expanded && (
        <div className="flex items-center gap-2 px-3 pb-2 pt-0.5">
          <Smiley size={22} />
          <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-headline)' }}>
            Billiard<span style={{ color: 'var(--color-primary-container)' }}>Buddy</span>
          </span>
        </div>
      )}

      {/* 搜索/刷新/批量管理一排(旧版这个位置放的是点击搜索图标展开的内联过滤输入框;当前真实能力
          是打开全局搜索弹窗 + 刷新会话列表 + 进入批量管理,三者都没有旧版的直接对应位置,按旧版
          "搜索行紧跟在品牌行之后、导航之前"的位置摆放,承载这三个真实能力。折叠态下收起,和当前
          真实行为一致——图标细栏放不下这一排,用户展开侧栏即可使用。) */}
      {expanded && (
        <div data-testid="sidebar-search-controls-section" className="flex-none px-3 pb-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openModal('globalSearch')}
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[14px] border border-[var(--color-sidebar-search-border)] bg-[var(--color-sidebar-search-bg)] pl-3 pr-2 text-left text-[13px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-sidebar-item-hover)] focus-visible:border-[var(--color-border-focus)] focus-visible:outline-none"
              aria-label={t('search.global.trigger')}
              title={t('search.global.trigger')}
            >
              <span className="pointer-events-none flex shrink-0 items-center text-[var(--color-text-tertiary)]">
                <Search size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate pl-2">{t('search.global.trigger')}</span>
              <kbd className="pointer-events-none shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-1 font-mono text-[10px] leading-tight text-[var(--color-text-tertiary)]">⌘K</kbd>
            </button>
            <ToolBtn label={t('sidebar.refreshSessions')} onClick={() => void refreshSessionsNow()}>
              <RefreshCw className={showRefreshLoading ? 'animate-spin' : ''} size={16} />
            </ToolBtn>
            <ToolBtn
              label={isBatchMode ? t('sidebar.batchExit') : t('sidebar.batchManage')}
              onClick={isBatchMode ? handleExitBatchMode : enterBatchMode}
              active={isBatchMode}
            >
              {isBatchMode ? <X size={16} /> : <Trash2 size={16} />}
            </ToolBtn>
          </div>
        </div>
      )}

      {/* 主导航:新建会话 / 已安排(旧版这里还有生成图片/剪视频/插件几项,当前 Sidebar 真实能力
          里没有这几个入口,不臆造假按钮,只保留两个真实存在的)。折叠态用图标细栏变体。 */}
      <nav className={expanded ? 'px-2 pb-1' : 'flex w-full flex-col items-center gap-2 px-2 py-2'}>
        <NavItem
          collapsed={!expanded}
          label={t('sidebar.newSession')}
          icon={<Plus size={expanded ? 17 : 18} />}
          touchFriendly={isMobile}
          onClick={() => {
            const currentTabId = useTabStore.getState().activeTabId
            const currentSession = currentTabId
              ? useSessionStore.getState().sessions.find((s) => s.id === currentTabId)
              : null
            void createSessionForWorkDir(currentSession?.workDir || currentSession?.projectRoot || undefined)
          }}
        />
        {!isMobile && (
          <NavItem
            collapsed={!expanded}
            label={t('sidebar.scheduled')}
            icon={<Clock size={expanded ? 17 : 18} />}
            active={activeTabId === SCHEDULED_TAB_ID}
            onClick={() => {
              useTabStore.getState().openTab(SCHEDULED_TAB_ID, t('sidebar.scheduled'), 'scheduled')
              closeMobileDrawer()
            }}
          />
        )}
      </nav>

      {/* 批量管理条(当前真实能力,旧版没有对应位置,放在紧挨列表区之上最自然的位置;
          折叠态下列表区本身收起,批量条跟着收起,和当前真实行为一致)。 */}
      {expanded && isBatchMode && (
        <div className="mx-3 mb-2 rounded-lg border px-2.5 py-2" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>
              {t('sidebar.batchSelectedCount', { count: selectedCount })}
            </span>
            <ToolBtn label={t('sidebar.batchExit')} onClick={handleExitBatchMode}>
              <X size={15} />
            </ToolBtn>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (filteredSessionIds.every((id) => selectedSessionIds.has(id))) {
                  deselectSessions(filteredSessionIds)
                } else {
                  selectSessions(filteredSessionIds)
                }
              }}
              disabled={filteredSessionIds.length === 0}
              className="rounded-md border px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              {filteredSessionIds.length > 0 && filteredSessionIds.every((id) => selectedSessionIds.has(id))
                ? t('sidebar.batchDeselectAll')
                : t('sidebar.batchSelectAll')}
            </button>
            <button
              type="button"
              onClick={() => requestBatchDelete([...selectedSessionIds])}
              disabled={selectedCount === 0}
              className="rounded-md px-2 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--color-error)' }}
            >
              {t('sidebar.batchDeleteSelected', { count: selectedCount })}
            </button>
          </div>
        </div>
      )}

      {/* 项目分组区(旧版"项目"+"任务"两个区,当前数据模型里没有区分——所有会话都在
          groupByProject 产出的分组里,统一放进一个可折叠总区)。折叠态(图标细栏)放不下列表,
          和当前真实行为一致,用空白填充区占位。 */}
      {!expanded ? (
        <div className="flex-1" aria-hidden="true" />
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <div className="mx-1 mt-2 rounded-[var(--radius-md)] border px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--color-error) 20%, transparent)', background: 'color-mix(in srgb, var(--color-error) 5%, transparent)' }}>
            <div className="text-xs font-medium" style={{ color: 'var(--color-error)' }}>{t('sidebar.sessionListFailed')}</div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--color-text-secondary)', wordBreak: 'break-word' }}>{error}</div>
            <button onClick={() => fetchSessions()} className="mt-2 text-[11px] font-medium hover:underline" style={{ color: 'var(--color-brand)' }}>
              {t('common.retry')}
            </button>
          </div>
        )}
        {showInitialLoading ? (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{t('common.loading')}</div>
        ) : filteredSessions.length === 0 && (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{t('sidebar.noSessions')}</div>
        )}

        {visibleProjectGroups.length > 0 && (
          <SectionHeader
            label={t('sidebar.projects')}
            count={visibleProjectGroups.length}
            open={projectsOpen}
            onToggle={() => setProjectsOpen((v) => !v)}
            action={
              <>
                <button
                  type="button"
                  onClick={(event) => openProjectHeaderMenu(event, 'main')}
                  title={t('sidebar.projectMenu')}
                  aria-label={t('sidebar.projectMenu')}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <MoreHorizontal size={14} />
                </button>
                <button
                  type="button"
                  onClick={(event) => openProjectHeaderMenu(event, 'create')}
                  title={t('sidebar.newProject')}
                  aria-label={t('sidebar.newProject')}
                  className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <FolderPlus size={14} />
                </button>
              </>
            }
          />
        )}

        {projectsOpen && (
          <div className="mb-1">
            {visibleProjectGroups.map((project) => {
              const projectCollapsed = collapsedProjectKeys.has(project.key)
              const sessionsExpanded = expandedProjectKeys.has(project.key)
              const visibleItems = projectCollapsed
                ? []
                : getVisibleProjectSessions(project.sessions, sessionsExpanded, activeTabId)
              const hiddenCount = project.sessions.length - visibleItems.length
              const groupIds = project.sessions.map((session) => session.id)
              const groupSelectedCount = groupIds.filter((id) => selectedSessionIds.has(id)).length
              const hasInternalScroll = sessionsExpanded && project.sessions.length > PROJECT_GROUP_SCROLL_COUNT
              const isProjectDragging = draggingProjectKey === project.key
              const isProjectPinned = pinnedProjectKeys.has(project.key)
              const dropBefore = projectDropTarget?.key === project.key && projectDropTarget.position === 'before'
              const dropAfter = projectDropTarget?.key === project.key && projectDropTarget.position === 'after'
              return (
                <div
                  key={project.key}
                  data-testid={`sidebar-project-group-${domSafeProjectKey(project.key)}`}
                  onDragOver={(event) => handleProjectDragOver(event, project.key)}
                  onDrop={(event) => handleProjectDrop(event, project.key)}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setProjectDropTarget((current) => (current?.key === project.key ? null : current))
                    }
                  }}
                  className={`group/proj-wrap relative mb-1.5 transition-opacity ${isProjectDragging ? 'opacity-50' : ''}`}
                >
                  {dropBefore && (
                    <div className="pointer-events-none absolute -top-1 left-1 right-1 z-10 h-0.5 rounded-full" style={{ background: 'var(--color-brand)' }} />
                  )}
                  {/* 项目行(照旧版:整行点击 = 展开/折叠,无箭头,文件夹开/合图标表态)。 */}
                  <div
                    className="group/proj flex h-[34px] w-full items-center rounded-lg pr-1 transition-colors hover:bg-[var(--color-surface-hover)]"
                    onContextMenu={(e) => { e.preventDefault(); setProjectContextMenu({ key: project.key, x: e.clientX, y: e.clientY }) }}
                  >
                    <button
                      type="button"
                      draggable={!isBatchMode}
                      onDragStart={(event) => handleProjectDragStart(event, project.key)}
                      onDragEnd={clearProjectDragState}
                      onClick={() => toggleProjectCollapsed(project.key)}
                      className="flex h-full min-w-0 flex-1 cursor-grab items-center gap-2.5 px-2.5 text-left active:cursor-grabbing"
                      title={project.subtitle || project.title}
                      aria-expanded={!projectCollapsed}
                      aria-label={t(projectCollapsed ? 'sidebar.expandProject' : 'sidebar.collapseProject', { project: project.title })}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: projectCollapsed ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}>
                        {projectCollapsed ? <Folder size={15} /> : <FolderOpen size={15} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{project.title}</span>
                      {isProjectPinned && <Pin size={12} style={{ color: 'var(--color-text-tertiary)' }} />}
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {isBatchMode ? (
                        <button
                          type="button"
                          onClick={() => toggleGroupSelection(groupIds)}
                          className="rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
                          style={{ color: groupSelectedCount > 0 ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }}
                          aria-label={t('sidebar.batchSelectGroup', { group: project.title })}
                        >
                          {groupSelectedCount === groupIds.length ? t('sidebar.batchDeselectAll') : t('sidebar.batchSelectAll')}
                        </button>
                      ) : (
                        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/proj:opacity-100 group-focus-within/proj:opacity-100">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              setContextMenu(null)
                              setProjectContextMenu({ key: project.key, x: event.clientX, y: event.clientY })
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
                            style={{ color: 'var(--color-text-secondary)' }}
                            aria-label={t('sidebar.projectActions', { project: project.title })}
                            title={t('sidebar.projectActions', { project: project.title })}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); void createSessionForWorkDir(project.workDir) }}
                            className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
                            style={{ color: 'var(--color-text-secondary)' }}
                            aria-label={t('sidebar.newSessionInProject', { project: project.title })}
                            title={t('sidebar.newSessionInProject', { project: project.title })}
                          >
                            <SquarePen size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {!projectCollapsed && (
                    <div className="ml-6 mt-1">
                      <div
                        className={hasInternalScroll ? 'max-h-[420px] overflow-y-auto pr-1' : undefined}
                        data-testid={`sidebar-project-session-list-${domSafeProjectKey(project.key)}`}
                      >
                        {visibleItems.map(renderSessionRow)}
                      </div>
                      {(hiddenCount > 0 || sessionsExpanded) && (
                        <button
                          type="button"
                          onClick={() => toggleProjectSessionExpansion(project.key)}
                          className="mb-0.5 w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
                          style={{ color: 'var(--color-text-tertiary)' }}
                          aria-expanded={sessionsExpanded}
                        >
                          {sessionsExpanded ? t('sidebar.showFewerSessions') : t('sidebar.showMoreSessions')}
                        </button>
                      )}
                    </div>
                  )}
                  {dropAfter && (
                    <div className="pointer-events-none absolute -bottom-1 left-1 right-1 z-10 h-0.5 rounded-full" style={{ background: 'var(--color-brand)' }} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      )}

      {/* 底部:设置(旧版这里还有主题切换按钮,当前 Sidebar 真实能力里没有这个入口——主题切换在
          设置页里,不在侧栏,所以没有照搬,避免臆造一个当前不存在的按钮)。折叠态用图标细栏变体,
          但和展开态一样始终渲染(不受 expanded 影响,只受 isMobile 影响,和当前真实行为一致)。 */}
      {!isMobile && (
        <div
          data-testid="sidebar-settings-dock"
          className={expanded ? 'flex items-center gap-1 px-2 py-2' : 'flex w-full items-center justify-center px-2 py-3'}
          style={{ borderTop: '1px solid var(--color-border)' }}
        >
          <NavItem
            collapsed={!expanded}
            active={activeTabId === SETTINGS_TAB_ID}
            label={t('sidebar.settings')}
            icon={<Settings size={expanded ? 17 : 18} />}
            onClick={() => {
              useTabStore.getState().openTab(SETTINGS_TAB_ID, t('sidebar.settings'), 'settings')
              closeMobileDrawer()
            }}
          />
        </div>
      )}

      {/* 会话右键菜单:重命名 / 删除(当前真实能力是直接删除,不是旧版的"先归档再删";
          旧版没有独立删除,这里如实按当前能力做,不臆造归档流程)。 */}
      {contextMenu && (
        <MenuPanel x={contextMenu.x} y={contextMenu.y} width={180}>
          <MenuButton
            icon={<SquarePen size={15} />}
            onClick={() => {
              const session = sessions.find((s) => s.id === contextMenu.id)
              handleStartRename(contextMenu.id, session?.title || '')
            }}
          >
            {t('common.rename')}
          </MenuButton>
          <MenuButton icon={<Trash2 size={15} />} danger onClick={() => handleDelete(contextMenu.id)}>
            {t('common.delete')}
          </MenuButton>
        </MenuPanel>
      )}

      {/* 项目右键菜单:置顶/取消置顶、在 Finder 中显示、隐藏/恢复(当前真实能力;旧版是
          新建任务/在 Finder 中显示/从边栏移除三项,新建任务已经有 hover 的铅笔图标承载,
          这里不重复放)。 */}
      {projectContextMenu && (() => {
        const project = orderedProjectGroups.find((group) => group.key === projectContextMenu.key)
        if (!project) return null
        const pinned = pinnedProjectKeys.has(project.key)
        const hidden = hiddenProjectKeys.has(project.key)
        return (
          <MenuPanel x={positionProjectMenu(projectContextMenu.x, projectContextMenu.y).left} y={positionProjectMenu(projectContextMenu.x, projectContextMenu.y).top} width={230}>
            <MenuButton icon={pinned ? <PinOff size={15} /> : <Pin size={15} />} onClick={() => togglePinnedProject(project.key)}>
              {t(pinned ? 'sidebar.unpinProject' : 'sidebar.pinProject')}
            </MenuButton>
            <MenuButton icon={<FolderOpen size={15} />} onClick={() => void openProjectInFinder(project)}>
              {t('sidebar.openInFinder')}
            </MenuButton>
            <MenuButton icon={hidden ? <RotateCcw size={15} /> : <X size={15} />} danger={!hidden} onClick={() => toggleHiddenProject(project)}>
              {t(hidden ? 'sidebar.restoreProjectToSidebar' : 'sidebar.hideProjectFromSidebar')}
            </MenuButton>
          </MenuPanel>
        )
      })()}

      {/* 项目区头菜单(主菜单/整理方式/排序方式/新建项目)——当前真实能力,旧版没有对应,
          直接用统一菜单外观承载。 */}
      {projectHeaderMenu && (
        <ProjectHeaderMenu
          type={projectHeaderMenu.type}
          x={projectHeaderMenu.x}
          y={projectHeaderMenu.y}
          organization={projectOrganization}
          sortBy={projectSortBy}
          onOpenSubmenu={openProjectHeaderSubmenu}
          onSetOrganization={updateProjectOrganization}
          onSetSortBy={updateProjectSortBy}
          onCreateBlank={() => void createSessionForWorkDir()}
          onUseExistingFolder={() => void createSessionFromExistingFolder()}
          onRestoreHiddenProjects={restoreAllHiddenProjects}
          hiddenProjectCount={hiddenProjectKeys.size}
          t={t}
        />
      )}
      {projectHeaderSubmenu && (
        <ProjectHeaderMenu
          type={projectHeaderSubmenu.type}
          x={projectHeaderSubmenu.x}
          y={projectHeaderSubmenu.y}
          organization={projectOrganization}
          sortBy={projectSortBy}
          onOpenSubmenu={openProjectHeaderSubmenu}
          onSetOrganization={updateProjectOrganization}
          onSetSortBy={updateProjectSortBy}
          onCreateBlank={() => void createSessionForWorkDir()}
          onUseExistingFolder={() => void createSessionFromExistingFolder()}
          onRestoreHiddenProjects={restoreAllHiddenProjects}
          hiddenProjectCount={hiddenProjectKeys.size}
          t={t}
        />
      )}

      <ConfirmDialog
        open={pendingDeleteSessionId !== null}
        onClose={() => setPendingDeleteSessionId(null)}
        onConfirm={confirmDelete}
        title={t('common.delete')}
        body={pendingDeleteSessionId ? t('sidebar.confirmDelete') : ''}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
      />
      <ConfirmDialog
        open={pendingBatchDeleteSessionIds !== null}
        onClose={() => { if (!isBatchDeleting) setPendingBatchDeleteSessionIds(null) }}
        onConfirm={confirmBatchDelete}
        title={t('common.delete')}
        body={(
          <div className="space-y-3">
            <p className="text-sm leading-6" style={{ color: 'var(--color-text-secondary)' }}>
              {t('sidebar.batchDeleteConfirm', { count: pendingBatchDeleteSessionIds?.length ?? 0 })}
            </p>
            <div>
              <div className="mb-1.5 text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>
                {t('sidebar.batchDeleteConfirmBody')}
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-[8px] border p-2" style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-container-low)' }}>
                {pendingBatchDeleteSessions.slice(0, 5).map((session) => (
                  <li key={session.id} className="truncate text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                    {session.title || 'Untitled'}
                  </li>
                ))}
                {(pendingBatchDeleteSessionIds?.length ?? 0) > 5 && (
                  <li className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {t('sidebar.batchDeleteMore', { count: (pendingBatchDeleteSessionIds?.length ?? 0) - 5 })}
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isBatchDeleting}
      />

      <GlobalSearchModal open={activeModal === 'globalSearch'} onClose={closeModal} />
    </aside>
  )
}

// ============================================================================
// 以下都是纯逻辑/无视觉的辅助函数与小组件,和当前仓库 Sidebar.tsx 里的实现保持一致语义
// (分组/排序/持久化/相对时间等真实能力),只是挪到这个新文件里、外观小件换成上面定义的
// MenuPanel/MenuButton。
// ============================================================================

function useSessionListAutoRefresh(fetchSessions: () => Promise<void>): () => Promise<void> {
  const inFlightRef = useRef<Promise<void> | null>(null)
  const lastStartedAtRef = useRef(0)

  const refreshSessions = useCallback((force = false) => {
    if (inFlightRef.current && !force) return inFlightRef.current

    const now = Date.now()
    if (!force && now - lastStartedAtRef.current < SESSION_LIST_FOCUS_REFRESH_MIN_MS) {
      return Promise.resolve()
    }

    lastStartedAtRef.current = now
    const request = Promise.resolve()
      .then(() => fetchSessions())
      .catch(() => undefined)
      .finally(() => {
        if (inFlightRef.current === request) {
          inFlightRef.current = null
        }
      })
    inFlightRef.current = request
    return request
  }, [fetchSessions])

  useEffect(() => {
    void refreshSessions(true)

    const refreshIfVisible = () => {
      if (!isDocumentVisible()) return
      void refreshSessions()
    }

    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    const timer = window.setInterval(() => {
      if (!isDocumentVisible()) return
      void refreshSessions(true)
    }, SESSION_LIST_AUTO_REFRESH_MS)

    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.clearInterval(timer)
    }
  }, [refreshSessions])

  return useCallback(() => refreshSessions(true), [refreshSessions])
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function ProjectHeaderMenu({
  type,
  x,
  y,
  organization,
  sortBy,
  onOpenSubmenu,
  onSetOrganization,
  onSetSortBy,
  onCreateBlank,
  onUseExistingFolder,
  onRestoreHiddenProjects,
  hiddenProjectCount,
  t,
}: {
  type: SidebarHeaderMenuType
  x: number
  y: number
  organization: SidebarProjectOrganization
  sortBy: SidebarProjectSortBy
  onOpenSubmenu: (event: React.MouseEvent, type: 'organize' | 'sort') => void
  onSetOrganization: (organization: SidebarProjectOrganization) => void
  onSetSortBy: (sortBy: SidebarProjectSortBy) => void
  onCreateBlank: () => void
  onUseExistingFolder: () => void
  onRestoreHiddenProjects: () => void
  hiddenProjectCount: number
  t: ReturnType<typeof useTranslation>
}) {
  const width = type === 'sort' ? 230 : type === 'create' ? 250 : 270

  if (type === 'create') {
    return (
      <MenuPanel x={x} y={y} width={width}>
        <MenuButton icon={<SquarePen size={18} />} onClick={onCreateBlank}>{t('sidebar.newBlankProject')}</MenuButton>
        <MenuButton icon={<FolderOpen size={18} />} onClick={onUseExistingFolder}>{t('sidebar.useExistingFolder')}</MenuButton>
      </MenuPanel>
    )
  }

  if (type === 'organize') {
    return (
      <MenuPanel x={x} y={y} width={width}>
        <MenuButton icon={<Folder size={18} />} checked={organization === 'project'} onClick={() => onSetOrganization('project')}>
          {t('sidebar.organizeByProject')}
        </MenuButton>
        <MenuButton icon={<FolderOpen size={18} />} checked={organization === 'recentProject'} onClick={() => onSetOrganization('recentProject')}>
          {t('sidebar.organizeByRecentProject')}
        </MenuButton>
        <MenuButton icon={<Clock size={18} />} checked={organization === 'time'} onClick={() => onSetOrganization('time')}>
          {t('sidebar.organizeByTime')}
        </MenuButton>
      </MenuPanel>
    )
  }

  if (type === 'sort') {
    return (
      <MenuPanel x={x} y={y} width={width}>
        <MenuButton icon={<Clock size={18} />} checked={sortBy === 'createdAt'} onClick={() => onSetSortBy('createdAt')}>
          {t('sidebar.sortByCreatedAt')}
        </MenuButton>
        <MenuButton icon={<RefreshCw size={18} />} checked={sortBy === 'updatedAt'} onClick={() => onSetSortBy('updatedAt')}>
          {t('sidebar.sortByUpdatedAt')}
        </MenuButton>
      </MenuPanel>
    )
  }

  return (
    <MenuPanel x={x} y={y} width={width}>
      <MenuButton icon={<Folder size={18} />} trailing onMouseEnter={(event) => onOpenSubmenu(event, 'organize')} onClick={(event) => onOpenSubmenu(event, 'organize')}>
        {t('sidebar.organizeSidebar')}
      </MenuButton>
      <MenuButton icon={<Clock size={18} />} trailing onMouseEnter={(event) => onOpenSubmenu(event, 'sort')} onClick={(event) => onOpenSubmenu(event, 'sort')}>
        {t('sidebar.sortCondition')}
      </MenuButton>
      {hiddenProjectCount > 0 && (
        <>
          <MenuSeparator />
          <MenuButton icon={<RotateCcw size={18} />} onClick={onRestoreHiddenProjects}>
            {t('sidebar.restoreHiddenProjects', { count: hiddenProjectCount })}
          </MenuButton>
        </>
      )}
    </MenuPanel>
  )
}

function groupByProject(sessions: SessionListItem[], sortBy: SidebarProjectSortBy): ProjectGroup[] {
  const groupsByKey = new Map<string, SessionListItem[]>()
  for (const session of sessions) {
    const key = getSessionProjectKey(session)
    const items = groupsByKey.get(key) ?? []
    items.push(session)
    groupsByKey.set(key, items)
  }

  const groups = [...groupsByKey.entries()].map(([key, items]) => {
    const sortedSessions = [...items].sort((a, b) => compareSessionsByTimestamp(a, b, sortBy))
    const newest = sortedSessions[0]
    const projectRoot = newest?.projectRoot || newest?.workDir || key
    return {
      key,
      title: projectTitle(projectRoot),
      subtitle: projectSubtitle(projectRoot, key),
      workDir: projectRoot || newest?.workDir || undefined,
      sessions: sortedSessions,
    }
  })

  return groups.sort((a, b) => compareSessionsByTimestamp(a.sessions[0], b.sessions[0], sortBy))
}

function applyProjectOrder(
  groups: ProjectGroup[],
  projectOrder: string[],
  pinnedProjectKeys: Set<string>,
  organization: SidebarProjectOrganization,
  sortBy: SidebarProjectSortBy,
): ProjectGroup[] {
  const orderIndex = new Map(projectOrder.map((key, index) => [key, index]))
  return [...groups].sort((a, b) => {
    const aPinned = pinnedProjectKeys.has(a.key)
    const bPinned = pinnedProjectKeys.has(b.key)
    if (aPinned !== bPinned) return aPinned ? -1 : 1
    if (organization === 'project') return a.title.localeCompare(b.title)
    const aIndex = orderIndex.get(a.key)
    const bIndex = orderIndex.get(b.key)
    if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex
    if (aIndex !== undefined) return -1
    if (bIndex !== undefined) return 1
    return compareSessionsByTimestamp(a.sessions[0], b.sessions[0], sortBy)
  })
}

function moveProjectKey(
  projectKeys: string[],
  sourceKey: string,
  targetKey: string,
  position: 'before' | 'after',
): string[] {
  const withoutSource = projectKeys.filter((key) => key !== sourceKey)
  const targetIndex = withoutSource.indexOf(targetKey)
  if (targetIndex < 0) return projectKeys
  const insertIndex = position === 'before' ? targetIndex : targetIndex + 1
  return [
    ...withoutSource.slice(0, insertIndex),
    sourceKey,
    ...withoutSource.slice(insertIndex),
  ]
}

function getProjectDropPosition(event: React.DragEvent<HTMLElement>): 'before' | 'after' {
  const rect = event.currentTarget.getBoundingClientRect()
  return event.clientY <= rect.top + rect.height / 2 ? 'before' : 'after'
}

function readStoredProjectOrder(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_ORDER_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeStoredProjectOrder(projectOrder: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_ORDER_STORAGE_KEY, JSON.stringify(projectOrder))
  } catch {
    // 侧栏排序只是 UI 偏好,存储失败忽略即可。
  }
}

function readStoredProjectPins(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_PINNED_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeStoredProjectPins(projectKeys: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_PINNED_STORAGE_KEY, JSON.stringify([...projectKeys]))
  } catch {
    // 置顶只是 UI 偏好,存储失败忽略即可。
  }
}

function readStoredProjectHidden(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_HIDDEN_STORAGE_KEY) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeStoredProjectHidden(projectKeys: Set<string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_HIDDEN_STORAGE_KEY, JSON.stringify([...projectKeys]))
  } catch {
    // 隐藏项目只是本地 UI 偏好,存储失败忽略即可。
  }
}

function readStoredProjectOrganization(): SidebarProjectOrganization {
  if (typeof localStorage === 'undefined') return 'recentProject'
  return normalizeProjectOrganization(localStorage.getItem(PROJECT_ORGANIZATION_STORAGE_KEY))
}

function writeStoredProjectOrganization(organization: SidebarProjectOrganization): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_ORGANIZATION_STORAGE_KEY, organization)
  } catch {
    // 忽略存储失败。
  }
}

function readStoredProjectSortBy(): SidebarProjectSortBy {
  if (typeof localStorage === 'undefined') return 'updatedAt'
  return normalizeProjectSortBy(localStorage.getItem(PROJECT_SORT_STORAGE_KEY))
}

function writeStoredProjectSortBy(sortBy: SidebarProjectSortBy): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PROJECT_SORT_STORAGE_KEY, sortBy)
  } catch {
    // 忽略存储失败。
  }
}

function buildSidebarProjectPreferences(
  projectOrder: string[],
  pinnedProjectKeys: Set<string>,
  hiddenProjectKeys: Set<string>,
  projectOrganization: SidebarProjectOrganization,
  projectSortBy: SidebarProjectSortBy,
): SidebarProjectPreferences {
  return normalizeSidebarProjectPreferences({
    projectOrder,
    pinnedProjects: [...pinnedProjectKeys],
    hiddenProjects: [...hiddenProjectKeys],
    projectOrganization,
    projectSortBy,
  })
}

function readCachedSidebarProjectPreferences(): SidebarProjectPreferences {
  return {
    projectOrder: readStoredProjectOrder(),
    pinnedProjects: [...readStoredProjectPins()],
    hiddenProjects: [...readStoredProjectHidden()],
    projectOrganization: readStoredProjectOrganization(),
    projectSortBy: readStoredProjectSortBy(),
  }
}

function writeCachedSidebarProjectPreferences(preferences: SidebarProjectPreferences): void {
  const normalized = normalizeSidebarProjectPreferences(preferences)
  writeStoredProjectOrder(normalized.projectOrder)
  writeStoredProjectPins(new Set(normalized.pinnedProjects))
  writeStoredProjectHidden(new Set(normalized.hiddenProjects))
  writeStoredProjectOrganization(normalized.projectOrganization)
  writeStoredProjectSortBy(normalized.projectSortBy)
}

function normalizeSidebarProjectPreferences(preferences: Partial<SidebarProjectPreferences> | undefined): SidebarProjectPreferences {
  return {
    projectOrder: normalizeProjectKeyList(preferences?.projectOrder),
    pinnedProjects: normalizeProjectKeyList(preferences?.pinnedProjects),
    hiddenProjects: normalizeProjectKeyList(preferences?.hiddenProjects),
    projectOrganization: normalizeProjectOrganization(preferences?.projectOrganization),
    projectSortBy: normalizeProjectSortBy(preferences?.projectSortBy),
  }
}

function normalizeProjectKeyList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }

  return normalized
}

function normalizeProjectPathForComparison(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/g, '') || value
  return isWindows ? normalized.toLowerCase() : normalized
}

function isDriveRootComparisonPath(value: string): boolean {
  return /^[a-z]:$/i.test(value)
}

function projectPathMatches(projectKey: string, workDir: string): boolean {
  const normalizedProjectKey = normalizeProjectPathForComparison(projectKey)
  const normalizedWorkDir = normalizeProjectPathForComparison(workDir)

  if (normalizedProjectKey === normalizedWorkDir) return true
  if (isDriveRootComparisonPath(normalizedProjectKey)) return false
  return normalizedWorkDir.startsWith(`${normalizedProjectKey}/`)
}

function hasSidebarProjectPreferences(preferences: SidebarProjectPreferences): boolean {
  return preferences.projectOrder.length > 0
    || preferences.pinnedProjects.length > 0
    || preferences.hiddenProjects.length > 0
    || preferences.projectOrganization !== 'recentProject'
    || preferences.projectSortBy !== 'updatedAt'
}

function normalizeProjectOrganization(value: unknown): SidebarProjectOrganization {
  return value === 'project' || value === 'recentProject' || value === 'time' ? value : 'recentProject'
}

function normalizeProjectSortBy(value: unknown): SidebarProjectSortBy {
  return value === 'createdAt' || value === 'updatedAt' ? value : 'updatedAt'
}

function getVisibleProjectSessions(
  sessions: SessionListItem[],
  expanded: boolean,
  activeSessionId: string | null,
): SessionListItem[] {
  if (expanded || sessions.length <= PROJECT_GROUP_VISIBLE_COUNT) return sessions

  const visible = sessions.slice(0, PROJECT_GROUP_VISIBLE_COUNT)
  if (!activeSessionId || visible.some((session) => session.id === activeSessionId)) return visible

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  return activeSession ? [...visible, activeSession] : visible
}

function getSessionProjectKey(session: SessionListItem): string {
  return session.projectRoot || session.workDir || session.projectPath || 'unknown'
}

function compareSessionsByTimestamp(
  a: SessionListItem | undefined,
  b: SessionListItem | undefined,
  sortBy: SidebarProjectSortBy,
): number {
  return getSessionTimestamp(b, sortBy) - getSessionTimestamp(a, sortBy)
}

function getSessionTimestamp(session: SessionListItem | undefined, sortBy: SidebarProjectSortBy): number {
  const value = sortBy === 'createdAt' ? session?.createdAt : session?.modifiedAt
  const timestamp = new Date(value ?? 0).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function projectTitle(pathLike: string | null | undefined): string {
  if (!pathLike) return 'Unknown project'
  const normalized = pathLike.replace(/[\\/]+$/, '')
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  const last = segments[segments.length - 1]
  if (last) return last
  return normalized || 'Unknown project'
}

function projectSubtitle(projectRoot: string | null | undefined, fallbackKey: string): string | null {
  if (!projectRoot) return fallbackKey === 'unknown' ? null : fallbackKey
  return compactProjectPath(projectRoot)
}

function isWorktreeSession(session: SessionListItem): boolean {
  if (!session.workDir) return false
  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(session.workDir)) return true
  if (!session.projectRoot || session.workDir === session.projectRoot) return false
  return !isSameOrChildPath(session.workDir, session.projectRoot)
}

function isSameOrChildPath(childPath: string, parentPath: string): boolean {
  const child = normalizePathForCompare(childPath)
  const parent = normalizePathForCompare(parentPath)
  return child === parent || child.startsWith(`${parent}/`)
}

function normalizePathForCompare(pathLike: string): string {
  return pathLike.replace(/\\/g, '/').replace(/\/+$/, '')
}

function compactProjectPath(pathLike: string): string {
  const normalized = normalizePathForCompare(pathLike)
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 3) return normalized
  return `.../${segments.slice(-3, -1).join('/')}`
}

function domSafeProjectKey(projectKey: string): string {
  return projectKey.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function positionProjectMenu(clientX: number, clientY: number): { left: number; top: number } {
  if (typeof window === 'undefined') return { left: clientX, top: clientY }
  const width = 230
  const height = 200
  return {
    left: Math.max(8, Math.min(clientX, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(clientY, window.innerHeight - height - 8)),
  }
}

function SessionRowMeta({
  isRunning,
  isWorktree,
  modifiedAt,
  t,
}: {
  isRunning: boolean
  isWorktree: boolean
  modifiedAt: string
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const relativeTime = formatRelativeTime(modifiedAt, t)
  const updatedLabel = t('session.lastUpdated', { time: relativeTime })

  return (
    <span
      className="ml-auto flex h-5 min-w-[64px] shrink-0 items-center justify-end gap-1.5 text-[10px] font-medium tabular-nums"
      style={{ color: 'var(--color-text-tertiary)' }}
      title={updatedLabel}
    >
      {isRunning && (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" style={{ color: 'var(--color-success)' }} aria-label={t('sidebar.sessionRunning')} title={t('sidebar.sessionRunning')}>
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2.2} aria-hidden="true" />
        </span>
      )}
      {isWorktree && (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" title={t('sidebar.worktree')}>
          <GitBranch className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">{t('sidebar.worktree')}</span>
        </span>
      )}
      <span className="inline-flex shrink-0 items-center justify-end">{relativeTime}</span>
    </span>
  )
}

function formatRelativeTime(
  dateStr: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const date = new Date(dateStr)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp)) return ''

  const diff = Date.now() - timestamp
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('session.timeJustNow')
  if (min < 60) return t('session.timeMinutes', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('session.timeHours', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('session.timeDays', { n: day })
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(date)
}
