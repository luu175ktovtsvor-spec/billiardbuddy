import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Clock,
  Copy,
  Folder,
  GitFork,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
} from 'lucide-react'
import { useTabStore } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
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
  onClick,
  children,
}: {
  label: string
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{
        color: 'var(--color-text-secondary)',
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

export function TopBar() {
  const t = useTranslation()

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeTab = tabs.find((tab) => tab.sessionId === activeTabId) ?? null
  const isProductTask = activeTab?.type === 'product-task'

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
  const taskWorkDir = isProductTask ? activeProductTask?.workDir ?? null : null

  const [taskDialog, setTaskDialog] = useState<'rename' | 'archive' | null>(null)
  const [taskTitleDraft, setTaskTitleDraft] = useState('')

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

  const title = activeTab?.type === 'settings'
    ? t('sidebar.settings')
    : activeTab?.type === 'scheduled'
      ? t('sidebar.scheduled')
      : activeTab?.type === 'terminal'
        ? t('sidebar.terminal')
        : activeTab?.title || t('sidebar.newSession')

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
      useTabStore.getState().updateProductTaskTitle(activeProductTask.id, task.title)
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
          {isProductTask ? (
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
              {taskWorkDir ? (
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

        <div className="flex h-full shrink-0 items-center">
          <div className="flex items-center gap-0.5">
            <IconBtn label={t('search.global.trigger')} onClick={() => openModal('task-search')}>
              <Search size={18} />
            </IconBtn>
            <IconBtn label={t('search.global.recentTitle')} onClick={() => openModal('task-search')}>
              <Clock size={18} />
            </IconBtn>
          </div>
          <WindowControls />
        </div>
      </header>

      {menuAt && isProductTask && activeProductTask && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-[200px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1.5"
          style={{ left: menuAt.x, top: menuAt.y, boxShadow: 'var(--shadow-dropdown)' }}
        >
          {taskWorkDir ? (
            <MenuItem
              onClick={() => {
                setMenuAt(null)
                void handleCopy(taskWorkDir)
              }}
            >
              <Folder size={15} /> 复制工作目录
            </MenuItem>
          ) : null}
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
