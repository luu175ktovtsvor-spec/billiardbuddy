import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Clock,
  Copy,
  Folder,
  GitFork,
  Globe2,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquareTerminal,
} from 'lucide-react'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { ActionDialog } from '../shared/ActionDialog'
import { useTranslation } from '../../i18n'
import { copyTextToClipboard } from '../chat/clipboard'
import { getDesktopHost } from '../../lib/desktopHost'
import { WindowControls, showWindowControls } from './WindowControls'
import {
  productTaskMutationKey,
  useProductTaskStore,
} from '../../product/stores/productTaskStore'
import { continueProductTask } from '../../product/taskLaunch'

const isWindowsPlatform = typeof navigator !== 'undefined' && /Win/.test(navigator.platform)

function IconBtn({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{
        color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
        background: active ? 'var(--color-surface-selected)' : undefined,
      }}
    >
      {children}
    </button>
  )
}

function MenuItem({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)] disabled:cursor-default disabled:opacity-50"
      style={{ color: 'var(--color-text-primary)' }}
    >
      {children}
    </button>
  )
}

function taskActionErrorMessage(): string {
  // Product-task failures can include backend implementation details. The task
  // page already retains retryable state, while the top bar stays user-facing.
  return '操作暂未完成，请稍后重试。'
}

/**
 * 把当前会话里“我 / 助手”的正文文字拼成纯文本，供“复制整段对话”使用。
 * 思考过程、工具调用、系统提示等一律不进复制稿——只取 user_text / assistant_text。
 */
function composeConversationText(
  sessionId: string,
  title: string,
  roleUser: string,
  roleAssistant: string,
): string {
  const messages = useChatStore.getState().getSession(sessionId).messages
  const lines: string[] = []
  if (title) lines.push(`【${title}】`, '')
  for (const message of messages) {
    if (message.type === 'user_text' && message.content.trim()) {
      lines.push(`${roleUser}：${message.content.trim()}`, '')
    } else if (message.type === 'assistant_text' && message.content.trim()) {
      lines.push(`${roleAssistant}：${message.content.trim()}`, '')
    }
  }
  return lines.join('\n').trim()
}

export function TopBar() {
  const t = useTranslation()

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isChat = activeTab?.type === 'session'
  const isProductTask = activeTab?.type === 'product-task'
  const isTaskSurface = isChat || isProductTask
  const terminalOpen = useTerminalPanelStore((state) => (
    activeTabId ? state.panelBySession[activeTabId]?.isOpen ?? false : false
  ))

  const sidebarOpen = useUIStore((s) => s.sidebarOpen)
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)
  const openModal = useUIStore((s) => s.openModal)
  const addToast = useUIStore((s) => s.addToast)
  const collapsed = !sidebarOpen

  const activeProductTask = useProductTaskStore((state) => (
    isProductTask && activeTab?.taskId
      ? state.index.tasks.find((task) => task.id === activeTab.taskId) ?? null
      : null
  ))
  const productTaskMutations = useProductTaskStore((state) => state.mutations)
  const renameTask = useProductTaskStore((state) => state.renameTask)
  const pinTask = useProductTaskStore((state) => state.pinTask)
  const unpinTask = useProductTaskStore((state) => state.unpinTask)
  const archiveTask = useProductTaskStore((state) => state.archiveTask)
  const restoreTask = useProductTaskStore((state) => state.restoreTask)
  const continueTask = useProductTaskStore((state) => state.continueTask)

  const [taskDialog, setTaskDialog] = useState<'rename' | 'archive' | null>(null)
  const [taskTitleDraft, setTaskTitleDraft] = useState('')

  // 工作目录来自 sessionStore 里当前活动会话的真实记录，不是凭空拼的路径。
  const legacySessionWorkDir = useSessionStore((s) =>
    activeTabId ? (s.sessions.find((session) => session.id === activeTabId)?.workDir ?? null) : null,
  )
  const sessionWorkDir = isProductTask
    ? activeProductTask?.workDir ?? null
    : legacySessionWorkDir

  // 文件、浏览器和终端的展开状态都按会话保存；右侧停靠位只记录当前展示哪一个面板。
  const workspacePanelOpen = useWorkspacePanelStore((s) =>
    activeTabId && isChat ? s.isPanelOpen(activeTabId) : false,
  )
  const activeRightPanel = useWorkspacePanelStore((s) =>
    activeTabId && isChat ? s.getMode(activeTabId) : 'workspace',
  )
  const browserPanelOpen = useBrowserPanelStore((s) =>
    activeTabId && isChat ? s.bySession[activeTabId]?.isOpen ?? false : false,
  )
  const workspacePanelVisible = workspacePanelOpen && activeRightPanel === 'workspace'
  const browserPanelVisible = browserPanelOpen && activeRightPanel === 'browser'

  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const hasTaskAction = (action: 'pin' | 'unpin' | 'rename' | 'archive' | 'restore' | 'continue') => (
    activeProductTask?.actions.includes(action) ?? false
  )
  const isTaskMutationPending = (action: string) => Boolean(
    activeProductTask && productTaskMutations[productTaskMutationKey(activeProductTask.id, action)],
  )

  useEffect(() => {
    if (!menuAt) return
    const close = () => setMenuAt(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuAt])

  // 标题：会话视图显示 tab 标题；其余已知 tab 类型显示对应的现成翻译；兜底显示 tab 自带标题。
  const title = isChat
    ? activeTab?.title || t('sidebar.newSession')
    : activeTab?.type === 'settings'
      ? t('sidebar.settings')
      : activeTab?.type === 'scheduled'
        ? t('sidebar.scheduled')
        : activeTab?.type === 'terminal'
          ? t('sidebar.terminal')
          : activeTab?.title || t('sidebar.newSession')

  function handleTogglePanel() {
    if (!activeTabId) return
    const workspace = useWorkspacePanelStore.getState()
    // 已打开且处于 workspace 模式时关闭；其他状态统一切到 workspace 并展开。
    if (workspace.isPanelOpen(activeTabId) && workspace.getMode(activeTabId) === 'workspace') {
      workspace.closePanel(activeTabId)
      if (useBrowserPanelStore.getState().bySession[activeTabId]?.isOpen) {
        workspace.setMode(activeTabId, 'browser')
      }
    } else {
      workspace.setMode(activeTabId, 'workspace')
      workspace.openPanel(activeTabId)
    }
  }

  function handleToggleBrowser() {
    if (!activeTabId) return
    const browser = useBrowserPanelStore.getState()
    const workspace = useWorkspacePanelStore.getState()
    if (browser.bySession[activeTabId]?.isOpen && workspace.getMode(activeTabId) === 'browser') {
      browser.close(activeTabId)
      return
    }
    browser.ensureBlank(activeTabId)
    workspace.setMode(activeTabId, 'browser')
  }

  async function handleCopy(text: string) {
    const copied = await copyTextToClipboard(text)
    addToast({ type: copied ? 'success' : 'error', message: copied ? t('common.copied') : t('common.copyFailed') })
  }

  const openRenameTask = () => {
    if (!activeProductTask) return
    setMenuAt(null)
    setTaskTitleDraft(activeProductTask.title)
    setTaskDialog('rename')
  }

  const handleRenameTask = async () => {
    if (!activeProductTask) return
    const title = taskTitleDraft.trim()
    if (!title) return

    try {
      const task = await renameTask(activeProductTask.id, title)
      if (activeTab?.type === 'product-task') {
        useTabStore.getState().updateTabTitle(activeTab.sessionId, task.title)
      }
      setTaskDialog(null)
      addToast({ type: 'success', message: '任务名称已更新。' })
    } catch {
      addToast({ type: 'error', message: taskActionErrorMessage() })
    }
  }

  const handlePinTask = async () => {
    if (!activeProductTask) return
    try {
      if (hasTaskAction('pin')) {
        await pinTask(activeProductTask.id)
        addToast({ type: 'success', message: '任务已置顶。' })
      } else if (hasTaskAction('unpin')) {
        await unpinTask(activeProductTask.id)
        addToast({ type: 'success', message: '已取消置顶。' })
      }
    } catch {
      addToast({ type: 'error', message: taskActionErrorMessage() })
    }
  }

  const handleArchiveTask = async () => {
    if (!activeProductTask) return
    try {
      await archiveTask(activeProductTask.id)
      setTaskDialog(null)
      addToast({ type: 'success', message: '任务已归档，可随时恢复或继续。' })
    } catch {
      addToast({ type: 'error', message: taskActionErrorMessage() })
    }
  }

  const handleRestoreTask = async () => {
    if (!activeProductTask) return
    try {
      await restoreTask(activeProductTask.id)
      addToast({ type: 'success', message: '任务已恢复。' })
    } catch {
      addToast({ type: 'error', message: taskActionErrorMessage() })
    }
  }

  const handleContinueTask = async (target: 'current_workspace' | 'new_worktree') => {
    if (!activeProductTask) return
    try {
      const task = await continueProductTask({
        continueTask,
        openTask: (nextTask) => useTabStore.getState().openProductTaskTab(nextTask.id, nextTask.title),
      }, activeProductTask.id, { target })
      addToast({ type: 'success', message: `已打开继续任务：${task.title}` })
    } catch {
      addToast({ type: 'error', message: taskActionErrorMessage() })
    }
  }

  const desktopHost = getDesktopHost()
  // 侧栏折叠后，macOS 顶栏需为左侧红绿灯预留空间；Windows 不需要。
  const leftPad = collapsed && desktopHost.isDesktop && !isWindowsPlatform ? 'pl-[78px]' : 'pl-3'

  return (
    <>
      <header
        data-desktop-drag-region
        data-testid="topbar"
        className={`flex h-[46px] shrink-0 items-center justify-between bg-[var(--color-app-main)] ${showWindowControls ? 'pr-0' : 'pr-3'} ${leftPad}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {collapsed && (
            <IconBtn label={t('sidebar.expand')} onClick={toggleSidebar}>
              <PanelLeft size={18} />
            </IconBtn>
          )}
          {isTaskSurface ? (
            <button
              type="button"
              title="任务操作"
              aria-label={`任务操作：${title}`}
              onClick={(event) => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                setMenuAt({ x: rect.left, y: rect.bottom + 4 })
              }}
              className="group/history -ml-1 flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg px-2 text-left text-base font-medium transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-secondary)' }}
              data-testid="thread-more"
            >
              {sessionWorkDir ? (
                <Folder size={15} className="shrink-0 opacity-70" />
              ) : null}
              <span className="truncate">{title}</span>
              <ChevronDown
                size={12}
                className="shrink-0 opacity-0 transition-opacity group-hover/history:opacity-60 group-focus-visible/history:opacity-60"
              />
            </button>
          ) : (
            <span className="px-2 text-base font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              {title}
            </span>
          )}
        </div>

        {/* 会话专属操作只在会话视图显示；设置/定时任务/终端等页面不挂这一排按钮。
            “分享”按钮已下架：当前仓库没有 ShareModal 等价实现，不做假按钮。 */}
        <div className="flex h-full shrink-0 items-center">
          {isChat && (
            <div className="flex items-center gap-0.5">
              <IconBtn label={t('search.global.trigger')} onClick={() => openModal('task-search')}>
                <Search size={18} />
              </IconBtn>
              <IconBtn label={t('search.global.recentTitle')} onClick={() => openModal('task-search')}>
                <Clock size={18} />
              </IconBtn>
              <IconBtn
                label={t('tabs.openTerminal')}
                active={terminalOpen}
                onClick={() => activeTabId && useTerminalPanelStore.getState().togglePanel(activeTabId)}
              >
                <SquareTerminal size={18} />
              </IconBtn>
              <IconBtn
                label={browserPanelVisible ? t('tabs.hideBrowser') : t('tabs.showBrowser')}
                active={browserPanelOpen}
                onClick={handleToggleBrowser}
              >
                <Globe2 size={18} />
              </IconBtn>
              <IconBtn
                label={workspacePanelVisible ? t('tabs.hideWorkspace') : t('tabs.showWorkspace')}
                active={workspacePanelOpen}
                onClick={handleTogglePanel}
              >
                <PanelRight size={18} />
              </IconBtn>
            </div>
          )}
          <WindowControls />
        </div>
      </header>

      {menuAt && activeTab && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1.5"
          style={{ left: menuAt.x, top: menuAt.y, boxShadow: 'var(--shadow-dropdown)' }}
        >
          {isChat && activeTabId ? (
            <MenuItem
              onClick={() => {
                setMenuAt(null)
                void handleCopy(
                  composeConversationText(activeTabId, title, t('search.global.roleUser'), t('search.global.roleAssistant')),
                )
              }}
            >
              <Copy size={15} /> 复制整段对话
            </MenuItem>
          ) : null}
          {sessionWorkDir && (
            <MenuItem
              onClick={() => {
                setMenuAt(null)
                void handleCopy(sessionWorkDir)
              }}
            >
              <Folder size={15} /> 复制工作目录
            </MenuItem>
          )}
          {activeProductTask ? (
            <>
              <div className="my-1 border-t border-[var(--color-border)]" role="separator" />
              <MenuItem
                onClick={() => {
                  setMenuAt(null)
                  void handleCopy(activeProductTask.id)
                }}
              >
                <Copy size={15} /> 复制任务 ID
              </MenuItem>
              {hasTaskAction('rename') ? (
                <MenuItem onClick={openRenameTask}>
                  <Pencil size={15} /> 重命名任务
                </MenuItem>
              ) : null}
              {hasTaskAction('pin') || hasTaskAction('unpin') ? (
                <MenuItem
                  disabled={isTaskMutationPending(hasTaskAction('pin') ? 'pin' : 'unpin')}
                  onClick={() => {
                    setMenuAt(null)
                    void handlePinTask()
                  }}
                >
                  {hasTaskAction('pin') ? <Pin size={15} /> : <PinOff size={15} />}
                  {hasTaskAction('pin') ? '置顶任务' : '取消置顶'}
                </MenuItem>
              ) : null}
              {hasTaskAction('continue') ? (
                <>
                  <MenuItem
                    disabled={isTaskMutationPending('continue')}
                    onClick={() => {
                      setMenuAt(null)
                      void handleContinueTask('current_workspace')
                    }}
                  >
                    <GitFork size={15} /> 在当前工作目录继续
                  </MenuItem>
                  <MenuItem
                    disabled={isTaskMutationPending('continue')}
                    onClick={() => {
                      setMenuAt(null)
                      void handleContinueTask('new_worktree')
                    }}
                  >
                    <GitFork size={15} /> 在新工作树中继续
                  </MenuItem>
                </>
              ) : null}
              {hasTaskAction('archive') ? (
                <MenuItem
                  disabled={isTaskMutationPending('archive')}
                  onClick={() => {
                    setMenuAt(null)
                    setTaskDialog('archive')
                  }}
                >
                  <Archive size={15} /> 归档任务
                </MenuItem>
              ) : null}
              {hasTaskAction('restore') ? (
                <MenuItem
                  disabled={isTaskMutationPending('restore')}
                  onClick={() => {
                    setMenuAt(null)
                    void handleRestoreTask()
                  }}
                >
                  <ArchiveRestore size={15} /> 恢复任务
                </MenuItem>
              ) : null}
            </>
          ) : null}
        </div>
      )}
      <ActionDialog
        open={taskDialog === 'rename'}
        onClose={() => setTaskDialog(null)}
        title="重命名任务"
        body={(
          <label className="flex flex-col gap-2 text-sm text-[var(--color-text-secondary)]">
            任务名称
            <input
              autoFocus
              aria-label="任务名称"
              value={taskTitleDraft}
              onChange={(event) => setTaskTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleRenameTask()
                }
              }}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand)]"
            />
          </label>
        )}
        loading={isTaskMutationPending('rename')}
        actions={[
          { label: '取消', onClick: () => setTaskDialog(null) },
          {
            label: '保存',
            variant: 'primary',
            loading: isTaskMutationPending('rename'),
            disabled: !taskTitleDraft.trim(),
            onClick: handleRenameTask,
          },
        ]}
      />
      <ActionDialog
        open={taskDialog === 'archive'}
        onClose={() => setTaskDialog(null)}
        title="归档任务"
        body="归档后任务不会出现在进行中的列表中，但保留原有记录，可随时恢复或继续。"
        loading={isTaskMutationPending('archive')}
        actions={[
          { label: '取消', onClick: () => setTaskDialog(null) },
          {
            label: '确认归档',
            variant: 'danger',
            loading: isTaskMutationPending('archive'),
            onClick: handleArchiveTask,
          },
        ]}
      />
    </>
  )
}
