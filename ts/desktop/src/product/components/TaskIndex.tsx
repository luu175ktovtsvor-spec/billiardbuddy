import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  ProductProject,
  ProductProjectDirectory,
  ProductTaskAction,
  ProductTaskIndexResponse,
  ProductTaskPermissionMode,
  ProductTaskRecord,
} from '../domain/types'
import { AttachmentGallery } from '../../components/chat/AttachmentGallery'
import { CopyButton } from '../../components/shared/CopyButton'
import {
  productTaskCommandsApi,
  type ProductTaskAgentCommand,
  type ProductTaskSkillCommand,
} from '../api/taskCommands'
import {
  buildTaskComposerCommands,
  resolveTaskComposerRuntimeCommand,
  type TaskComposerCommand,
} from '../taskComposerCommands'
import { shouldSubmitOnEnter } from '../../components/chat/sendShortcut'
import {
  filesToInlineComposerAttachments,
  type ComposerAttachment,
} from '../../lib/composerAttachments'
import { useSettingsStore } from '../../stores/settingsStore'
import { getDesktopHost } from '../../lib/desktopHost'
import { buildProductTaskLink } from '../../../../shared/product/taskLinks'
import type { ProductTaskInitialMessage } from '../taskLaunch'
import { validateProductTaskAttachments } from '../taskAttachments'
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

const PRODUCT_TASK_PERMISSION_OPTIONS: Array<{
  value: ProductTaskPermissionMode
  label: string
  description: string
}> = [
  {
    value: 'ask',
    label: '每次确认',
    description: '涉及文件修改和高风险操作时会先征求你的确认。',
  },
  {
    value: 'allow_edits',
    label: '允许自动修改文件',
    description: '可直接修改工作目录中的文件；其他高风险操作仍会请求确认。',
  },
  {
    value: 'plan_only',
    label: '先制定计划',
    description: '先分析并给出方案，不直接修改文件。',
  },
]

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
          <p className="py-12 text-center text-sm text-[var(--color-text-secondary)]">还没有可显示的任务。</p>
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
  projects,
  directories,
  initialWorkDir,
  isSubmitting,
  onCancel,
  onSubmit,
}: {
  projects: ProductProject[]
  directories: ProductProjectDirectory[]
  initialWorkDir?: string
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (input: CreateProductTaskInput, initialMessage?: ProductTaskInitialMessage) => Promise<void>
}) {
  const [projectId, setProjectId] = useState('')
  const [directoryId, setDirectoryId] = useState('')
  const [workDir, setWorkDir] = useState(() => initialWorkDir ?? '')
  const [title, setTitle] = useState('')
  const [initialText, setInitialText] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [permissionMode, setPermissionMode] = useState<ProductTaskPermissionMode>('ask')
  const [discoverableSkills, setDiscoverableSkills] = useState<ProductTaskSkillCommand[] | null>(null)
  const [discoverableAgents, setDiscoverableAgents] = useState<ProductTaskAgentCommand[] | null>(null)
  const [agentDiscoveryWorkDir, setAgentDiscoveryWorkDir] = useState<string | null>(null)
  const [skillDiscoveryError, setSkillDiscoveryError] = useState<string | null>(null)
  const [agentDiscoveryError, setAgentDiscoveryError] = useState<string | null>(null)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const desktopHost = getDesktopHost()
  const canChooseWorkDir = desktopHost.isDesktop && desktopHost.capabilities.dialogs
  const normalizedWorkDir = workDir.trim()
  const isSlashInput = initialText.startsWith('/')
  const query = slashQuery(initialText)

  useEffect(() => {
    if (directoryId) return

    const matchingDirectory = directories.find((directory) => directory.path === normalizedWorkDir)
    if (!matchingDirectory) return

    setProjectId(matchingDirectory.projectId)
    setDirectoryId(matchingDirectory.id)
  }, [directories, directoryId, normalizedWorkDir])

  useEffect(() => {
    if (!isSlashInput || !normalizedWorkDir) {
      setDiscoverableSkills(null)
      setDiscoverableAgents(null)
      setAgentDiscoveryWorkDir(null)
      setSkillDiscoveryError(null)
      setAgentDiscoveryError(null)
      return
    }

    let cancelled = false
    setDiscoverableSkills(null)
    setDiscoverableAgents(null)
    setAgentDiscoveryWorkDir(normalizedWorkDir)
    setSkillDiscoveryError(null)
    setAgentDiscoveryError(null)

    productTaskCommandsApi.listSkills(normalizedWorkDir)
      .then(({ commands }) => {
        if (cancelled) return
        setDiscoverableSkills(commands)
      })
      .catch(() => {
        if (cancelled) return
        setDiscoverableSkills([])
        setSkillDiscoveryError('暂时无法读取可用命令')
      })

    productTaskCommandsApi.listAgents(normalizedWorkDir)
      .then(({ agents }) => {
        if (cancelled) return
        setDiscoverableAgents(agents)
      })
      .catch(() => {
        if (cancelled) return
        setDiscoverableAgents([])
        setAgentDiscoveryError('暂时无法读取可用命令')
      })

    return () => {
      cancelled = true
    }
  }, [isSlashInput, normalizedWorkDir])

  const taskComposerCommands = useMemo(
    () => buildTaskComposerCommands(discoverableSkills ?? [], discoverableAgents ?? []),
    [discoverableAgents, discoverableSkills],
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
  const hasAgentDiscoveryForCurrentWorkDir = agentDiscoveryWorkDir === normalizedWorkDir
  const visibleCommands = hasAgentDiscoveryForCurrentWorkDir ? matchingCommands : []
  const hasPendingCommandDiscovery = discoverableSkills === null || discoverableAgents === null
  const visibleDiscoveryError = hasAgentDiscoveryForCurrentWorkDir
    ? visibleCommands.length === 0
      ? [skillDiscoveryError, agentDiscoveryError].filter(Boolean).join('；') || null
      : null
    : null
  const isAgentDiscoveryLoading = Boolean(normalizedWorkDir) && (
    !hasAgentDiscoveryForCurrentWorkDir || (
      hasPendingCommandDiscovery && visibleCommands.length === 0 && visibleDiscoveryError === null
    )
  )

  const setRegisteredWorkDir = (nextWorkDir: string) => {
    const matchingDirectory = directories.find((directory) => directory.path === nextWorkDir.trim())
    setWorkDir(nextWorkDir)
    setProjectId(matchingDirectory?.projectId ?? '')
    setDirectoryId(matchingDirectory?.id ?? '')
  }

  const selectProject = (nextProjectId: string) => {
    if (!nextProjectId) {
      setProjectId('')
      setDirectoryId('')
      return
    }

    const project = projects.find((entry) => entry.id === nextProjectId)
    const projectDirectories = directories.filter((directory) => directory.projectId === nextProjectId)
    const rootDirectory = projectDirectories.find((directory) => directory.path === project?.rootDir)
    const directory = rootDirectory ?? projectDirectories[0]

    setProjectId(nextProjectId)
    setDirectoryId(directory?.id ?? '')
    if (directory) {
      setWorkDir(directory.path)
    } else if (project) {
      setWorkDir(project.rootDir)
    }
  }

  const selectDirectory = (nextDirectoryId: string) => {
    if (!nextDirectoryId) {
      setDirectoryId('')
      return
    }

    const directory = directories.find((entry) => entry.id === nextDirectoryId)
    if (!directory) return

    setProjectId(directory.projectId)
    setDirectoryId(directory.id)
    setWorkDir(directory.path)
  }

  const chooseWorkDir = async () => {
    if (!canChooseWorkDir) return

    try {
      const selected = await desktopHost.dialogs.open({
        directory: true,
        multiple: false,
        title: '选择任务工作目录',
      })
      const nextWorkDir = Array.isArray(selected) ? selected[0] : selected
      if (!nextWorkDir) return

      setRegisteredWorkDir(nextWorkDir)
    } catch {
      return
    }
  }

  const appendAttachments = (nextAttachments: ComposerAttachment[]) => {
    if (nextAttachments.length === 0) return
    setAttachments((current) => [...current, ...nextAttachments])
    setAttachmentError(null)
  }

  const openAttachmentPicker = () => {
    fileInputRef.current?.click()
  }

  const selectBrowserFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return

    void filesToInlineComposerAttachments(files)
      .then(appendAttachments)
      .catch(() => {
        // File input remains available for another selection.
      })
    event.target.value = ''
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
    setAttachmentError(null)
  }

  const submitTask = () => {
    if (isSubmitting || !normalizedWorkDir) return

    const attachmentResult = validateProductTaskAttachments(attachments)
    if (attachmentResult.ok === false) {
      setAttachmentError(attachmentResult.message)
      return
    }

    const taskInput: CreateProductTaskInput = {
      workDir: normalizedWorkDir,
      ...(projectId && directoryId ? { projectId, directoryId } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(useWorktree ? { useWorktree: true } : {}),
      permissionMode,
    }
    const initialAttachments = attachmentResult.attachments
    const initialMessage: ProductTaskInitialMessage = {
      text: resolveTaskComposerRuntimeCommand(initialText.trim(), taskComposerCommands),
      attachments: initialAttachments,
    }
    void (initialMessage.text || initialAttachments.length > 0
      ? onSubmit(taskInput, initialMessage)
      : onSubmit(taskInput))
  }

  const handleInitialGoalKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!shouldSubmitOnEnter(event, chatSendBehavior)) return

    event.preventDefault()
    submitTask()
  }

  return (
    <form
      className="grid gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] px-5 py-4 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault()
        submitTask()
      }}
    >
      {projects.length > 0 ? (
        <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
          项目
          <select aria-label="选择项目" value={projectId} onChange={(event) => selectProject(event.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)]">
            <option value="">手动填写工作目录</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title} · {project.rootDir}</option>)}
          </select>
        </label>
      ) : null}
      {projectId ? (
        <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
          项目目录
          <select aria-label="选择项目目录" value={directoryId} onChange={(event) => selectDirectory(event.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)]">
            <option value="">手动填写工作目录</option>
            {directories.filter((directory) => directory.projectId === projectId).map((directory) => (
              <option key={directory.id} value={directory.id}>{directory.label} · {directory.path}</option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
        <label htmlFor="product-task-work-dir">工作目录</label>
        <div className="flex gap-2">
          <input id="product-task-work-dir" aria-label="工作目录" required value={workDir} onChange={(event) => setRegisteredWorkDir(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)]" />
          {canChooseWorkDir ? (
            <button type="button" onClick={() => void chooseWorkDir()} className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">选择文件夹</button>
          ) : null}
        </div>
      </div>
      <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
        任务标题（可选）
        <input aria-label="任务标题" value={title} onChange={(event) => setTitle(event.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)]" />
      </label>
      <label className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)]">
        执行权限
        <select
          aria-label="执行权限"
          value={permissionMode}
          onChange={(event) => setPermissionMode(event.target.value as ProductTaskPermissionMode)}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)]"
        >
          {PRODUCT_TASK_PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {PRODUCT_TASK_PERMISSION_OPTIONS.find((option) => option.value === permissionMode)?.description}
        </span>
      </label>
      <div className="flex flex-col gap-1 text-sm text-[var(--color-text-secondary)] md:col-span-2">
        <label className="flex flex-col gap-1">
          初始目标（可选）
          <textarea
            aria-label="初始目标（可选）"
            value={initialText}
            onChange={(event) => setInitialText(event.target.value)}
            onKeyDown={handleInitialGoalKeyDown}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            placeholder="描述这项任务希望完成什么…"
            rows={3}
            className="resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
        </label>
        {attachments.length > 0 ? (
          <div className="pt-1">
            <AttachmentGallery attachments={attachments} variant="composer" onRemove={removeAttachment} />
          </div>
        ) : null}
        {attachmentError ? <p role="alert" className="pt-1 text-xs text-[var(--color-error)]">{attachmentError}</p> : null}
        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={selectBrowserFiles}
          />
          <button
            type="button"
            onClick={openAttachmentPicker}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]"
          >
            添加初始附件
          </button>
        </div>
        {query !== null ? (
          <TaskComposerSlashPicker
            workDir={normalizedWorkDir}
            commands={visibleCommands}
            isLoading={isAgentDiscoveryLoading}
            error={visibleDiscoveryError}
            onSelect={(command) => setInitialText((value) => insertSlashCommand(value, command.name))}
          />
        ) : null}
      </div>
      <label className="flex items-center gap-2 self-end text-sm text-[var(--color-text-secondary)]">
        <input type="checkbox" checked={useWorktree} onChange={(event) => setUseWorktree(event.target.checked)} />
        在新工作树中开始
      </label>
      <div className="flex gap-2 md:col-span-2">
        <button type="submit" disabled={isSubmitting || !workDir.trim()} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{isSubmitting ? '正在创建…' : '创建任务'}</button>
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
    return <p className="text-xs text-[var(--color-text-tertiary)]">填写工作目录后，才能读取当前可用命令。</p>
  }

  if (isLoading) {
    return <p role="status" className="text-xs text-[var(--color-text-tertiary)]">正在读取可用命令…</p>
  }

  if (error) {
    return <p role="alert" className="text-xs text-[var(--color-error)]">无法读取可用命令：{error}</p>
  }

  if (commands.length === 0) {
    return <p className="text-xs text-[var(--color-text-tertiary)]">当前工作目录没有匹配的可用命令。</p>
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
