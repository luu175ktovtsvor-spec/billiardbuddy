import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer'
import { useSettingsStore } from '../../stores/settingsStore'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../../stores/tabStore'
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
  useProductTaskBrowserPreviewStore,
  type ProductTaskBrowserPreviewMode,
} from '../stores/productTaskBrowserPreviewStore'
import {
  ProductTaskBrowserPreviewDock,
  type ProductTaskBrowserPreviewCapture,
} from './ProductTaskBrowserPreviewDock'
import { ProductTaskMediaDock } from './ProductTaskMediaDock'
import { ProductTaskReviewDock } from './ProductTaskReviewDock'
import { ProductTaskTerminalDock } from './ProductTaskTerminalDock'
import {
  ProductTaskRunPanel,
  productTaskActivityDisplayLabel,
  productTaskActivityLabel,
} from './ProductTaskRunPanel'
import { SideTaskPanel } from './SideTaskPanel'
import { VoiceInputControl } from './VoiceInputControl'
import {
  MAX_PRODUCT_TASK_ATTACHMENT_BYTES,
  MAX_PRODUCT_TASK_ATTACHMENT_COUNT,
  createProductTaskPreviewImageDraft,
  readProductTaskAttachmentDrafts,
  validateProductTaskAttachments,
  type ProductTaskAttachmentDraft,
} from '../taskAttachments'

const COMPUTER_USE_TIER_LABEL = {
  read: '查看',
  click: '点击操作',
  full: '完整操作',
} as const

const COMPUTER_USE_CAPABILITY_LABEL = {
  clipboard_read: '读取剪贴板',
  clipboard_write: '写入剪贴板',
  system_key_combos: '使用系统快捷键',
} as const

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

type ProductTaskRightDockPanel = 'review' | 'media' | 'browser-preview'

type OpenProductTaskRightDockPanels = Record<ProductTaskRightDockPanel, boolean>

const PRODUCT_TASK_RIGHT_DOCK_PANEL_ORDER: readonly ProductTaskRightDockPanel[] = [
  'review',
  'media',
  'browser-preview',
]

function firstOpenRightDockPanel(
  openPanels: OpenProductTaskRightDockPanels,
): ProductTaskRightDockPanel | null {
  return PRODUCT_TASK_RIGHT_DOCK_PANEL_ORDER.find((panel) => openPanels[panel]) ?? null
}

function nextOpenRightDockPanel(
  closedPanel: ProductTaskRightDockPanel,
  openPanels: OpenProductTaskRightDockPanels,
): ProductTaskRightDockPanel | null {
  const index = PRODUCT_TASK_RIGHT_DOCK_PANEL_ORDER.indexOf(closedPanel)
  for (let offset = 1; offset < PRODUCT_TASK_RIGHT_DOCK_PANEL_ORDER.length; offset += 1) {
    const candidate = PRODUCT_TASK_RIGHT_DOCK_PANEL_ORDER[
      (index + offset) % PRODUCT_TASK_RIGHT_DOCK_PANEL_ORDER.length
    ]!
    if (openPanels[candidate]) return candidate
  }
  return null
}

function resolveActiveRightDockPanel(
  requestedPanel: ProductTaskRightDockPanel | null,
  openPanels: OpenProductTaskRightDockPanels,
): ProductTaskRightDockPanel | null {
  if (requestedPanel && openPanels[requestedPanel]) return requestedPanel
  return firstOpenRightDockPanel(openPanels)
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
}

function ProductTaskThreadEntryActions({
  entry,
  streaming,
  actionPending = false,
  onContinueFromEntry,
  onCreateSideTask,
}: ProductTaskThreadEntryViewProps) {
  if (
    streaming ||
    entry.type === 'activity' ||
    !/^thread_[a-f0-9]{20}$/.test(entry.id) ||
    (!onContinueFromEntry && !onCreateSideTask)
  ) {
    return null
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {onContinueFromEntry ? (
        <>
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onContinueFromEntry(entry.id, 'current_workspace')}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          >
            从此处继续
          </button>
          <button
            type="button"
            disabled={actionPending}
            onClick={() => onContinueFromEntry(entry.id, 'new_worktree')}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
          >
            在新工作树继续
          </button>
        </>
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
        />
      </div>
    )
  }

  return (
    <div className="max-w-3xl">
      <article className="rounded-2xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm leading-6 text-[var(--color-text-primary)]">
        <MarkdownRenderer content={entry.text} streaming={streaming} />
      </article>
      <ProductTaskThreadEntryActions
        entry={entry}
        streaming={streaming}
        actionPending={actionPending}
        onContinueFromEntry={onContinueFromEntry}
        onCreateSideTask={onCreateSideTask}
      />
    </div>
  )
}

export function ProductTaskApprovalCard({
  approval,
  responding,
  onRespondToAction,
  onRespondToQuestions,
  onRespondToComputerUse,
}: {
  approval: NonNullable<ProductTaskRuntime['pendingApproval']>
  responding: boolean
  onRespondToAction: (allowed: boolean) => void
  onRespondToQuestions: (answers: string[]) => void
  onRespondToComputerUse: (allowed: boolean) => void
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
        <p>任务需要你的确认后才能继续执行。</p>
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={responding} onClick={() => onRespondToAction(true)} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">允许本次操作</button>
          <button type="button" disabled={responding} onClick={() => onRespondToAction(false)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50">拒绝</button>
        </div>
      </div>
    )
  }

  if (approval.kind === 'computer_use') {
    const computerUse = approval.computerUse
    if (!computerUse) return null

    const systemPermissions = computerUse.systemPermissions
    return (
      <div data-testid="product-task-computer-use-approval" role="status" className="mx-auto mt-5 max-w-2xl rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-[var(--color-text-secondary)]">
        <p className="font-medium text-[var(--color-text-primary)]">需要允许本次 Computer Use</p>
        <p className="mt-1 leading-6">任务将在本次会话中使用电脑完成已请求的操作，不会获得持续授权。</p>
        {computerUse.apps.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs text-[var(--color-text-tertiary)]">请求使用的应用</p>
            <ul className="mt-1.5 space-y-1.5">
              {computerUse.apps.map((app, index) => (
                <li key={`${app.name}:${app.tier}:${index}`} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs">
                  <span className="min-w-0 truncate text-[var(--color-text-primary)]">{app.name}</span>
                  <span className="shrink-0 text-[var(--color-text-tertiary)]">
                    {COMPUTER_USE_TIER_LABEL[app.tier]}{app.alreadyAuthorized ? ' · 已获授权' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {computerUse.capabilities.length > 0 ? (
          <p className="mt-3 text-xs leading-5 text-[var(--color-text-secondary)]">
            还会请求：{computerUse.capabilities.map((capability) => COMPUTER_USE_CAPABILITY_LABEL[capability]).join('、')}
          </p>
        ) : null}
        {systemPermissions ? (
          <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
            <p className="font-medium text-[var(--color-text-primary)]">需要系统权限</p>
            <p>
              {[
                systemPermissions.accessibilityRequired ? '辅助功能' : null,
                systemPermissions.screenRecordingRequired ? '屏幕录制' : null,
              ].filter(Boolean).join('、')}
              {' '}尚未开启。请先在系统设置中授权；允许本次不能绕过系统权限。
            </p>
          </div>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button type="button" disabled={responding} onClick={() => onRespondToComputerUse(true)} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50">允许本次 Computer Use</button>
          <button type="button" disabled={responding} onClick={() => onRespondToComputerUse(false)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)] disabled:opacity-50">拒绝</button>
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
  const pinTask = useProductTaskStore((state) => state.pinTask)
  const unpinTask = useProductTaskStore((state) => state.unpinTask)
  const continueTask = useProductTaskStore((state) => state.continueTask)
  const mutations = useProductTaskStore((state) => state.mutations)
  const runtime = useProductTaskRuntimeStore((state) => state.tasks[taskId])
  const connectTask = useProductTaskRuntimeStore((state) => state.connectTask)
  const disconnectTask = useProductTaskRuntimeStore((state) => state.disconnectTask)
  const sendText = useProductTaskRuntimeStore((state) => state.sendText)
  const sendMessage = useProductTaskRuntimeStore((state) => state.sendMessage)
  const stopTask = useProductTaskRuntimeStore((state) => state.stopTask)
  const respondToApproval = useProductTaskRuntimeStore((state) => state.respondToApproval)
  const respondToQuestions = useProductTaskRuntimeStore((state) => state.respondToQuestions)
  const respondToComputerUseApproval = useProductTaskRuntimeStore((state) => state.respondToComputerUseApproval)
  const refreshThread = useProductTaskRuntimeStore((state) => state.refreshThread)
  const createSideTask = useProductSideTaskStore((state) => state.createSideTask)
  const openSideTaskPanel = useProductSideTaskStore((state) => state.openSideTaskPanel)
  const sideTaskMutations = useProductSideTaskStore((state) => state.mutations)
  const browserPreviewPanel = useProductTaskBrowserPreviewStore((state) => state.byTaskId[taskId])
  const openBrowserPreviewPanel = useProductTaskBrowserPreviewStore((state) => state.openPanel)
  const closeBrowserPreviewPanel = useProductTaskBrowserPreviewStore((state) => state.closePanel)
  const activateBrowserPreviewPanel = useProductTaskBrowserPreviewStore((state) => state.activatePanel)
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const openTab = useTabStore((state) => state.openTab)
  const openProductTaskTab = useTabStore((state) => state.openProductTaskTab)
  const [draft, setDraft] = useState('')
  const [discoverableSkills, setDiscoverableSkills] = useState<ProductTaskSkillCommand[] | null>(null)
  const [discoverableAgents, setDiscoverableAgents] = useState<ProductTaskAgentCommand[] | null>(null)
  const [commandDiscoveryWorkDir, setCommandDiscoveryWorkDir] = useState<string | null>(null)
  const [skillDiscoveryError, setSkillDiscoveryError] = useState<string | null>(null)
  const [agentDiscoveryError, setAgentDiscoveryError] = useState<string | null>(null)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const [attachmentMessage, setAttachmentMessage] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ProductTaskAttachmentDraft[]>([])
  const [isReviewOpen, setIsReviewOpen] = useState(false)
  const [isMediaOpen, setIsMediaOpen] = useState(false)
  const [isTerminalOpen, setIsTerminalOpen] = useState(false)
  const [activeRightDockPanel, setActiveRightDockPanel] = useState<ProductTaskRightDockPanel | null>(null)
  const [threadActionError, setThreadActionError] = useState<string | null>(null)
  const composingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isBrowserOpen = browserPreviewPanel?.browserOpen ?? false
  const isPreviewOpen = browserPreviewPanel?.previewOpen ?? false
  const isBrowserPreviewOpen = isBrowserOpen || isPreviewOpen
  const openRightDockPanels: OpenProductTaskRightDockPanels = {
    review: isReviewOpen,
    media: isMediaOpen,
    'browser-preview': isBrowserPreviewOpen,
  }
  const resolvedActiveRightDockPanel = resolveActiveRightDockPanel(
    activeRightDockPanel,
    openRightDockPanels,
  )
  const isReviewActive = resolvedActiveRightDockPanel === 'review'
  const isMediaActive = resolvedActiveRightDockPanel === 'media'
  const isBrowserPreviewActive = resolvedActiveRightDockPanel === 'browser-preview'

  useEffect(() => {
    if (resolvedActiveRightDockPanel === activeRightDockPanel) return
    setActiveRightDockPanel(resolvedActiveRightDockPanel)
  }, [activeRightDockPanel, resolvedActiveRightDockPanel])

  const task = useMemo(
    () => index.tasks.find((candidate) => candidate.id === taskId) ?? null,
    [index.tasks, taskId],
  )
  const normalizedWorkDir = task?.workDir.trim() ?? ''
  const isSlashInput = draft.startsWith('/')
  const commandQuery = slashQuery(draft)
  const resolvedTaskId = task?.id

  useEffect(() => {
    if (!task && !isTaskIndexLoading) void refreshTasks()
  }, [isTaskIndexLoading, refreshTasks, task])

  useEffect(() => {
    if (!resolvedTaskId) return
    void connectTask(resolvedTaskId)
    return () => disconnectTask(resolvedTaskId)
  }, [connectTask, disconnectTask, resolvedTaskId])

  useEffect(() => {
    if (!isSlashInput || !normalizedWorkDir) {
      setDiscoverableSkills(null)
      setDiscoverableAgents(null)
      setCommandDiscoveryWorkDir(null)
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

  const submit = () => {
    if (!canSendProductTaskMessage(draft, attachments)) {
      setValidationMessage('请输入任务内容，或添加不超过 4 个附件。')
      return
    }

    const message = resolveTaskComposerRuntimeCommand(draft, taskComposerCommands)
    const accepted = attachments.length > 0
      ? sendMessage(taskId, message, attachments.map(({ id: _id, ...attachment }) => attachment))
      : sendText(taskId, message)
    if (!accepted) {
      setValidationMessage('暂时无法发送这条内容，请检查后重试。')
      return
    }

    setDraft('')
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
      setAttachmentMessage(`部分附件未添加。仅支持常见图片、PDF、文本、JSON、CSV、Word 和 Excel，单个不超过 ${MAX_PRODUCT_TASK_ATTACHMENT_BYTES / 1024 / 1024} MB。`)
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

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!shouldSubmitOnEnter(event, chatSendBehavior)) return
    event.preventDefault()
    submit()
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
              <button type="button" onClick={() => void refreshTasks()} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">重新读取</button>
              <button type="button" onClick={returnToTaskIndex} className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white">{onReturnToTaskIndex ? '关闭窗口' : '返回任务中心'}</button>
            </div>
          </>
        )}
      </main>
    )
  }

  const isArchived = task.lifecycle === 'archived'
  const pinAction = task.pinnedAt ? 'unpin' : 'pin'
  const lifecycleAction = isArchived ? 'restore' : 'archive'
  const canPinTask = task.actions.includes(pinAction)
  const hasActiveRun = runtime?.runState === 'working'
    || runtime?.runState === 'awaiting_approval'
    || runtime?.pendingApproval != null
  const canChangeLifecycle = task.actions.includes(lifecycleAction) && (isArchived || !hasActiveRun)
  const isTaskMutationPending = mutations[`${taskId}:archive`] || mutations[`${taskId}:restore`]
  const isPinMutationPending = mutations[`${taskId}:${pinAction}`]
  const isContinuationPending = mutations[`${taskId}:continue`] === true
  const isSideTaskCreationPending = sideTaskMutations[
    productSideTaskMutationKey(taskId, 'new', 'create')
  ] === true

  const closeReviewDock = () => {
    setIsReviewOpen(false)
    setActiveRightDockPanel((current) => current === 'review'
      ? nextOpenRightDockPanel('review', { ...openRightDockPanels, review: false })
      : current)
  }

  const closeTerminalDock = () => {
    setIsTerminalOpen(false)
  }

  const closeMediaDock = () => {
    setIsMediaOpen(false)
    setActiveRightDockPanel((current) => current === 'media'
      ? nextOpenRightDockPanel('media', { ...openRightDockPanels, media: false })
      : current)
  }

  const openReviewDock = () => {
    setIsReviewOpen(true)
    setActiveRightDockPanel('review')
  }

  const openMediaDock = () => {
    setIsMediaOpen(true)
    setActiveRightDockPanel('media')
  }

  const openTerminalDock = () => {
    setIsTerminalOpen(true)
  }

  const closeBrowserPreviewMode = (mode: ProductTaskBrowserPreviewMode) => {
    closeBrowserPreviewPanel(task.id, mode)
    const remainsOpen = mode === 'browser' ? isPreviewOpen : isBrowserOpen
    setActiveRightDockPanel((current) => current === 'browser-preview' && !remainsOpen
      ? nextOpenRightDockPanel('browser-preview', { ...openRightDockPanels, 'browser-preview': false })
      : current)
  }

  const openBrowserPreviewMode = (mode: ProductTaskBrowserPreviewMode) => {
    const isOpen = mode === 'browser' ? isBrowserOpen : isPreviewOpen
    if (isOpen) {
      activateBrowserPreviewPanel(task.id, mode)
    } else {
      openBrowserPreviewPanel(task.id, mode)
    }
    setActiveRightDockPanel('browser-preview')
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
          <p className="truncate text-xs text-[var(--color-text-tertiary)]">{task.workDir}</p>
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
        <button
          type="button"
          onClick={openReviewDock}
          aria-pressed={isReviewActive}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          审阅
        </button>
        <button
          type="button"
          onClick={openMediaDock}
          aria-pressed={isMediaActive}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          媒体
        </button>
        <button
          type="button"
          onClick={() => openBrowserPreviewMode('browser')}
          aria-pressed={isBrowserPreviewActive && isBrowserOpen && browserPreviewPanel?.activeMode === 'browser'}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          浏览器
        </button>
        <button
          type="button"
          onClick={() => openBrowserPreviewMode('preview')}
          aria-pressed={isBrowserPreviewActive && isPreviewOpen && browserPreviewPanel?.activeMode === 'preview'}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)]"
        >
          预览
        </button>
        <button
          type="button"
          onClick={openTerminalDock}
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

            <ProductTaskRunPanel activities={runtime?.runActivities ?? []} />

            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {runtime?.entries.map((entry) => (
                <ProductTaskThreadEntryView
                  key={entry.id}
                  entry={entry}
                  streaming={entry.id === runtime.streamingEntryId}
                  actionPending={isContinuationPending || isSideTaskCreationPending}
                  onContinueFromEntry={isArchived ? undefined : (sourceEntryId, target) => {
                    void continueFromEntry(sourceEntryId, target)
                  }}
                  onCreateSideTask={isArchived ? undefined : (sourceEntryId) => {
                    void createSideTaskFromEntry(sourceEntryId)
                  }}
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

            {runtime?.pendingApproval ? (
              <ProductTaskApprovalCard
                approval={runtime.pendingApproval}
                responding={runtime.approvalResponsePending}
                onRespondToAction={(allowed) => { respondToApproval(taskId, allowed) }}
                onRespondToQuestions={(answers) => { respondToQuestions(taskId, answers) }}
                onRespondToComputerUse={(allowed) => { respondToComputerUseApproval(taskId, allowed) }}
              />
            ) : null}

            {runtime?.error ? (
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
            {isArchived ? (
              <p className="rounded-lg bg-[var(--color-surface-container)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">
                此任务已归档。恢复后可以继续处理。
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
                {validationMessage ? <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{validationMessage}</p> : null}
                {attachmentMessage ? <p role="alert" className="mt-2 text-xs text-[var(--color-error)]">{attachmentMessage}</p> : null}
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <button type="button" onClick={chooseAttachments} disabled={attachments.length >= MAX_PRODUCT_TASK_ATTACHMENT_COUNT} className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] disabled:opacity-50">添加附件</button>
                    <VoiceInputControl
                      disabled={isArchived}
                      onTranscript={(text) => {
                        setDraft((current) => current ? `${current}\n${text}` : text)
                        setValidationMessage(null)
                      }}
                    />
                    <p className="truncate text-xs text-[var(--color-text-tertiary)]">按当前发送快捷键提交，Shift + Enter 换行。</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {hasActiveRun ? (
                      <button type="button" onClick={() => stopTask(taskId)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-secondary)]">停止</button>
                    ) : null}
                    <button type="submit" className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white">发送</button>
                  </div>
                </div>
              </>
            )}
          </form>
        </section>

        {resolvedActiveRightDockPanel ? (
          <aside className="flex min-h-0 w-[min(34rem,46vw)] min-w-[22rem] flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="product-task-dock-rail">
            {isReviewOpen ? (
              <div
                data-testid="product-task-dock-panel-review"
                data-active={isReviewActive ? 'true' : 'false'}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${isReviewActive ? 'flex' : 'hidden'}`}
              >
                <ProductTaskReviewDock taskId={task.id} onClose={closeReviewDock} />
              </div>
            ) : null}
            {isMediaOpen ? (
              <div
                data-testid="product-task-dock-panel-media"
                data-active={isMediaActive ? 'true' : 'false'}
                className={`min-h-0 flex-1 flex-col overflow-hidden ${isMediaActive ? 'flex' : 'hidden'}`}
              >
                <ProductTaskMediaDock taskId={task.id} onClose={closeMediaDock} />
              </div>
            ) : null}
            {isBrowserPreviewActive ? (
              <div
                data-testid="product-task-dock-panel-browser-preview"
                data-active="true"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <ProductTaskBrowserPreviewDock
                  taskId={task.id}
                  browserOpen={isBrowserOpen}
                  previewOpen={isPreviewOpen}
                  activeMode={browserPreviewPanel?.activeMode ?? null}
                  onActivate={(mode) => {
                    activateBrowserPreviewPanel(task.id, mode)
                    setActiveRightDockPanel('browser-preview')
                  }}
                  onClose={closeBrowserPreviewMode}
                  onCapture={addBrowserPreviewCapture}
                />
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
      {isTerminalOpen ? (
        <section
          data-testid="product-task-terminal-dock"
          data-active="true"
          className="flex h-[min(24rem,42vh)] min-h-48 shrink-0 flex-col overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]"
        >
          <ProductTaskTerminalDock
            taskId={task.id}
            workDir={task.workDir}
            active
            onClose={closeTerminalDock}
            testId={`product-task-terminal-${task.id}`}
          />
        </section>
      ) : null}
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
