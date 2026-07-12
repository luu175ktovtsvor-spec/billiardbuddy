// 左栏 —— 照 Codex(ChatGPT Codex)左栏信息架构(owner 2026-07-11:左栏直接改成 Codex 的)。
// 结构:红绿灯位+工具图标 → 品牌行 → 主导航(新建任务/已安排/插件) → 项目分组 → 任务分组 → 底部设置。
// 项目/任务/工作目录模型(2026-07-12,对齐 Codex 侧栏逆向规格,asar 组件 Th/Hh 反混淆读出):
//   项目 = 工作目录本身(后端 /sessions/projects 按会话 workspaceRoot 聚合,无独立项目表);
//   项目行点击 = 展开/折叠(无箭头,文件夹开/合图标表态,状态 localStorage 记住);区头 hover「+」= 添加项目(选文件夹);
//   行 hover「+」在此项目新建任务;右键菜单含「从边栏移除」(只藏项目、磁盘不动,对齐 Codex removeProject 语义);
//   超过 5 个项目折叠成「显示更多」(对齐 Codex maxGroups=5);
//   「任务」区 = 默认目录/未归组的会话(Codex 中文把 thread 叫「任务」);侧栏不显时间戳(hideThreadTimestamps),
//   正在跑的会话右侧浮 spinner(floatStatusIconsRight)。
import { useEffect, useState, type ReactNode } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { pickWorkspaceFolder } from '../../lib/workspace'
import { getDesktopHost } from '../../lib/desktopHost'
import { openNewConversation, openNewConversationInProject, openExistingConversation } from '../../lib/conversations'
import { DRAG, NODRAG } from '../../lib/dragRegion'
import { useResizableWidth } from '../../lib/useResizableWidth'
import { ResizeHandle } from '../shared/ResizeHandle'
import { ContextMenu } from '../shared/Menu'
import { Smiley } from '../shared/Smiley'
import { toast } from '../../stores/toastStore'
import {
  IconPanelLeft, IconSearch, IconEdit, IconClock, IconPuzzle,
  IconFolder, IconFolderOpen, IconSettings, IconChevronDown, IconSun, IconMoon,
  IconPin, IconArchive, IconTrash, IconSparkles, IconZap, IconPlus, IconSpinner, IconX,
} from '../shared/icons'
import { t } from '../../i18n'

// —— 侧栏本地偏好(纯 UI 态,localStorage;换机丢了不心疼)——
const EXPANDED_KEY = 'qf.sidebar.expandedProjects'
const HIDDEN_KEY = 'qf.sidebar.hiddenProjectRoots'
function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
}
function writeJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* 满/禁用就算了 */ }
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

function SectionHeader({ label, count, open, onToggle, action }: { label: string; count?: number; open: boolean; onToggle: () => void; action?: ReactNode }) {
  return (
    <div className="group/sect mt-2 flex w-full items-center gap-1 pr-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-1 px-2.5 py-1 text-left text-[11px] font-medium uppercase tracking-wide transition-colors hover:text-[var(--color-text-secondary)]"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        <span className="transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>
          <IconChevronDown size={12} />
        </span>
        <span>{label}</span>
        {count !== undefined && <span style={{ opacity: 0.7 }}>{count}</span>}
      </button>
      {/* 区头动作(对齐 Codex:hover 才显,如「项目」区的 + 添加项目) */}
      {action && <span className="shrink-0 opacity-0 transition-opacity group-hover/sect:opacity-100">{action}</span>}
    </div>
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
  const chatRunning = useChatStore((s) => s.status === 'running')
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const effective = useUiStore((s) => s.effectiveTheme)
  const openSettings = useUiStore((s) => s.setSettingsOpen)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const nav = useUiStore((s) => s.nav)
  const setNav = useUiStore((s) => s.setNav)
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)
  const projects = useProjectStore((s) => s.projects)
  const refreshProjects = useProjectStore((s) => s.refresh)
  const [projectsOpen, setProjectsOpen] = useState(true)
  const [convOpen, setConvOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)
  // 展开状态持久化(对齐 Codex:每项目开合记住,重启不丢)。
  const [expandedProjects, setExpandedProjectsRaw] = useState<Record<string, boolean>>(() => readJson(EXPANDED_KEY, {}))
  const setExpandedProjects = (updater: (m: Record<string, boolean>) => Record<string, boolean>) => {
    setExpandedProjectsRaw((m) => { const next = updater(m); writeJson(EXPANDED_KEY, next); return next })
  }
  // 「从边栏移除」的项目(对齐 Codex removeProject:只从边栏藏起,磁盘文件不动;再选该目录自动回来)。
  const [hiddenRoots, setHiddenRoots] = useState<string[]>(() => readJson(HIDDEN_KEY, []))
  const hideRoot = (root: string) => setHiddenRoots((prev) => { const next = [...new Set([...prev, root])]; writeJson(HIDDEN_KEY, next); return next })
  const unhideRoot = (root: string) => setHiddenRoots((prev) => { const next = prev.filter((r) => r !== root); writeJson(HIDDEN_KEY, next); return next })
  // 超过 5 个项目折叠(对齐 Codex maxGroups=5 + 显示更多/收起)。
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string; title: string } | null>(null)
  const [projCtx, setProjCtx] = useState<{ x: number; y: number; root: string } | null>(null)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // 会话列表变了(新会话落盘/删除/换目录)→ 项目聚合跟着刷(项目=会话 workspaceRoot 的派生,无独立真相源)。
  useEffect(() => { void refreshProjects() }, [refreshProjects, sessions])
  const matched = query.trim() ? sessions.filter((s) => (s.title || '').toLowerCase().includes(query.toLowerCase())) : sessions
  // 未归档:置顶优先;已归档单列一区。
  const liveSessions = matched.filter((s) => !s.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
  const archivedSessions = matched.filter((s) => s.archived)
  // —— 项目分组(对齐 Codex byProject):非默认目录的项目 + 「任务」组 = 默认目录/未归组会话。 ——
  const defaultRoot = projects.find((p) => p.isDefault)?.workspaceRoot ?? null
  let projectRows = projects.filter((p) => !p.isDefault)
  // 刚选的目录还没有落盘会话(后端首条消息才建 meta)→ 补一行"待落盘"项目,选完目录立刻可见不空窗。
  if (workspaceRoot && workspaceRoot !== defaultRoot && !projectRows.some((p) => p.workspaceRoot === workspaceRoot)) {
    projectRows = [{ workspaceRoot, sessionCount: 0, lastUpdatedAt: '', lastSessionId: '', lastTitle: '', isDefault: false }, ...projectRows]
  }
  // 「从边栏移除」的项目藏掉(当前激活目录除外——正在用就自动回来),其会话落「任务」区。
  projectRows = projectRows.filter((p) => p.workspaceRoot === workspaceRoot || !hiddenRoots.includes(p.workspaceRoot))
  // maxGroups=5(对齐 Codex):超出折叠,「显示更多」展开(激活项目始终可见)。
  const overflow = projectRows.length > 5
  const visibleProjectRows = overflow && !showAllProjects
    ? projectRows.filter((p, i) => i < 5 || p.workspaceRoot === workspaceRoot)
    : projectRows
  const projectRoots = new Set(projectRows.map((p) => p.workspaceRoot))
  const ungrouped = liveSessions.filter((s) => !s.workspaceRoot || !projectRoots.has(s.workspaceRoot))
  const sessionsOf = (root: string) => liveSessions.filter((s) => s.workspaceRoot === root)
  // 没手动开合过的项目:当前激活的默认展开,其余折叠。
  const isProjOpen = (root: string) => expandedProjects[root] ?? (root === workspaceRoot)
  // 选目录 = 添加/激活项目,顺带解除「已移除」标记(对齐 Codex:移除只藏边栏,再次选择自动回来)。
  useEffect(() => { if (workspaceRoot) unhideRoot(workspaceRoot) }, [workspaceRoot]) // eslint-disable-line react-hooks/exhaustive-deps

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
    // 对齐 Codex 侧栏行:不显时间戳(hideThreadTimestamps),正在跑的会话右侧浮 spinner(floatStatusIconsRight)。
    const runningHere = active && chatRunning
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
        {runningHere && <IconSpinner size={12} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />}
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

      {/* 项目 + 任务(项目 = 工作目录,组内是该项目的会话;任务 = 默认目录/未归组会话,Codex 中文把 thread 叫「任务」) */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <SectionHeader
          label={t('sidebar.sectionProjects')}
          open={projectsOpen}
          onToggle={() => setProjectsOpen((v) => !v)}
          action={
            <button
              type="button"
              onClick={() => void pickWorkspaceFolder()}
              title="添加新项目:选择一个文件夹,程序在这个文件夹里读写"
              aria-label="添加新项目"
              className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              <IconPlus size={14} />
            </button>
          }
        />
        {projectsOpen && (
          <div className="mb-1">
            {visibleProjectRows.map((p) => {
              const rootPath = p.workspaceRoot
              const name = rootPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || rootPath
              const activeProj = rootPath === workspaceRoot
              const open = isProjOpen(rootPath)
              const group = sessionsOf(rootPath)
              return (
                <div key={rootPath} className="mb-0.5">
                  {/* 项目行(对齐 Codex):整行点击 = 展开/折叠,无箭头,文件夹开/合图标表达状态 */}
                  <div
                    className="group/proj flex w-full items-center rounded-lg pr-1 transition-colors hover:bg-[var(--color-surface-hover)]"
                    style={{ background: activeProj ? 'var(--color-surface-selected)' : undefined }}
                    onContextMenu={(e) => { e.preventDefault(); setProjCtx({ x: e.clientX, y: e.clientY, root: rootPath }) }}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedProjects((m) => ({ ...m, [rootPath]: !open }))}
                      className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                      title={rootPath}
                      aria-expanded={open}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: 'var(--color-text-secondary)' }}>
                        {open ? <IconFolderOpen size={15} /> : <IconFolder size={15} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { setNav('chat'); openNewConversationInProject(rootPath) }}
                      title={`在 ${name} 中新建任务`}
                      aria-label={`在 ${name} 中新建任务`}
                      className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--color-surface-hover)] group-hover/proj:opacity-70"
                      style={{ color: 'var(--color-text-secondary)' }}
                    >
                      <IconPlus size={14} />
                    </button>
                  </div>
                  {open && (
                    group.length > 0 ? (
                      <div className="ml-6">{group.map(renderRow)}</div>
                    ) : (
                      <div className="ml-6 px-2.5 py-1 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>还没有任务,点 + 开一个</div>
                    )
                  )}
                </div>
              )
            })}
            {/* 超过 5 个项目折叠(对齐 Codex maxGroups):显示更多 / 收起 */}
            {overflow && (
              <button
                type="button"
                onClick={() => setShowAllProjects((v) => !v)}
                className="flex w-full items-center rounded-lg px-2 py-1 text-left text-[12.5px] opacity-75 transition-opacity hover:opacity-100"
                style={{ color: 'var(--color-text-tertiary)' }}
              >
                {showAllProjects ? '收起' : `显示更多(${projectRows.length - visibleProjectRows.length})`}
              </button>
            )}
          </div>
        )}

        <SectionHeader label={t('sidebar.sectionConversations')} open={convOpen} onToggle={() => setConvOpen((v) => !v)} />
        {convOpen && (
          <div className="mb-2">
            {sessions.length === 0 ? (
              <button
                type="button"
                onClick={() => { setNav('chat'); openNewConversation() }}
                className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left"
                style={{ background: 'var(--color-surface-selected)' }}
              >
                <span className="truncate text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{t('sidebar.newChat')}</span>
              </button>
            ) : ungrouped.length === 0 ? (
              query.trim() ? <div className="px-2.5 py-1.5 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>没有匹配的任务</div> : null
            ) : (
              ungrouped.map(renderRow)
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

      {/* 项目右键菜单(对齐 Codex 项目行右键:新建对话 / 在 Finder 中显示根目录) */}
      {projCtx && (
        <ContextMenu
          x={projCtx.x}
          y={projCtx.y}
          onClose={() => setProjCtx(null)}
          items={[
            {
              label: '新建任务',
              icon: <IconPlus size={15} />,
              onClick: () => { setNav('chat'); openNewConversationInProject(projCtx.root) },
            },
            ...(getDesktopHost().revealPath
              ? [{
                  label: getDesktopHost().platform === 'darwin' ? '在 Finder 中显示' : '在文件夹中显示',
                  icon: <IconFolder size={15} />,
                  onClick: () => { void getDesktopHost().revealPath?.(projCtx.root) },
                }]
              : []),
            {
              label: '从边栏移除',
              icon: <IconX size={15} />,
              onClick: () => {
                // 对齐 Codex removeProject:只从边栏移除,磁盘文件与会话记录都不动;再次选择该文件夹自动回来。
                hideRoot(projCtx.root)
                toast('已从边栏移除,磁盘上的文件不受影响')
              },
            },
          ]}
        />
      )}

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
