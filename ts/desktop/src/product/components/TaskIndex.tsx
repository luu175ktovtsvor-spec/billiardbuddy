import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type {
  ContinueProductTaskInput,
  ProductProject,
  ProductTaskAction,
  ProductTaskIndexResponse,
  ProductTaskPermissionMode,
  ProductTaskRecord,
} from '../domain/types'
import { CopyButton } from '../../components/shared/CopyButton'
import { DirectoryPicker } from '../../components/shared/DirectoryPicker'
import {
  productTaskCommandsApi,
  type ProductTaskSkillCommand,
} from '../api/taskCommands'
import {
  buildTaskComposerCommands,
  resolveTaskComposerRuntimeCommand,
  type TaskComposerCommand,
} from '../taskComposerCommands'
import { shouldSubmitOnEnter } from '../../components/chat/sendShortcut'
import { useSettingsStore } from '../../stores/settingsStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { buildProductTaskLink } from '../../../../shared/product/taskLinks'
import { orderProductProjects, orderProductTasks } from '../taskOrdering'
import {
  PRODUCT_TASK_RUNTIME_LABEL,
  type ProductTaskRuntimeState,
} from '../taskRuntime'

export type TaskIndexProps = {
  index: ProductTaskIndexResponse
  isLoading: boolean
  error: string | null
  mutations: Record<string, boolean | undefined>
  onRefresh: () => Promise<void>
  onRenameTask: (taskId: string, title: string) => Promise<unknown>
  onPinTask: (taskId: string) => Promise<unknown>
  onUnpinTask: (taskId: string) => Promise<unknown>
  onArchiveTask: (taskId: string) => Promise<unknown>
  onRestoreTask: (taskId: string) => Promise<unknown>
  onContinueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<unknown>
  onRequestNewTask: () => void
  onOpenTask: (task: ProductTaskRecord) => void
  runtimeStatesBySessionId?: Record<string, ProductTaskRuntimeState>
}

const WORKTREE_STATE_LABEL: Record<string, string> = {
  not_requested: '未使用工作树',
  planned: '工作树计划中',
  materialized: '独立工作树已启用',
}

function taskActionKey(taskId: string, action: string): string {
  return `${taskId}:${action}`
}

function hasAction(task: ProductTaskRecord, action: ProductTaskAction): boolean {
  return task.actions.includes(action)
}

function hasActiveTaskRun(runtimeState: ProductTaskRuntimeState): boolean {
  return runtimeState === 'running' || runtimeState === 'awaiting_approval'
}

function taskKindLabel(task: ProductTaskRecord): string {
  if (task.kind === 'continuation') return '继续任务'
  return '任务'
}

function taskLifecycleLabel(task: ProductTaskRecord): string {
  return task.lifecycle === 'archived' ? '已归档' : '进行中'
}

function taskMarkdown(task: ProductTaskRecord, runtimeState: ProductTaskRuntimeState): string {
  return [
    `# 任务：${task.title}`,
    '',
    `- 任务 ID：\`${task.id}\``,
    `- 任务生命周期：${taskLifecycleLabel(task)}`,
    `- 运行状态：${PRODUCT_TASK_RUNTIME_LABEL[runtimeState]}`,
    `- 工作目录：\`${task.workDir || '未提供'}\``,
    `- 工作树：${WORKTREE_STATE_LABEL[task.worktreeState] ?? '未使用工作树'}`,
    `- 类型：${taskKindLabel(task)}`,
  ].join('\n')
}

function projectTasks(tasks: readonly ProductTaskRecord[], projectId: string): ProductTaskRecord[] {
  return tasks.filter((task) => task.projectId === projectId)
}

function slashQuery(value: string): string | null {
  if (!value.startsWith('/')) return null
  const command = value.slice(1)
  if (/\s/.test(command)) return null
  return command.toLocaleLowerCase()
}

function insertSlashCommand(value: string, commandName: string): string {
  const firstWhitespace = value.search(/\s/)
  const suffix = firstWhitespace === -1 ? '' : value.slice(firstWhitespace)
  return `/${commandName}${suffix || ' '}`
}

type TaskComposerSlashCommand = TaskComposerCommand & {
  key: string
}

const PERMISSION_OPTIONS: Array<{
  mode: ProductTaskPermissionMode
  label: string
  description: string
}> = [
  { mode: 'ask_for_approval', label: 'Ask for approval', description: '限制在工作区内；越过边界前由你确认将做什么、作用范围和后果。' },
  { mode: 'approve_for_me', label: 'Approve for me', description: '保持相同工作区限制；符合条件的越界请求交给独立 reviewer 判断。' },
  { mode: 'full_access', label: 'Full access', description: '解除普通文件和网络沙箱，并跳过常规审批；产品自身的隐私、费用、删除、提交和发布闸仍保留。' },
]

export function TaskIndex({
  index,
  isLoading,
  error,
  mutations,
  onRefresh,
  onRenameTask,
  onPinTask,
  onUnpinTask,
  onArchiveTask,
  onRestoreTask,
  onContinueTask,
  onRequestNewTask,
  onOpenTask,
  runtimeStatesBySessionId = {},
}: TaskIndexProps) {
  const [showArchived, setShowArchived] = useState(false)

  const orderedTasks = useMemo(() => orderProductTasks(index.tasks), [index.tasks])
  const visibleTaskPool = useMemo(
    () => orderedTasks.filter((task) => showArchived || task.lifecycle !== 'archived'),
    [orderedTasks, showArchived],
  )
  const orderedProjects = useMemo(
    () => orderProductProjects(index.projects, visibleTaskPool),
    [index.projects, visibleTaskPool],
  )

  const visibleProjects = useMemo(
    () => orderedProjects.filter((project) => projectTasks(visibleTaskPool, project.id).length > 0),
    [orderedProjects, visibleTaskPool],
  )
  const looseTasks = useMemo(
    () => visibleTaskPool.filter((task) => !index.projects.some((project) => project.id === task.projectId)),
    [index.projects, visibleTaskPool],
  )

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="product-task-index">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">任务</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">按项目和工作目录管理正在进行的工作。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={isLoading}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50"
          >
            刷新
          </button>
          {index.capabilities.createTask ? (
            <button
              type="button"
              onClick={onRequestNewTask}
              className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white"
            >
              新建任务
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <p className="text-sm text-[var(--color-text-secondary)]">共 {index.total} 个任务</p>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          显示已归档任务
        </label>
      </div>

      {error ? <div role="alert" className="mx-5 mb-3 rounded-lg border border-[var(--color-error)]/30 px-3 py-2 text-sm text-[var(--color-error)]">{error}</div> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {isLoading && index.tasks.length === 0 ? (
          <p role="status" className="py-12 text-center text-sm text-[var(--color-text-secondary)]">正在读取任务…</p>
        ) : null}

        {!isLoading && visibleProjects.length === 0 && looseTasks.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--color-text-secondary)]">
            <p>{index.capabilities.createTask ? '还没有可显示的任务。' : '当前无法创建任务。'}</p>
            {!index.capabilities.createTask ? (
              <button
                type="button"
                onClick={() => void onRefresh()}
                className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
              >
                重新检查
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-5">
          {visibleProjects.map((project) => (
            <ProjectTaskGroup
              key={project.id}
              project={project}
              tasks={projectTasks(orderedTasks, project.id)}
              showArchived={showArchived}
              mutations={mutations}
              onRenameTask={onRenameTask}
              onPinTask={onPinTask}
              onUnpinTask={onUnpinTask}
              onArchiveTask={onArchiveTask}
              onRestoreTask={onRestoreTask}
              onContinueTask={onContinueTask}
              onOpenTask={onOpenTask}
              runtimeStatesBySessionId={runtimeStatesBySessionId}
            />
          ))}
          {looseTasks.length > 0 ? (
            <ProjectTaskGroup
              project={null}
              tasks={looseTasks}
              showArchived={showArchived}
              mutations={mutations}
              onRenameTask={onRenameTask}
              onPinTask={onPinTask}
              onUnpinTask={onUnpinTask}
              onArchiveTask={onArchiveTask}
              onRestoreTask={onRestoreTask}
              onContinueTask={onContinueTask}
              onOpenTask={onOpenTask}
              runtimeStatesBySessionId={runtimeStatesBySessionId}
            />
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function TaskComposer({
  initialWorkDir,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  initialWorkDir?: string
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (input: { text: string; attachment_ids: string[]; permission_mode: ProductTaskPermissionMode; work_dir: string }) => Promise<void>
}) {
  const [initialText, setInitialText] = useState('')
  const [workDir, setWorkDir] = useState(() => initialWorkDir?.trim() ?? '')
  const [permissionMode, setPermissionMode] = useState<ProductTaskPermissionMode>('ask_for_approval')
  const [discoverableSkills, setDiscoverableSkills] = useState<ProductTaskSkillCommand[] | null>(null)
  const [commandDiscoveryWorkDir, setCommandDiscoveryWorkDir] = useState<string | null>(null)
  const [skillDiscoveryError, setSkillDiscoveryError] = useState<string | null>(null)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const composingRef = useRef(false)
  const commandWorkDir = workDir.trim()
  const isSlashInput = initialText.startsWith('/')
  const query = slashQuery(initialText)

  useEffect(() => {
    if (!isSlashInput || !commandWorkDir) {
      setDiscoverableSkills(null)
      setCommandDiscoveryWorkDir(null)
      setSkillDiscoveryError(null)
      return
    }

    let cancelled = false
    setDiscoverableSkills(null)
    setCommandDiscoveryWorkDir(commandWorkDir)
    setSkillDiscoveryError(null)

    productTaskCommandsApi.listSkills(commandWorkDir)
      .then(({ commands }) => {
        if (cancelled) return
        setDiscoverableSkills(commands)
      })
      .catch(() => {
        if (cancelled) return
        setDiscoverableSkills([])
        setSkillDiscoveryError('暂时无法读取可用命令')
      })

    return () => {
      cancelled = true
    }
  }, [commandWorkDir, isSlashInput])

  const taskComposerCommands = useMemo(
    () => buildTaskComposerCommands(discoverableSkills ?? []),
    [discoverableSkills],
  )
  const matchingCommands = useMemo<TaskComposerSlashCommand[]>(() => {
    if (query === null) return []
    return taskComposerCommands.map((command) => ({
      ...command,
      key: `command:${command.runtimeName ?? command.name}:${command.name}`,
    })).filter((command) => (
      command.name.toLocaleLowerCase().startsWith(query)
    ))
  }, [query, taskComposerCommands])
  const hasCommandDiscoveryForCurrentWorkDir = commandDiscoveryWorkDir === commandWorkDir
  const visibleCommands = hasCommandDiscoveryForCurrentWorkDir ? matchingCommands : []
  const hasPendingCommandDiscovery = discoverableSkills === null
  const visibleDiscoveryError = hasCommandDiscoveryForCurrentWorkDir
    ? visibleCommands.length === 0
      ? skillDiscoveryError
      : null
    : null
  const isCommandDiscoveryLoading = Boolean(commandWorkDir) && (
    !hasCommandDiscoveryForCurrentWorkDir || (
      hasPendingCommandDiscovery && visibleCommands.length === 0 && visibleDiscoveryError === null
    )
  )

  const submitTask = () => {
    if (isSubmitting) return
    const text = resolveTaskComposerRuntimeCommand(initialText.trim(), taskComposerCommands)
    if (!text || !commandWorkDir) return
    void onSubmit({ text, attachment_ids: [], permission_mode: permissionMode, work_dir: commandWorkDir })
  }

  const handleInitialGoalKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!shouldSubmitOnEnter(event, chatSendBehavior)) return

    event.preventDefault()
    submitTask()
  }

  return (
    <form
      className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 py-6"
      onSubmit={(event) => {
        event.preventDefault()
        submitTask()
      }}
    >
      <div className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
        <label className="flex flex-col gap-1">
          你想完成什么？
          <textarea
            aria-label="你想完成什么？"
            value={initialText}
            onChange={(event) => setInitialText(event.target.value)}
            onKeyDown={handleInitialGoalKeyDown}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            placeholder="描述这项任务希望完成什么…"
            rows={5}
            className="resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
        </label>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">直接描述目标；输入 / 可使用当前项目的可用命令。</p>
        {query !== null ? (
          <TaskComposerSlashPicker
            workDir={commandWorkDir}
            commands={visibleCommands}
            isLoading={isCommandDiscoveryLoading}
            error={visibleDiscoveryError}
            onSelect={(command) => setInitialText((value) => insertSlashCommand(value, command.name))}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
        <span>工作目录</span>
        <DirectoryPicker value={commandWorkDir} onChange={setWorkDir} />
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">任务只会在这里选择并登记的目录中执行。</p>
      </div>
      <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
        执行权限
        <select
          aria-label="执行权限"
          value={permissionMode}
          onChange={(event) => setPermissionMode(event.target.value as ProductTaskPermissionMode)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none"
        >
          {PERMISSION_OPTIONS.map((option) => <option key={option.mode} value={option.mode}>{option.label}</option>)}
        </select>
        <span className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {PERMISSION_OPTIONS.find((option) => option.mode === permissionMode)?.description}
        </span>
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={isSubmitting || !initialText.trim() || !commandWorkDir} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{isSubmitting ? '正在开始…' : '开始任务'}</button>
        <button type="button" onClick={onCancel} disabled={isSubmitting} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">取消</button>
      </div>
    </form>
  )
}

function TaskComposerSlashPicker({
  workDir,
  commands,
  isLoading,
  error,
  onSelect,
}: {
  workDir: string
  commands: TaskComposerSlashCommand[]
  isLoading: boolean
  error: string | null
  onSelect: (command: TaskComposerSlashCommand) => void
}) {
  if (!workDir) {
    return <p className="text-xs text-[var(--color-text-tertiary)]">当前没有可用的项目命令；仍可直接描述目标。</p>
  }

  if (isLoading) {
    return <p role="status" className="text-xs text-[var(--color-text-tertiary)]">正在读取可用命令…</p>
  }

  if (error) {
    return <p role="alert" className="text-xs text-[var(--color-error)]">无法读取可用命令：{error}</p>
  }

  if (commands.length === 0) {
    return <p className="text-xs text-[var(--color-text-tertiary)]">当前项目没有匹配的可用命令。</p>
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" aria-label="可用命令">
      {commands.map((command) => (
        <button
          key={command.key}
          type="button"
          onClick={() => onSelect(command)}
          className="flex w-full items-start gap-3 border-t border-[var(--color-border)] px-3 py-2 text-left first:border-t-0 hover:bg-[var(--color-surface-hover)]"
        >
          <span className="shrink-0 text-sm font-medium text-[var(--color-text-primary)]">/{command.name}</span>
          {command.description ? (
            <span className="min-w-0 text-xs leading-5 text-[var(--color-text-secondary)]">{command.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

function ProjectTaskGroup({
  project,
  tasks,
  showArchived,
  mutations,
  onRenameTask,
  onPinTask,
  onUnpinTask,
  onArchiveTask,
  onRestoreTask,
  onContinueTask,
  onOpenTask,
  runtimeStatesBySessionId,
}: {
  project: ProductProject | null
  tasks: ProductTaskRecord[]
  showArchived: boolean
  mutations: Record<string, boolean | undefined>
  onRenameTask: (taskId: string, title: string) => Promise<unknown>
  onPinTask: (taskId: string) => Promise<unknown>
  onUnpinTask: (taskId: string) => Promise<unknown>
  onArchiveTask: (taskId: string) => Promise<unknown>
  onRestoreTask: (taskId: string) => Promise<unknown>
  onContinueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<unknown>
  onOpenTask: (task: ProductTaskRecord) => void
  runtimeStatesBySessionId: Record<string, ProductTaskRuntimeState>
}) {
  const visibleTasks = tasks.filter((task) => showArchived || task.lifecycle !== 'archived')
  if (visibleTasks.length === 0) return null

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)]" data-testid={project ? `product-project-${project.id}` : 'product-unassigned-tasks'}>
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-4 py-3">
        <h2 className="font-medium text-[var(--color-text-primary)]">{project?.title ?? '未归属项目的任务'}</h2>
        {project ? <p className="mt-1 break-all text-xs text-[var(--color-text-secondary)]">项目根目录：{project.rootDir}</p> : null}
      </header>
      <div className="divide-y divide-[var(--color-border)]">
        {visibleTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            mutations={mutations}
            onRenameTask={onRenameTask}
            onPinTask={onPinTask}
            onUnpinTask={onUnpinTask}
            onArchiveTask={onArchiveTask}
            onRestoreTask={onRestoreTask}
            onContinueTask={onContinueTask}
            onOpenTask={onOpenTask}
            runtimeState={runtimeStatesBySessionId[task.id] ?? 'not_connected'}
          />
        ))}
      </div>
    </section>
  )
}

function TaskRow({
  task,
  mutations,
  onRenameTask,
  onPinTask,
  onUnpinTask,
  onArchiveTask,
  onRestoreTask,
  onContinueTask,
  onOpenTask,
  runtimeState,
}: {
  task: ProductTaskRecord
  mutations: Record<string, boolean | undefined>
  onRenameTask: (taskId: string, title: string) => Promise<unknown>
  onPinTask: (taskId: string) => Promise<unknown>
  onUnpinTask: (taskId: string) => Promise<unknown>
  onArchiveTask: (taskId: string) => Promise<unknown>
  onRestoreTask: (taskId: string) => Promise<unknown>
  onContinueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<unknown>
  onOpenTask: (task: ProductTaskRecord) => void
  runtimeState: ProductTaskRuntimeState
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [taskWindowError, setTaskWindowError] = useState<string | null>(null)
  const renamed = mutations[taskActionKey(task.id, 'rename')] === true
  const desktopHost = getDesktopHost()
  const taskLink = buildProductTaskLink(task.id)
  const canArchiveTask = hasAction(task, 'archive') && !hasActiveTaskRun(runtimeState)

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch {
      // The product store exposes the server error in the index surface.
    }
  }

  const openInNewWindow = () => {
    setTaskWindowError(null)
    void desktopHost.window.openProductTask(task.id).catch(() => {
      setTaskWindowError('暂时无法打开独立任务窗口，请稍后重试。')
    })
  }

  return (
    <article className="px-4 py-3" data-testid={`product-task-${task.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!title.trim()) return
                void run(async () => {
                  await onRenameTask(task.id, title.trim())
                  setEditing(false)
                })
              }}
            >
              <input aria-label="重命名任务" value={title} onChange={(event) => setTitle(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text-primary)]" />
              <button type="submit" disabled={renamed} className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text-primary)]">保存</button>
              <button type="button" onClick={() => { setTitle(task.title); setEditing(false) }} disabled={renamed} className="rounded-lg px-2 py-1 text-sm text-[var(--color-text-secondary)]">取消</button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium text-[var(--color-text-primary)]">{task.title}</h3>
              {task.pinnedAt ? <span className="rounded-full bg-[var(--color-surface-selected)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">已置顶</span> : null}
              {task.lifecycle === 'archived' ? <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">已归档</span> : null}
              <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">{taskKindLabel(task)}</span>
              <span aria-label={`运行状态：${PRODUCT_TASK_RUNTIME_LABEL[runtimeState]}`} className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]">{PRODUCT_TASK_RUNTIME_LABEL[runtimeState]}</span>
            </div>
          )}
          <dl className="mt-2 grid gap-1 text-xs text-[var(--color-text-secondary)]">
            <div><dt className="inline">工作目录：</dt><dd className="inline break-all">{task.workDir || '未提供'}</dd></div>
            <div><dt className="inline">工作树：</dt><dd className="inline">{WORKTREE_STATE_LABEL[task.worktreeState] ?? '未使用工作树'}</dd></div>
          </dl>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {taskLink ? (
            <CopyButton
              text={taskLink}
              label="复制链接"
              copiedLabel="已复制链接"
              className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
            />
          ) : null}
          <CopyButton
            text={task.id}
            label="复制 ID"
            copiedLabel="已复制 ID"
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
          />
          <CopyButton
            text={taskMarkdown(task, runtimeState)}
            label="复制 Markdown"
            copiedLabel="已复制 Markdown"
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
          />
          <button type="button" onClick={() => onOpenTask(task)} className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">打开</button>
          {desktopHost.capabilities.taskWindows ? (
            <button type="button" onClick={openInNewWindow} className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">新窗口打开</button>
          ) : null}
          {hasAction(task, 'rename') ? <button type="button" onClick={() => setEditing(true)} className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">重命名</button> : null}
          {hasAction(task, 'pin') ? <TaskActionButton pending={mutations[taskActionKey(task.id, 'pin')] === true} label="置顶" onClick={() => run(() => onPinTask(task.id))} /> : null}
          {hasAction(task, 'unpin') ? <TaskActionButton pending={mutations[taskActionKey(task.id, 'unpin')] === true} label="取消置顶" onClick={() => run(() => onUnpinTask(task.id))} /> : null}
          {hasAction(task, 'continue') ? (
            <>
              <TaskActionButton
                pending={mutations[taskActionKey(task.id, 'continue')] === true}
                label="继续"
                onClick={() => run(() => onContinueTask(task.id, { target: 'current_workspace' }))}
              />
              <TaskActionButton
                pending={mutations[taskActionKey(task.id, 'continue')] === true}
                label="新工作树继续"
                onClick={() => run(() => onContinueTask(task.id, { target: 'new_worktree' }))}
              />
            </>
          ) : null}
          {canArchiveTask ? <TaskActionButton pending={mutations[taskActionKey(task.id, 'archive')] === true} label="归档" onClick={() => run(() => onArchiveTask(task.id))} /> : null}
          {hasAction(task, 'restore') ? <TaskActionButton pending={mutations[taskActionKey(task.id, 'restore')] === true} label="恢复" onClick={() => run(() => onRestoreTask(task.id))} /> : null}
        </div>
      </div>
      {taskWindowError ? <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{taskWindowError}</p> : null}
    </article>
  )
}

function TaskActionButton({ pending, label, onClick }: { pending: boolean; label: string; onClick: () => void }) {
  return <button type="button" disabled={pending} onClick={onClick} className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">{pending ? '处理中…' : label}</button>
}
