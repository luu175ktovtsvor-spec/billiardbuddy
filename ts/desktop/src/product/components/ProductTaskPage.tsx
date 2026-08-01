import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { getDesktopHost } from '../../lib/desktopHost'
import { useSettingsStore } from '../../stores/settingsStore'
import { PRODUCT_TASKS_TAB_ID, PRODUCT_TASK_TAB_PREFIX, useTabStore } from '../../stores/tabStore'
import { shouldSubmitOnEnter } from '../../components/chat/sendShortcut'
import type { ProductTaskRecord, ProductTaskThreadEntry } from '../domain/types'
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
import {
  PRODUCT_TASK_SAFE_ERROR_LABEL,
  canSendProductTaskMessage,
  useProductTaskRuntimeStore,
  type ProductTaskRuntime,
} from '../stores/productTaskRuntimeStore'
import { useProductTaskStore } from '../stores/productTaskStore'
import {
  productSideTaskMutationKey,
  useProductSideTaskStore,
} from '../stores/productSideTaskStore'
import {
  useProductTaskWorkspaceStore,
  type ProductTaskBrowserPreviewMode,
} from '../stores/productTaskWorkspaceStore'
import {
  buildProductTaskPreviewIntentText,
  ProductTaskBrowserPreviewDock,
  type ProductTaskBrowserPreviewCapture,
  type ProductTaskPreviewSelectionIntent,
} from './ProductTaskBrowserPreviewDock'
import { ProductTaskReviewDock } from './ProductTaskReviewDock'
import { ProductTaskTerminalDock } from './ProductTaskTerminalDock'
import {
  ProductTaskRunPanel,
  productTaskActivityDisplayLabel,
  productTaskActivityLabel,
} from './ProductTaskRunPanel'
import { ProductTaskPlanPanel } from './ProductTaskPlanPanel'
import { SideTaskPanel } from './SideTaskPanel'
import { VoiceInputControl } from './VoiceInputControl'
import { RecruitingActionApproval } from './RecruitingActionApproval'
import {
  MAX_PRODUCT_TASK_ATTACHMENT_BYTES,
  MAX_PRODUCT_TASK_ATTACHMENT_COUNT,
  createProductTaskPreviewImageDraft,
  readProductTaskAttachmentDrafts,
  validateProductTaskAttachments,
  type ProductTaskAttachmentDraft,
} from '../taskAttachments'

function runStateLabel(state: 'idle' | 'working' | 'awaiting_approval'): string {
  switch (state) {
    case 'working':
      return '正在处理'
    case 'awaiting_approval':
      return '等待确认'
    default:
      return '准备就绪'
  }
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

type ProductTaskComposerSlashCommand = TaskComposerCommand & {
  key: string
}

type ProductTaskThreadEntryViewProps = {
  entry: ProductTaskThreadEntry
  streaming: boolean
  actionPending?: boolean
  onContinueFromEntry?: (
    sourceEntryId: string,
    target: 'current_workspace' | 'new_worktree',
  ) => void
  onCreateSideTask?: (sourceEntryId: string) => void
  onQuote?: (entry: Extract<ProductTaskThreadEntry, { type: 'user_text' | 'assistant_text' }>) => void
}

function ProductTaskThreadEntryActions({
  entry,
  streaming,
  actionPending = false,
  onContinueFromEntry,
  onCreateSideTask,
  onQuote,
}: ProductTaskThreadEntryViewProps) {
  if (
    streaming ||
    entry.type === 'activity' ||
    !/^thread_[a-f0-9]{20}$/.test(entry.id) ||
    (!onContinueFromEntry && !onCreateSideTask && !onQuote)
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {onQuote ? (
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onQuote(entry)}
          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          引用
        </button>
      ) : null}
      {onContinueFromEntry ? (
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onContinueFromEntry(entry.id, 'new_worktree')}
          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          从此处继续
        </button>
      ) : null}
      {onCreateSideTask ? (
        <button
          type="button"
          disabled={actionPending}
          onClick={() => onCreateSideTask(entry.id)}
          className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          创建侧边任务
        </button>
      ) : null}
    </div>
  )
}

export function ProductTaskThreadEntryView({
  entry,
  streaming,
  actionPending,
  onContinueFromEntry,
  onCreateSideTask,
  onQuote,
}: ProductTaskThreadEntryViewProps) {
  if (entry.type === 'activity') {
    return (
      <div
        className="mx-auto flex max-w-2xl items-center gap-2 rounded-full bg-[var(--color-surface-container)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)]"
        data-testid={`product-task-activity-${entry.kind}-${entry.phase}`}
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${entry.phase === 'failed' ? 'bg-[var(--color-error)]' : 'bg-[var(--color-primary)]'}`}
        />
        {productTaskActivityLabel(entry.kind, entry.phase)}
      </div>
    )
  }

  if (entry.type === 'user_text') {
    return (
      <div className="ml-auto max-w-[min(42rem,88%)]">
        <article className="rounded-2xl rounded-br-md bg-[var(--color-primary)] px-4 py-3 text-sm leading-6 text-white">
          {entry.referenceEntryIds?.length ? (
            <p className="mb-1 text-xs text-white/75">引用了 {entry.referenceEntryIds.length} 条历史记录</p>
          ) : null}
          <p className="whitespace-pre-wrap">{entry.text}</p>
          {entry.attachments?.length ? (
            <ul aria-label="已附加文件" className="mt-2 flex flex-wrap gap-1.5">
              {entry.attachments.map((attachment, index) => (
                <li
                  key={`${attachment.type}:${attachment.name}:${index}`}
                  className="inline-flex max-w-full items-center gap-1 rounded-md bg-white/15 px-2 py-1 text-xs text-white"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                    {attachment.type === 'image' ? 'image' : 'description'}
                  </span>
                  <span className="max-w-[16rem] truncate">{attachment.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
        <ProductTaskThreadEntryActions
          entry={entry}
          streaming={streaming}
          actionPending={actionPending}
          onContinueFromEntry={onContinueFromEntry}
          onCreateSideTask={onCreateSideTask}
          onQuote={onQuote}
        />
      </div>
    )
  }

  const resolveImageSrc = (source: string): string | null => {
    const trimmed = source.trim()
    return /^https?:\/\//i.test(trimmed) ? trimmed : null
  }

  return (
    <div className="max-w-3xl">
      <article className="rounded-2xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm leading-6 text-[var(--color-text-primary)]">
        <MarkdownRenderer
          content={entry.text}
          streaming={streaming}
          resolveImageSrc={resolveImageSrc}
        />
      </article>
      <ProductTaskThreadEntryActions
        entry={entry}
        streaming={streaming}
        actionPending={actionPending}
        onContinueFromEntry={onContinueFromEntry}
        onCreateSideTask={onCreateSideTask}
        onQuote={onQuote}
      />
    </div>
  )
}

export function ProductTaskApprovalCard({
  approval,
  responding,
  onRespondToAction,
  onRespondToQuestions,
}: {
  approval: NonNullable<ProductTaskRuntime['pendingApproval']>
  responding: boolean
  onRespondToAction: (allowed: boolean) => void
  onRespondToQuestions: (answers: string[]) => void
}) {
  const questions = approval.questions ?? []
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [freeText, setFreeText] = useState<Record<number, string>>({})

  useEffect(() => {
    setSelected({})
    setFreeText({})
  }, [approval.requestId])

  if (approval.kind === 'action') {
    return (
      <div role="status" className="mx-auto mt-5 max-w-2xl rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-[var(--color-text-secondary)]">
        <p className="font-medium text-[var(--color-text-primary)]">任务需要你的确认后才能继续执行。</p>
        {approval.action ? (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 leading-6">
            <dt className="text-[var(--color-text-tertiary)]">将做什么</dt><dd>{approval.action.what}</dd>
            <dt className="text-[var(--color-text-tertiary)]">作用范围</dt><dd>{approval.action.scope}</dd>
            <dt className="text-[var(--color-text-tertiary)]">可能后果</dt><dd>{approval.action.consequence}</dd>
          </dl>
        ) : <p className="mt-1">这是一项越过当前任务边界的受限操作。</p>}
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={responding} onClick={() => onRespondToAction(true)} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">允许本次操作</button>
          <button type="button" disabled={responding} onClick={() => onRespondToAction(false)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50">拒绝</button>
        </div>
      </div>
    )
  }

  const answers = questions.map((_, index) => freeText[index]?.trim() || (selected[index] ?? []).join(', '))
  const complete = questions.length > 0 && answers.every(Boolean)

  return (
    <div role="status" className="mx-auto mt-5 max-w-2xl rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-[var(--color-text-secondary)]">
      <p className="font-medium text-[var(--color-text-primary)]">任务需要你补充信息</p>
      <div className="mt-3 space-y-4">
        {questions.map((question, index) => {
          const choices = selected[index] ?? []
          return (
            <fieldset key={`${approval.requestId}:${index}`}>
              {question.header ? <legend className="text-xs text-[var(--color-text-tertiary)]">{question.header}</legend> : null}
              <p className="mt-1 text-sm text-[var(--color-text-primary)]">{question.question}</p>
              {question.options?.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {question.options.map((option) => {
                    const active = choices.includes(option.label)
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={responding}
                        aria-pressed={active}
                        onClick={() => {
                          setSelected((current) => {
                            const currentChoices = current[index] ?? []
                            const nextChoices = question.multiSelect
                              ? (currentChoices.includes(option.label)
                                ? currentChoices.filter((choice) => choice !== option.label)
                                : [...currentChoices, option.label])
                              : (currentChoices[0] === option.label ? [] : [option.label])
                            return { ...current, [index]: nextChoices }
                          })
                          setFreeText((current) => ({ ...current, [index]: '' }))
                        }}
                        className={`rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-50 ${active ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]' : 'border-[var(--color-border)] text-[var(--color-text-secondary)]'}`}
                      >
                        <span>{option.label}</span>
                        {option.description ? <span className="ml-1 text-[var(--color-text-tertiary)]">{option.description}</span> : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <textarea
                aria-label={`回答：${question.question}`}
                value={freeText[index] ?? ''}
                disabled={responding}
                onChange={(event) => {
                  const value = event.target.value
                  setFreeText((current) => ({ ...current, [index]: value }))
                  if (value.trim()) setSelected((current) => ({ ...current, [index]: [] }))
                }}
                placeholder={question.options?.length ? '或输入其他回答…' : '输入你的回答…'}
                rows={2}
                className="mt-2 block w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]"
              />
            </fieldset>
          )
        })}
      </div>
      <button type="button" disabled={!complete || responding} onClick={() => onRespondToQuestions(answers)} className="mt-4 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">提交回答</button>
    </div>
  )
}

type ProductTaskPageProps = {
  taskId: string
  onReturnToTaskIndex?: () => void
  onOpenTask?: (task: ProductTaskRecord) => void
}

/**
 * The product-owned task surface. It consumes only ProductTask contracts;
 * Agent Core sessions and raw protocol messages stay behind the server adapter.
 */
export function ProductTaskPage({ taskId, onReturnToTaskIndex, onOpenTask }: ProductTaskPageProps) {
  const index = useProductTaskStore((state) => state.index)
  const isTaskIndexLoading = useProductTaskStore((state) => state.isLoading)
  const indexError = useProductTaskStore((state) => state.error)
  const refreshTasks = useProductTaskStore((state) => state.refresh)
  const archiveTask = useProductTaskStore((state) => state.archiveTask)
  const restoreTask = useProductTaskStore((state) => state.restoreTask)
  const mutateTaskDeletion = useProductTaskStore((state) => state.mutateTaskDeletion)
  const recoverTaskRun = useProductTaskStore((state) => state.recoverTaskRun)
  const pinTask = useProductTaskStore((state) => state.pinTask)
  const unpinTask = useProductTaskStore((state) => state.unpinTask)
  const continueTask = useProductTaskStore((state) => state.continueTask)
  const mutations = useProductTaskStore((state) => state.mutations)
  const runtime = useProductTaskRuntimeStore((state) => state.tasks[taskId])
  const connectTask = useProductTaskRuntimeStore((state) => state.connectTask)
  const forgetRuntimeTask = useProductTaskRuntimeStore((state) => state.forgetTask)
  const sendText = useProductTaskRuntimeStore((state) => state.sendText)
  const sendMessage = useProductTaskRuntimeStore((state) => state.sendMessage)
  const stopTask = useProductTaskRuntimeStore((state) => state.stopTask)
  const editQueuedInput = useProductTaskRuntimeStore((state) => state.editQueuedInput)
  const deleteQueuedInput = useProductTaskRuntimeStore((state) => state.deleteQueuedInput)
  const reorderQueuedInputs = useProductTaskRuntimeStore((state) => state.reorderQueuedInputs)
  const steerQueuedInput = useProductTaskRuntimeStore((state) => state.steerQueuedInput)
  const resumeQueue = useProductTaskRuntimeStore((state) => state.resumeQueue)
  const respondToApproval = useProductTaskRuntimeStore((state) => state.respondToApproval)
  const respondToQuestions = useProductTaskRuntimeStore((state) => state.respondToQuestions)
  const refreshThread = useProductTaskRuntimeStore((state) => state.refreshThread)
  const createSideTask = useProductSideTaskStore((state) => state.createSideTask)
  const openSideTaskPanel = useProductSideTaskStore((state) => state.openSideTaskPanel)
  const forgetSideTasks = useProductSideTaskStore((state) => state.forgetTask)
  const sideTaskMutations = useProductSideTaskStore((state) => state.mutations)
  const workspace = useProductTaskWorkspaceStore((state) => state.byTaskId[taskId])
  const openWorkspacePanel = useProductTaskWorkspaceStore((state) => state.openPanel)
  const closeWorkspacePanel = useProductTaskWorkspaceStore((state) => state.closePanel)
  const forgetWorkspace = useProductTaskWorkspaceStore((state) => state.forgetTask)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const openTab = useTabStore((state) => state.openTab)
  const openProductTaskTab = useTabStore((state) => state.openProductTaskTab)
  const closeTab = useTabStore((state) => state.closeTab)
  const [draft, setDraft] = useState('')
  const [referenceEntryIds, setReferenceEntryIds] = useState<string[]>([])
  const [discoverableSkills, setDiscoverableSkills] = useState<ProductTaskSkillCommand[] | null>(null)
  const [discoverableAgents, setDiscoverableAgents] = useState<ProductTaskAgentCommand[] | null>(null)
  const [commandDiscoveryWorkDir, setCommandDiscoveryWorkDir] = useState<string | null>(null)
  const [skillDiscoveryError, setSkillDiscoveryError] = useState<string | null>(null)
  const [agentDiscoveryError, setAgentDiscoveryError] = useState<string | null>(null)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ProductTaskAttachmentDraft[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [threadActionError, setThreadActionError] = useState<string | null>(null)
  const [queueEditingId, setQueueEditingId] = useState<string | null>(null)
  const [queueEditingText, setQueueEditingText] = useState('')
  const [queueActionId, setQueueActionId] = useState<string | null>(null)
  const [queueActionError, setQueueActionError] = useState<string | null>(null)
  const [deletionDialog, setDeletionDialog] = useState<'prepare' | 'commit' | null>(null)
  const [deletionError, setDeletionError] = useState<string | null>(null)
  const composingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const missingTaskRefreshAttemptRef = useRef<string | null>(null)
  const isRunOpen = workspace?.runOpen ?? false
  const isReviewOpen = workspace?.reviewOpen ?? false
  const isTerminalOpen = workspace?.terminalOpen ?? false
  const isBrowserOpen = workspace?.browserOpen ?? false
  const isPreviewOpen = workspace?.previewOpen ?? false
  const activeRightDockPanel = workspace?.activePanel ?? null
  const activeBrowserPreviewMode = workspace?.activeBrowserPreviewMode ?? null
  const isRunActive = activeRightDockPanel === 'run'
  const isReviewActive = activeRightDockPanel === 'review'
  const isBrowserPreviewActive = activeRightDockPanel === 'browser-preview'

  const task = useMemo(
    () => index.tasks.find((candidate) => candidate.id === taskId) ?? null,
    [index.tasks, taskId],
  )
  const workspaceAvailable = task?.workspace_capability?.available === true
  const desktopCapabilities = getDesktopHost().capabilities
  const browserAvailable = desktopCapabilities.previewWebview
  const previewAvailable = workspaceAvailable && desktopCapabilities.previewWebview
  const terminalAvailable = workspaceAvailable && desktopCapabilities.terminal
  const normalizedWorkDir = workspaceAvailable ? task?.workDir.trim() ?? '' : ''
  const isSlashInput = draft.startsWith('/')
  const commandQuery = slashQuery(draft)
  const resolvedTaskId = task?.id

  useEffect(() => {
    if (task) {
      missingTaskRefreshAttemptRef.current = null
      return
    }
    if (!isTaskIndexLoading && missingTaskRefreshAttemptRef.current !== taskId) {
      missingTaskRefreshAttemptRef.current = taskId
      void refreshTasks()
    }
  }, [isTaskIndexLoading, refreshTasks, task, taskId])

  useEffect(() => {
    if (!resolvedTaskId) return
    void connectTask(resolvedTaskId)
  }, [connectTask, resolvedTaskId])

  useEffect(() => {
    if (!resolvedTaskId) return
    const compacting = (runtime?.contextCompactions ?? []).some(item => item.phase === 'started')
    if (runtime?.pendingApproval || runtime?.queuedInputs.length || compacting) openWorkspacePanel(resolvedTaskId, 'run', true)
  }, [openWorkspacePanel, resolvedTaskId, runtime?.contextCompactions, runtime?.pendingApproval, runtime?.queuedInputs.length])

  useEffect(() => {
    if (!isSlashInput) {
      setDiscoverableSkills(null)
      setDiscoverableAgents(null)
      setCommandDiscoveryWorkDir(null)
      setSkillDiscoveryError(null)
      setAgentDiscoveryError(null)
      return
    }
    if (!normalizedWorkDir) {
      setDiscoverableSkills([])
      setDiscoverableAgents([])
      setCommandDiscoveryWorkDir('')
      setSkillDiscoveryError(null)
      setAgentDiscoveryError(null)
      return
    }

    let cancelled = false
    setDiscoverableSkills(null)
    setDiscoverableAgents(null)
    setCommandDiscoveryWorkDir(normalizedWorkDir)
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
  const matchingCommands = useMemo<ProductTaskComposerSlashCommand[]>(() => {
    if (commandQuery === null) return []
    return taskComposerCommands.map((command) => ({
      ...command,
      key: `command:${command.runtimeName ?? command.name}:${command.name}`,
    })).filter((command) => (
      command.name.toLocaleLowerCase().startsWith(commandQuery)
    ))
  }, [commandQuery, taskComposerCommands])
  const hasCommandDiscoveryForCurrentWorkDir = commandDiscoveryWorkDir === normalizedWorkDir
  const visibleCommands = hasCommandDiscoveryForCurrentWorkDir ? matchingCommands : []
  const hasPendingCommandDiscovery = discoverableSkills === null || discoverableAgents === null
  const visibleCommandDiscoveryError = hasCommandDiscoveryForCurrentWorkDir
    ? visibleCommands.length === 0
      ? [skillDiscoveryError, agentDiscoveryError].filter(Boolean).join('；') || null
      : null
    : null
  const isCommandDiscoveryLoading = Boolean(normalizedWorkDir) && (
    !hasCommandDiscoveryForCurrentWorkDir || (
      hasPendingCommandDiscovery && visibleCommands.length === 0 && visibleCommandDiscoveryError === null
    )
  )

  const returnToTaskIndex = () => {
    if (onReturnToTaskIndex) {
      onReturnToTaskIndex()
      return
    }
    openTab(PRODUCT_TASKS_TAB_ID, '任务中心', 'product-tasks')
  }
  const returnLabel = onReturnToTaskIndex ? '关闭窗口' : '返回任务'

  const forgetTaskView = () => {
    forgetRuntimeTask(taskId)
    forgetSideTasks(taskId)
    forgetWorkspace(taskId)
  }

  const finishDeletedTask = () => {
    forgetTaskView()
    returnToTaskIndex()
    closeTab(`${PRODUCT_TASK_TAB_PREFIX}${taskId}`)
  }

  const dismissMissingTask = () => {
    forgetTaskView()
    returnToTaskIndex()
    closeTab(`${PRODUCT_TASK_TAB_PREFIX}${taskId}`)
  }

  const refreshMissingTask = () => {
    missingTaskRefreshAttemptRef.current = taskId
    void refreshTasks()
  }

  const prepareTaskDeletion = async () => {
    try {
      setDeletionError(null)
      const next = await mutateTaskDeletion(taskId, 'begin')
      if (next.lifecycle !== 'deleting') throw new Error('DELETE_PREPARE_INCOMPLETE')
      setDeletionDialog('commit')
    } catch {
      setDeletionError('删除准备没有完成。请先处理仍在运行、排队或关联的任务，再重试。')
    }
  }

  const cancelTaskDeletion = async () => {
    try {
      setDeletionError(null)
      await mutateTaskDeletion(taskId, 'cancel')
      setDeletionDialog(null)
    } catch {
      setDeletionError('暂时无法取消删除，请刷新任务状态后重试。')
    }
  }

  const retryTaskDeletion = async () => {
    try {
      setDeletionError(null)
      const next = await mutateTaskDeletion(taskId, 'retry')
      if (next.lifecycle === 'deleted') {
        setDeletionDialog(null)
        finishDeletedTask()
      } else if (next.lifecycle === 'deleting') {
        setDeletionDialog('commit')
      } else {
        setDeletionError('仍有任务数据未能安全清理，请稍后再次重试。')
      }
    } catch {
      setDeletionError('暂时无法继续清理任务数据，请稍后重试。')
    }
  }

  const commitTaskDeletion = async () => {
    try {
      setDeletionError(null)
      const committed = await mutateTaskDeletion(taskId, 'commit_purge')
      if (committed.lifecycle !== 'purge_committed') throw new Error('DELETE_COMMIT_INCOMPLETE')
      const deleted = await mutateTaskDeletion(taskId, 'retry')
      if (deleted.lifecycle !== 'deleted') {
        setDeletionDialog(null)
        setDeletionError('任务已进入清理阶段，但仍有数据未清理完成。请点击“继续清理”。')
        return
      }
      setDeletionDialog(null)
      finishDeletedTask()
    } catch {
      setDeletionDialog(null)
      setDeletionError('永久删除尚未完成。已提交的清理会保留进度，请点击“继续清理”。')
    }
  }

  const submit = async () => {
    if (isSubmitting) return
    if (!canSendProductTaskMessage(draft, attachments)) {
      setValidationMessage('请输入任务内容，或添加不超过 4 个附件。')
      return
    }

    const message = resolveTaskComposerRuntimeCommand(draft, taskComposerCommands)
    setIsSubmitting(true)
    let accepted = false
    try {
      accepted = await (attachments.length > 0
        ? referenceEntryIds.length
          ? sendMessage(taskId, message, attachments.map(({ id: _id, ...attachment }) => attachment), referenceEntryIds)
          : sendMessage(taskId, message, attachments.map(({ id: _id, ...attachment }) => attachment))
        : referenceEntryIds.length
          ? sendText(taskId, message, referenceEntryIds)
          : sendText(taskId, message))
    } finally {
      setIsSubmitting(false)
    }
    if (!accepted) {
      setValidationMessage('暂时无法发送这条内容，请检查后重试。')
      return
    }

    setDraft('')
    setReferenceEntryIds([])
    setAttachments([])
    setAttachmentMessage(null)
    setValidationMessage(null)
  }

  const chooseAttachments = () => fileInputRef.current?.click()

  const addAttachments = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return

    const availableSlots = MAX_PRODUCT_TASK_ATTACHMENT_COUNT - attachments.length
    if (availableSlots <= 0) {
      setAttachmentMessage(`一次最多添加 ${MAX_PRODUCT_TASK_ATTACHMENT_COUNT} 个附件。`)
      return
    }

    const { attachments: accepted, rejectedCount: rejected } = await readProductTaskAttachmentDrafts(files, availableSlots)

    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted])
    if (rejected > 0 || files.length > availableSlots) {
      setAttachmentMessage(`部分附件未添加。支持常见图片、视频和文档；普通附件单个不超过 ${MAX_PRODUCT_TASK_ATTACHMENT_BYTES / 1024 / 1024} MB，视频不超过 32 MB，总计不超过 64 MB。`)
    } else {
      setAttachmentMessage(null)
    }
  }

  const addBrowserPreviewCapture = ({
    mode,
    dataUrl,
  }: ProductTaskBrowserPreviewCapture) => {
    const attachment = createProductTaskPreviewImageDraft(
      dataUrl,
      mode === 'browser' ? '浏览器截图.png' : '预览截图.png',
    )
    if (!attachment) {
      setAttachmentMessage('当前截图无法作为图片附件添加。')
      return
    }

    const validation = validateProductTaskAttachments([...attachments, attachment])
    if (!validation.ok) {
      setAttachmentMessage(validation.message)
      return
    }

    setAttachments([...attachments, attachment])
    setAttachmentMessage(null)
    setValidationMessage(null)
  }

  const submitPreviewSelection = async (
    intent: ProductTaskPreviewSelectionIntent,
  ): Promise<boolean> => {
    const screenshotDataUrl = intent.selection.screenshot?.dataUrl
    const screenshot = screenshotDataUrl
      ? createProductTaskPreviewImageDraft(screenshotDataUrl, '预览元素证据.png')
      : null
    const evidenceAttachments = screenshot ? [screenshot] : []
    const validation = validateProductTaskAttachments(evidenceAttachments)
    if (!validation.ok) {
      setAttachmentMessage(validation.message)
      return false
    }

    const accepted = evidenceAttachments.length
      ? await sendMessage(
          taskId,
          buildProductTaskPreviewIntentText(intent),
          evidenceAttachments.map(({ id: _id, ...attachment }) => attachment),
        )
      : await sendText(taskId, buildProductTaskPreviewIntentText(intent))
    if (!accepted) return false
    setAttachmentMessage(null)
    setValidationMessage(null)
    openWorkspacePanel(taskId, 'review', true)
    return true
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!shouldSubmitOnEnter(event, chatSendBehavior)) return
    event.preventDefault()
    void submit()
  }

  if (!task) {
    return (
      <main className="flex h-full min-h-0 flex-col items-center justify-center gap-4 bg-[var(--color-app-main)] px-6" data-testid="product-task-page">
        {isTaskIndexLoading ? (
          <p role="status" className="text-sm text-[var(--color-text-secondary)]">正在读取任务…</p>
        ) : (
          <>
            <p className="max-w-md text-center text-sm leading-6 text-[var(--color-text-secondary)]">
              {indexError ? '任务信息暂时无法读取。' : '这个任务已不存在，或暂时无法访问。'}
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={refreshMissingTask} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">重新读取</button>
              <button type="button" onClick={dismissMissingTask} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white">{onReturnToTaskIndex ? '关闭窗口' : '返回任务中心'}</button>
            </div>
          </>
        )}
      </main>
    )
  }

  const isArchived = task.lifecycle === 'archived'
  const isTaskReadOnly = task.lifecycle !== 'active'
  const pinAction = task.pinnedAt ? 'unpin' : 'pin'
  const lifecycleAction = isArchived ? 'restore' : 'archive'
  const canPinTask = task.actions.includes(pinAction)
  const hasActiveRun = runtime?.runState === 'working'
    || runtime?.runState === 'awaiting_approval'
    || runtime?.pendingApproval != null
  const mutateQueueItem = async (queueItemId: string, action: () => Promise<boolean>) => {
    if (queueActionId) return false
    setQueueActionId(queueItemId)
    setQueueActionError(null)
    try {
      const accepted = await action()
      if (!accepted) setQueueActionError('队列已经变化，请重试。')
      return accepted
    } finally {
      setQueueActionId(null)
    }
  }
  const saveQueuedInput = async (queueItemId: string) => {
    const text = queueEditingText.trim()
    if (!text) {
      setQueueActionError('队列内容不能为空。')
      return
    }
    if (await mutateQueueItem(queueItemId, () => editQueuedInput(taskId, queueItemId, text))) {
      setQueueEditingId(null)
      setQueueEditingText('')
    }
  }
  const moveQueuedInput = async (queueItemId: string, direction: -1 | 1) => {
    const queueItemIds = (runtime?.queuedInputs ?? [])
      .filter(item => item.state === 'queued' && !item.targetRunId)
      .map(item => item.id)
    const index = queueItemIds.indexOf(queueItemId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= queueItemIds.length) return
    ;[queueItemIds[index], queueItemIds[target]] = [queueItemIds[target]!, queueItemIds[index]!]
    await mutateQueueItem(queueItemId, () => reorderQueuedInputs(taskId, queueItemIds))
  }
  const taskControlsConnected = runtime?.connectionState === 'connected'
  const canChangeLifecycle = task.actions.includes(lifecycleAction) && (isArchived || !hasActiveRun)
  const isTaskMutationPending = mutations[`${taskId}:archive`] || mutations[`${taskId}:restore`]
  const isPinMutationPending = mutations[`${taskId}:${pinAction}`]
  const isContinuationPending = mutations[`${taskId}:continue`] === true
  const isRecoveryPending = mutations[`${taskId}:recover`] === true
  const isSideTaskCreationPending = sideTaskMutations[
    productSideTaskMutationKey(taskId, 'new', 'create')
  ] === true

  const closeReviewDock = () => {
    closeWorkspacePanel(task.id, 'review')
  }

  const closeRunDock = () => {
    closeWorkspacePanel(task.id, 'run')
  }

  const closeTerminalDock = () => {
    closeWorkspacePanel(task.id, 'terminal')
  }

  const openReviewDock = () => {
    openWorkspacePanel(task.id, 'review', workspaceAvailable)
  }

  const openRunDock = () => {
    openWorkspacePanel(task.id, 'run', true)
  }

  const openTerminalDock = () => {
    openWorkspacePanel(task.id, 'terminal', workspaceAvailable)
  }

  const toggleReviewDock = () => {
    if (isReviewOpen && isReviewActive) {
      closeReviewDock()
      return
    }
    openReviewDock()
  }

  const toggleRunDock = () => {
    if (isRunOpen && isRunActive) {
      closeRunDock()
      return
    }
    openRunDock()
  }

  const toggleTerminalDock = () => {
    if (isTerminalOpen) {
      closeTerminalDock()
      return
    }
    openTerminalDock()
  }

  const closeBrowserPreviewMode = (mode: ProductTaskBrowserPreviewMode) => {
    closeWorkspacePanel(task.id, mode)
  }

  const openBrowserPreviewMode = (mode: ProductTaskBrowserPreviewMode) => {
    openWorkspacePanel(task.id, mode, mode === 'browser' ? browserAvailable : previewAvailable)
  }

  const toggleBrowserPreviewMode = (mode: ProductTaskBrowserPreviewMode) => {
    const isOpen = mode === 'browser' ? isBrowserOpen : isPreviewOpen
    const isActive = isBrowserPreviewActive && activeBrowserPreviewMode === mode
    if (isOpen && isActive) {
      closeBrowserPreviewMode(mode)
      return
    }
    openBrowserPreviewMode(mode)
  }

  const continueFromEntry = async (
    sourceEntryId: string,
    target: 'current_workspace' | 'new_worktree',
  ) => {
    try {
      setThreadActionError(null)
      const nextTask = await continueTask(taskId, { sourceEntryId, target })
      if (onOpenTask) onOpenTask(nextTask)
      else openProductTaskTab(nextTask.id, nextTask.title)
    } catch {
      setThreadActionError('暂时无法从这条记录继续任务，请稍后重试。')
    }
  }

  const createSideTaskFromEntry = async (sourceEntryId: string) => {
    try {
      setThreadActionError(null)
      const sideTask = await createSideTask(taskId, { sourceEntryId })
      openSideTaskPanel(taskId, sideTask.id)
    } catch {
      setThreadActionError('暂时无法创建侧边任务，请稍后重试。')
    }
  }

  const quoteEntry = (entry: Extract<ProductTaskThreadEntry, { type: 'user_text' | 'assistant_text' }>) => {
    const quote = entry.text.split('\n').map((line) => `> ${line}`).join('\n')
    setDraft((current) => current ? `${current}\n\n${quote}\n\n` : `${quote}\n\n`)
    setReferenceEntryIds((current) => current.includes(entry.id) || current.length >= 8 ? current : [...current, entry.id])
    setValidationMessage(null)
  }

  const recoverFailedRun = async () => {
    try {
      setThreadActionError(null)
      await recoverTaskRun(taskId)
      await refreshThread(taskId)
    } catch {
      setThreadActionError('暂时无法恢复这次运行，请刷新后重试。')
    }
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-app-main)]" data-testid="product-task-page">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <button
          type="button"
          onClick={returnToTaskIndex}
          className="rounded-md px-2 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
        >
          {returnLabel}
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{task.title}</h1>
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">{workspaceAvailable ? task.workDir : '需先关联工作区'}</p>
        </div>
        <span className={`hidden rounded-full px-2.5 py-1 text-xs sm:inline ${runtime?.runState === 'awaiting_approval' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : runtime?.runState === 'working' ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]' : 'bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]'}`}>
          {runStateLabel(runtime?.runState ?? 'idle')}
        </span>
        {canPinTask ? (
          <button
            type="button"
            onClick={() => void (task.pinnedAt ? unpinTask(task.id) : pinTask(task.id))}
            disabled={isPinMutationPending === true}
            className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
          >
            {task.pinnedAt ? '取消置顶' : '置顶'}
          </button>
        ) : null}
        {canChangeLifecycle ? (
          <button
            type="button"
            onClick={() => void (isArchived ? restoreTask(task.id) : archiveTask(task.id))}
            disabled={isTaskMutationPending === true}
            className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50"
          >
            {isArchived ? '恢复' : '归档'}
          </button>
        ) : null}
        {isArchived ? (
          <button
            type="button"
            onClick={() => { setDeletionError(null); setDeletionDialog('prepare') }}
            disabled={mutations[`${taskId}:delete-begin`] === true}
            className="rounded-md border border-red-500/40 px-2.5 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:text-red-300"
          >
            删除任务
          </button>
        ) : null}
        {task.lifecycle === 'deleting' ? (
          <>
            <button type="button" onClick={() => void cancelTaskDeletion()} disabled={mutations[`${taskId}:delete-cancel`] === true} className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">取消删除</button>
            <button type="button" onClick={() => setDeletionDialog('commit')} className="rounded-md border border-red-500/40 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-300">继续删除</button>
          </>
        ) : null}
        {task.lifecycle === 'delete_failed_pre_purge' ? (
          <>
            <button type="button" onClick={() => void cancelTaskDeletion()} disabled={mutations[`${taskId}:delete-cancel`] === true} className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">取消删除</button>
            <button type="button" onClick={() => void retryTaskDeletion()} disabled={mutations[`${taskId}:delete-retry`] === true} className="rounded-md border border-red-500/40 px-2.5 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:text-red-300">重试删除准备</button>
          </>
        ) : null}
        {task.lifecycle === 'purge_committed' || task.lifecycle === 'delete_failed_post_purge' ? (
          <button type="button" onClick={() => void retryTaskDeletion()} disabled={mutations[`${taskId}:delete-retry`] === true} className="rounded-md border border-red-500/40 px-2.5 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:text-red-300">继续清理</button>
        ) : null}
        <button
          type="button"
          onClick={toggleRunDock}
          aria-pressed={isRunActive}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          运行
        </button>
        <button
          type="button"
          onClick={toggleReviewDock}
          disabled={!workspaceAvailable}
          aria-pressed={isReviewActive}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          审阅
        </button>
        <button
          type="button"
          onClick={() => toggleBrowserPreviewMode('browser')}
          disabled={!browserAvailable}
          aria-pressed={isBrowserPreviewActive && isBrowserOpen && activeBrowserPreviewMode === 'browser'}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          浏览器
        </button>
        <button
          type="button"
          onClick={() => toggleBrowserPreviewMode('preview')}
          disabled={!previewAvailable}
          aria-pressed={isBrowserPreviewActive && isPreviewOpen && activeBrowserPreviewMode === 'preview'}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          预览
        </button>
        <button
          type="button"
          onClick={toggleTerminalDock}
          disabled={!terminalAvailable}
          aria-pressed={isTerminalOpen}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          终端
        </button>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
            {runtime?.historyStatus === 'loading' && runtime.entries.length === 0 ? (
              <p role="status" className="py-12 text-center text-sm text-[var(--color-text-secondary)]">正在读取任务记录…</p>
            ) : null}

            {runtime?.historyStatus === 'error' && runtime.entries.length === 0 ? (
              <div className="mx-auto max-w-md rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-surface)] p-4 text-center">
                <p className="text-sm text-[var(--color-text-secondary)]">任务记录暂时无法读取。</p>
                <button type="button" onClick={() => void refreshThread(taskId)} className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">重新读取</button>
              </div>
            ) : null}

            {runtime && runtime.entries.length === 0 && runtime.historyStatus === 'ready' ? (
              <p className="py-12 text-center text-sm text-[var(--color-text-secondary)]">任务已创建。描述下一步希望完成的事情。</p>
            ) : null}

            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {runtime?.plan ? <ProductTaskPlanPanel plan={runtime.plan} /> : null}
              {runtime?.entries.map((entry) => (
                <ProductTaskThreadEntryView
                  key={entry.id}
                  entry={entry}
                  streaming={entry.id === runtime.streamingEntryId}
                  actionPending={isContinuationPending || isSideTaskCreationPending}
                  onContinueFromEntry={isTaskReadOnly ? undefined : (sourceEntryId, target) => {
                    void continueFromEntry(sourceEntryId, target)
                  }}
                  onCreateSideTask={isTaskReadOnly ? undefined : (sourceEntryId) => {
                    void createSideTaskFromEntry(sourceEntryId)
                  }}
                  onQuote={isTaskReadOnly ? undefined : quoteEntry}
                />
              ))}
            </div>

            {runtime?.activeActivity && runtime.activeActivity.phase !== 'completed' && runtime.activeActivity.phase !== 'failed' ? (
              <p role="status" className="mx-auto mt-5 max-w-4xl text-center text-xs text-[var(--color-text-secondary)]">
                {productTaskActivityDisplayLabel(
                  runtime.activeActivity.kind,
                  runtime.activeActivity.phase,
                  runtime.activeActivity.summary,
                )}…
              </p>
            ) : null}

            <RecruitingActionApproval taskId={taskId} />

            {runtime?.recoveryRequired ? (
              <div role="alert" className="mx-auto mt-5 max-w-2xl rounded-xl border border-amber-500/30 bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
                <p className="font-medium text-[var(--color-text-primary)]">{runtime.error ? PRODUCT_TASK_SAFE_ERROR_LABEL[runtime.error.code] : '上次运行未能确认结果。'}</p>
                <p className="mt-2">恢复会用新的执行代次重新运行这条消息，可能重复外部操作，请确认后继续。</p>
                <button type="button" disabled={isRecoveryPending} onClick={() => { void recoverFailedRun() }} className="mt-3 rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {isRecoveryPending ? '正在恢复…' : '恢复失败任务'}
                </button>
              </div>
            ) : runtime?.error ? (
              <div role="alert" className="mx-auto mt-5 max-w-2xl rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-error)]">
                {PRODUCT_TASK_SAFE_ERROR_LABEL[runtime.error.code]}
              </div>
            ) : null}
            {threadActionError ? (
              <div role="alert" className="mx-auto mt-5 max-w-2xl rounded-xl border border-[var(--color-error)]/30 bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-error)]">
                {threadActionError}
              </div>
            ) : null}
          </div>

          <SideTaskPanel parentTask={task} />

          <form className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:px-6" onSubmit={onSubmit}>
            {isTaskReadOnly ? (
              <p className="rounded-lg bg-[var(--color-surface-container)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">
                {isArchived ? '此任务已归档。恢复后可以继续处理。' : '此任务正在删除，不能再提交新内容。'}
              </p>
            ) : (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => { void addAttachments(event) }}
                />
                <textarea
                  aria-label="任务输入"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    if (validationMessage) setValidationMessage(null)
                  }}
                  onKeyDown={onKeyDown}
                  onCompositionStart={() => { composingRef.current = true }}
                  onCompositionEnd={() => { composingRef.current = false }}
                  placeholder="继续说明这项任务需要完成什么…"
                  rows={3}
                  className="block w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-app-main)] px-3 py-2.5 text-sm leading-6 text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-primary)]"
                />
                {commandQuery !== null ? (
                  <ProductTaskComposerSlashPicker
                    workDir={normalizedWorkDir}
                    commands={visibleCommands}
                    isLoading={isCommandDiscoveryLoading}
                    error={visibleCommandDiscoveryError}
                    onSelect={(command) => {
                      setDraft((value) => insertSlashCommand(value, command.name))
                      setValidationMessage(null)
                    }}
                  />
                ) : null}
                {attachments.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2" aria-label="待发送附件">
                    {attachments.map((attachment) => (
                      <span key={attachment.id} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">
                        <span className="truncate">{attachment.name || '附件'}</span>
                        <button type="button" aria-label={`移除附件 ${attachment.name || '附件'}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} className="rounded px-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)]">×</button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {referenceEntryIds.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2" aria-label="待发送引用">
                    {referenceEntryIds.map((entryId, index) => (
                      <span key={entryId} className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container)] px-2 py-1 text-xs text-[var(--color-text-secondary)]">
                        <span>引用 {index + 1}</span>
                        <button type="button" aria-label={`移除引用 ${index + 1}`} onClick={() => setReferenceEntryIds((current) => current.filter((id) => id !== entryId))} className="rounded px-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)]">×</button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {validationMessage ? <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{validationMessage}</p> : null}
                {attachmentMessage ? <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{attachmentMessage}</p> : null}
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <button type="button" onClick={chooseAttachments} disabled={attachments.length >= MAX_PRODUCT_TASK_ATTACHMENT_COUNT} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">添加附件</button>
                    <VoiceInputControl
                      disabled={isTaskReadOnly}
                      consumer={{ kind: 'composer', id: taskId }}
                      onTranscript={(text) => {
                        setDraft((current) => current ? `${current}\n${text}` : text)
                        setValidationMessage(null)
                      }}
                    />
                    <p className="truncate text-xs text-[var(--color-text-tertiary)]">按当前发送快捷键提交，Shift + Enter 换行。</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {hasActiveRun ? (
                      <button type="button" disabled={!taskControlsConnected} onClick={() => stopTask(taskId)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50">停止</button>
                    ) : null}
                    <button type="submit" disabled={isSubmitting} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{isSubmitting ? '发送中…' : hasActiveRun ? '加入队列' : '发送'}</button>
                  </div>
                </div>
              </>
            )}
          </form>
        </section>

        {activeRightDockPanel ? (
          <aside className="flex min-h-0 w-[min(34rem,46vw)] min-w-[22rem] flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="product-task-dock-rail">
            {isRunOpen ? (
              <div
                data-testid="product-task-dock-panel-run"
                data-active={isRunActive ? 'true' : 'false'}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${isRunActive ? 'flex' : 'hidden'}`}
              >
                <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">运行检查器</h2>
                    <p className="text-xs text-[var(--color-text-tertiary)]">{runStateLabel(runtime?.runState ?? 'idle')}</p>
                  </div>
                  <button type="button" onClick={closeRunDock} aria-label="关闭运行检查器" className="rounded-md px-2 py-1 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">关闭</button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <ProductTaskRunPanel activities={runtime?.runActivities ?? []} compactions={runtime?.contextCompactions ?? []} />
                  {runtime?.pendingApproval ? (
                    <ProductTaskApprovalCard
                      approval={runtime.pendingApproval}
                      responding={runtime.approvalResponsePending || !taskControlsConnected}
                      onRespondToAction={(allowed) => { respondToApproval(taskId, allowed) }}
                      onRespondToQuestions={(answers) => { respondToQuestions(taskId, answers) }}
                    />
                  ) : null}
                  {runtime?.queuedInputs.length ? (
                    <section className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-app-main)] p-3" aria-label="待处理输入队列">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-xs font-medium text-[var(--color-text-secondary)]">待处理输入</h3>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-[var(--color-text-tertiary)]">{runtime.queuedInputs.length} 条</span>
                          {runtime.runState === 'idle' && runtime.queuedInputs.some(item => item.state === 'queued') ? (
                            <button type="button" onClick={() => { void resumeQueue(taskId) }} className="rounded border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">继续队列</button>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        {runtime.queuedInputs.map((item) => {
                          const editable = item.state === 'queued' && !item.targetRunId
                          const editableQueue = runtime.queuedInputs.filter(candidate => candidate.state === 'queued' && !candidate.targetRunId)
                          const editableIndex = editableQueue.findIndex(candidate => candidate.id === item.id)
                          const busy = queueActionId === item.id
                          return (
                            <div key={item.id} className="rounded-lg border border-[var(--color-border)]/70 p-2 text-xs text-[var(--color-text-secondary)]">
                              <div className="flex items-start gap-2">
                                <span className={`shrink-0 rounded px-1.5 py-0.5 ${item.state === 'failed' ? 'bg-[var(--color-error)]/10 text-[var(--color-error)]' : 'bg-[var(--color-primary)]/10 text-[var(--color-primary)]'}`}>{item.state === 'failed' ? '无法继续' : item.targetRunId ? '正在发送' : item.attachmentCount > 0 ? '下一轮' : '等待安全点'}</span>
                                {queueEditingId === item.id ? (
                                  <textarea aria-label="编辑队列输入" value={queueEditingText} onChange={event => setQueueEditingText(event.target.value)} maxLength={32_000} rows={3} className="min-w-0 flex-1 resize-y rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-text-primary)] outline-none focus:border-[var(--color-primary)]" />
                                ) : <span className="min-w-0 flex-1 break-words">{item.text}</span>}
                                {item.attachmentCount > 0 ? <span className="shrink-0 text-[var(--color-text-tertiary)]">{item.attachmentCount} 个附件</span> : null}
                              </div>
                              {editable ? (
                                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                                  {queueEditingId === item.id ? (
                                    <>
                                      <button type="button" disabled={busy} onClick={() => { void saveQueuedInput(item.id) }} className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50">保存</button>
                                      <button type="button" disabled={busy} onClick={() => { setQueueEditingId(null); setQueueEditingText('') }} className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50">取消</button>
                                    </>
                                  ) : (
                                    <>
                                      <button type="button" aria-label={`编辑队列输入：${item.text}`} disabled={busy} onClick={() => { setQueueEditingId(item.id); setQueueEditingText(item.text); setQueueActionError(null) }} className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50">编辑</button>
                                      <button type="button" aria-label="上移队列输入" disabled={busy || editableIndex <= 0} onClick={() => { void moveQueuedInput(item.id, -1) }} className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50">上移</button>
                                      <button type="button" aria-label="下移队列输入" disabled={busy || editableIndex < 0 || editableIndex >= editableQueue.length - 1} onClick={() => { void moveQueuedInput(item.id, 1) }} className="rounded border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50">下移</button>
                                      {hasActiveRun && item.attachmentCount === 0 ? <button type="button" aria-label={`立即发送队列输入：${item.text}`} disabled={busy} onClick={() => { void mutateQueueItem(item.id, () => steerQueuedInput(taskId, item.id)) }} className="rounded border border-[var(--color-primary)] px-2 py-1 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 disabled:opacity-50">立即发送</button> : null}
                                      <button type="button" aria-label={`删除队列输入：${item.text}`} disabled={busy} onClick={() => { void mutateQueueItem(item.id, () => deleteQueuedInput(taskId, item.id)) }} className="rounded border border-[var(--color-error)]/40 px-2 py-1 text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-50">删除</button>
                                    </>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          )
                        })}
                        {queueActionError ? <p role="alert" className="text-xs text-[var(--color-error)]">{queueActionError}</p> : null}
                      </div>
                    </section>
                  ) : null}
                  {!runtime?.pendingApproval && !runtime?.queuedInputs.length && !runtime?.runActivities.length && !(runtime?.contextCompactions ?? []).length ? (
                    <p className="py-8 text-center text-sm text-[var(--color-text-tertiary)]">当前没有运行中的步骤。</p>
                  ) : null}
                  {hasActiveRun ? (
                    <button type="button" disabled={!taskControlsConnected} onClick={() => stopTask(taskId)} className="mt-4 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50">停止当前运行</button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {workspaceAvailable && isReviewOpen ? (
              <div
                data-testid="product-task-dock-panel-review"
                data-active={isReviewActive ? 'true' : 'false'}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${isReviewActive ? 'flex' : 'hidden'}`}
              >
                <ProductTaskReviewDock taskId={task.id} onClose={closeReviewDock} />
              </div>
            ) : null}
            {isBrowserPreviewActive && (isBrowserOpen || (workspaceAvailable && isPreviewOpen)) ? (
              <div
                data-testid="product-task-dock-panel-browser-preview"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <ProductTaskBrowserPreviewDock
                  taskId={task.id}
                  browserOpen={isBrowserOpen}
                  previewOpen={isPreviewOpen}
                  activeMode={activeBrowserPreviewMode}
                  workspaceAvailable={workspaceAvailable}
                  onClose={closeBrowserPreviewMode}
                  onCapture={addBrowserPreviewCapture}
                  onSubmitSelection={submitPreviewSelection}
                />
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
      {terminalAvailable && isTerminalOpen ? (
        <section
          data-testid="product-task-terminal-dock"
          data-active="true"
          className="flex h-[min(24rem,42vh)] min-h-48 shrink-0 flex-col overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <ProductTaskTerminalDock
            taskId={task.id}
            workDir={normalizedWorkDir}
            workspaceAvailable={workspaceAvailable}
            active
            onClose={closeTerminalDock}
            testId={`product-task-terminal-${task.id}`}
          />
        </section>
      ) : null}
      {deletionError ? <p role="alert" className="mx-4 mb-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-300">{deletionError}</p> : null}
      <ConfirmDialog
        open={deletionDialog === 'prepare'}
        onClose={() => setDeletionDialog(null)}
        onConfirm={prepareTaskDeletion}
        title="准备删除任务"
        body="先检查并冻结这项任务的运行、队列、定时任务和浏览器操作。工作区及其中的文件不会被删除。"
        confirmLabel="准备删除"
        cancelLabel="取消"
        loading={mutations[`${taskId}:delete-begin`] === true}
      />
      <ConfirmDialog
        open={deletionDialog === 'commit'}
        onClose={() => setDeletionDialog(null)}
        onConfirm={commitTaskDeletion}
        title="永久删除任务记录"
        body="这是第二次确认。任务对话、附件副本、运行记录、私有绑定和关联状态将被永久清理；工作区文件仍会保留。"
        confirmLabel="永久删除"
        cancelLabel="暂不删除"
        loading={mutations[`${taskId}:delete-commit_purge`] === true || mutations[`${taskId}:delete-retry`] === true}
      />
    </main>
  )
}

function ProductTaskComposerSlashPicker({
  workDir,
  commands,
  isLoading,
  error,
  onSelect,
}: {
  workDir: string
  commands: ProductTaskComposerSlashCommand[]
  isLoading: boolean
  error: string | null
  onSelect: (command: ProductTaskComposerSlashCommand) => void
}) {
  if (!workDir) {
    return <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">当前任务没有可用工作目录，无法读取可用命令。</p>
  }

  if (isLoading) {
    return <p role="status" className="mt-2 text-xs text-[var(--color-text-tertiary)]">正在读取可用命令…</p>
  }

  if (error) {
    return <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">无法读取可用命令：{error}</p>
  }

  if (commands.length === 0) {
    return <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">当前工作目录没有匹配的可用命令。</p>
  }

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-app-main)]" aria-label="可用命令">
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
