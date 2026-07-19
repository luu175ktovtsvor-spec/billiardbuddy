import { create } from 'zustand'
import { productTasksApi } from '../api/tasks'
import {
  productTaskSocket,
  type ProductTaskAttachment,
  type ProductTaskSocketLifecycleEvent,
} from '../api/taskSocket'
import { parseProductTaskThread } from '../api/taskProtocol'
import { useTabStore } from '../../stores/tabStore'
import { useProductTaskStore } from './productTaskStore'
import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskRunActivity,
  ProductTaskAttachmentSummary,
  ProductTaskApprovalKind,
  ProductTaskComputerUseApproval,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskRunState,
  ProductTaskSafeErrorCode,
  ProductTaskThreadEntry,
} from '../domain/types'

export type ProductTaskConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'

export type ProductTaskRuntime = {
  connectionState: ProductTaskConnectionState
  historyStatus: 'idle' | 'loading' | 'ready' | 'error'
  runState: ProductTaskRunState
  entries: ProductTaskThreadEntry[]
  activeActivity: {
    kind: ProductTaskActivityKind
    phase: ProductTaskActivityPhase
    summary?: string
  } | null
  runActivities: ProductTaskRunActivity[]
  pendingApproval: {
    requestId: string
    kind: ProductTaskApprovalKind
    questions?: ProductTaskQuestion[]
    computerUse?: ProductTaskComputerUseApproval
  } | null
  approvalResponsePending: boolean
  error: {
    code: ProductTaskSafeErrorCode
    retryable: boolean
  } | null
  streamingEntryId: string | null
}

export const PRODUCT_TASK_SAFE_ERROR_LABEL: Record<ProductTaskSafeErrorCode, string> = {
  task_failed: '任务暂未完成，请稍后重试。',
  task_unavailable: '当前任务暂时不可用。',
  input_too_large: '提交的内容过大，请精简后再试。',
  protected_input: '该内容受保护，暂时无法处理。',
  unsupported_input: '该内容暂不支持处理。',
  temporarily_unavailable: '服务暂时不可用，请稍后重试。',
}

const EMPTY_RUNTIME: ProductTaskRuntime = {
  connectionState: 'disconnected',
  historyStatus: 'idle',
  runState: 'idle',
  entries: [],
  activeActivity: null,
  runActivities: [],
  pendingApproval: null,
  approvalResponsePending: false,
  error: null,
  streamingEntryId: null,
}

const MAX_PRODUCT_TASK_TEXT_LENGTH = 32_000
const MAX_ATTACHMENT_NAME_LENGTH = 160
const MAX_TRACKED_RUN_ACTIVITIES = 256
const SAFE_IMAGE_MIME_TYPES = new Set<NonNullable<ProductTaskAttachmentSummary['mimeType']>>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

export function canSendProductTaskText(value: string): boolean {
  const content = value.trim()
  // Slash commands are still task text at this layer. The product composer
  // discovers and presents them, while the Agent Core remains the authority
  // for their semantics (including Skills and Agents).
  return Boolean(content) && content.length <= MAX_PRODUCT_TASK_TEXT_LENGTH
}

export function canSendProductTaskMessage(
  value: string,
  attachments: readonly ProductTaskAttachment[] = [],
): boolean {
  const content = value.trim()
  return content.length <= MAX_PRODUCT_TASK_TEXT_LENGTH && (Boolean(content) || attachments.length > 0)
}

function productAttachmentSummary(
  attachment: ProductTaskAttachment,
): ProductTaskAttachmentSummary {
  const rawName = attachment.name?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? ''
  const name = rawName.slice(0, MAX_ATTACHMENT_NAME_LENGTH) || (
    attachment.type === 'image' ? '图片附件' : '文件附件'
  )
  const mimeType = attachment.type === 'image' && SAFE_IMAGE_MIME_TYPES.has(
    attachment.mimeType as NonNullable<ProductTaskAttachmentSummary['mimeType']>,
  )
    ? attachment.mimeType as NonNullable<ProductTaskAttachmentSummary['mimeType']>
    : undefined
  return {
    type: attachment.type,
    name,
    ...(mimeType ? { mimeType } : {}),
  }
}

function attachmentSignature(
  attachments: readonly ProductTaskAttachmentSummary[] | undefined,
): string {
  return (attachments ?? [])
    .map((attachment) => `${attachment.type}:${attachment.name}:${attachment.mimeType ?? ''}`)
    .join('|')
}

function createRuntime(): ProductTaskRuntime {
  return {
    ...EMPTY_RUNTIME,
    entries: [],
  }
}

function liveEntryId(taskId: string, kind: string): string {
  return `live_${taskId}_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function createdAt(): string {
  return new Date().toISOString()
}

function mergeThreadSnapshot(
  thread: { entries: ProductTaskThreadEntry[] },
  runtime: ProductTaskRuntime,
  liveEntryIdsAtRequestStart: ReadonlySet<string>,
): ProductTaskThreadEntry[] {
  // A returned transcript is the source of truth for entries visible when the
  // request began. Preserve only live events that arrived after that point.
  // This prevents a completed turn from being appended a second time after its
  // server snapshot is available, while retaining a newly started turn.
  const availableSnapshotEntries = entryMultiset(thread.entries)

  // Existing persisted entries account for the matching snapshot entries first,
  // so a later identical message is not mistaken for historical content.
  for (const entry of runtime.entries) {
    if (!entry.id.startsWith('live_')) consumeSnapshotEntry(availableSnapshotEntries, entry)
  }

  const transient: ProductTaskThreadEntry[] = []
  for (const entry of runtime.entries) {
    if (!entry.id.startsWith('live_')) continue

    const existedAtRequestStart = liveEntryIdsAtRequestStart.has(entry.id)
    const confirmedBySnapshot = consumeSnapshotEntry(availableSnapshotEntries, entry)
    if (!existedAtRequestStart && !confirmedBySnapshot) transient.push(entry)
  }
  return [...thread.entries, ...transient]
}

function entrySignature(entry: ProductTaskThreadEntry): string {
  if (entry.type === 'activity') return `activity:${entry.kind}:${entry.phase}`
  // The persisted product projection trims visible text; stream deltas retain
  // whitespace while they are arriving, so normalize only for reconciliation.
  return `${entry.type}:${entry.text.trim()}:${entry.type === 'user_text'
    ? attachmentSignature(entry.attachments)
    : ''}`
}

function entryMultiset(entries: readonly ProductTaskThreadEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const signature = entrySignature(entry)
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  return counts
}

function consumeSnapshotEntry(counts: Map<string, number>, entry: ProductTaskThreadEntry): boolean {
  const signature = entrySignature(entry)
  const count = counts.get(signature) ?? 0
  if (count === 0) return false
  if (count === 1) counts.delete(signature)
  else counts.set(signature, count - 1)
  return true
}

function appendOrReplaceStreamingText(
  runtime: ProductTaskRuntime,
  taskId: string,
  text: string,
): ProductTaskRuntime {
  const entryId = runtime.streamingEntryId ?? liveEntryId(taskId, 'assistant')
  const index = runtime.entries.findIndex((entry) => entry.id === entryId)
  const entry: ProductTaskThreadEntry = {
    id: entryId,
    type: 'assistant_text',
    text: index === -1
      ? text
      : (runtime.entries[index]!.type === 'assistant_text'
        ? `${runtime.entries[index]!.text}${text}`
        : text),
    createdAt: index === -1 ? createdAt() : runtime.entries[index]!.createdAt,
  }
  const entries = index === -1
    ? [...runtime.entries, entry]
    : runtime.entries.map((current, currentIndex) => currentIndex === index ? entry : current)
  return { ...runtime, entries, streamingEntryId: entryId }
}

function appendActivity(
  runtime: ProductTaskRuntime,
  taskId: string,
  kind: ProductTaskActivityKind,
  phase: Extract<ProductTaskActivityPhase, 'completed' | 'failed'>,
): ProductTaskRuntime {
  return {
    ...runtime,
    entries: [
      ...runtime.entries,
      {
        id: liveEntryId(taskId, `activity-${kind}`),
        type: 'activity',
        kind,
        phase,
        createdAt: createdAt(),
      },
    ],
  }
}

function upsertRunActivity(
  activities: readonly ProductTaskRunActivity[],
  event: Extract<ProductTaskEvent, { type: 'activity' }>,
): ProductTaskRunActivity[] {
  if (!event.id || !event.summary) return [...activities]
  const previousIndex = activities.findIndex((activity) => activity.id === event.id)
  const previous = previousIndex === -1 ? undefined : activities[previousIndex]
  const activity: ProductTaskRunActivity = {
    id: event.id,
    ...(event.parentId && event.parentId !== event.id
      ? { parentId: event.parentId }
      : previous?.parentId
        ? { parentId: previous.parentId }
        : {}),
    kind: event.kind,
    phase: event.phase,
    summary: event.summary,
    ...(event.progress
      ? { progress: event.progress }
      : previous?.progress
        ? { progress: previous.progress }
        : {}),
  }
  const next = previousIndex === -1
    ? [...activities, activity]
    : activities.map((current, index) => index === previousIndex ? activity : current)
  return next.length > MAX_TRACKED_RUN_ACTIVITIES
    ? next.slice(-MAX_TRACKED_RUN_ACTIVITIES)
    : next
}

function snapshotRunActivities(
  activities: readonly ProductTaskRunActivity[],
): ProductTaskRunActivity[] {
  return activities.slice(0, MAX_TRACKED_RUN_ACTIVITIES).map((activity) => ({
    ...activity,
    ...(activity.progress ? { progress: { ...activity.progress } } : {}),
  }))
}

function activeActivityFromRunActivities(
  activities: readonly ProductTaskRunActivity[],
): ProductTaskRuntime['activeActivity'] {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!
    if (activity.phase !== 'started' && activity.phase !== 'running') continue
    return {
      kind: activity.kind,
      phase: activity.phase,
      summary: activity.summary,
    }
  }
  return null
}

const socketUnsubscribers = new Map<string, () => void>()
const historyRequestVersions = new Map<string, number>()

type ThreadRefreshReason = 'initial' | 'reconnect' | 'turn_complete' | 'manual'
type UpdateTask = (
  taskId: string,
  update: (runtime: ProductTaskRuntime) => ProductTaskRuntime,
) => void
type RefreshTaskThread = (taskId: string, reason?: ThreadRefreshReason) => Promise<void>

function liveEntryIds(runtime: ProductTaskRuntime | undefined): Set<string> {
  return new Set(
    runtime?.entries
      .filter((entry) => entry.id.startsWith('live_'))
      .map((entry) => entry.id) ?? [],
  )
}

function handleSocketLifecycle(
  taskId: string,
  event: ProductTaskSocketLifecycleEvent,
  updateTask: UpdateTask,
  refreshThread: RefreshTaskThread,
): void {
  switch (event.type) {
    case 'connecting':
    case 'reconnecting':
      updateTask(taskId, (runtime) => ({ ...runtime, connectionState: 'connecting' }))
      return

    case 'disconnected':
      updateTask(taskId, (runtime) => ({ ...runtime, connectionState: 'disconnected' }))
      return

    case 'connected':
      updateTask(taskId, (runtime) => ({ ...runtime, connectionState: 'connected' }))
      if (event.reconnected) void refreshThread(taskId, 'reconnect')
      return
  }
}

type ProductTaskRuntimeStore = {
  tasks: Record<string, ProductTaskRuntime | undefined>
  connectTask: (taskId: string) => Promise<void>
  disconnectTask: (taskId: string) => void
  sendText: (taskId: string, text: string) => boolean
  sendMessage: (taskId: string, text: string, attachments?: ProductTaskAttachment[]) => boolean
  stopTask: (taskId: string) => void
  respondToApproval: (taskId: string, allowed: boolean) => boolean
  respondToQuestions: (taskId: string, answers: string[]) => boolean
  respondToComputerUseApproval: (taskId: string, allowed: boolean) => boolean
  refreshThread: (taskId: string) => Promise<void>
  handleEvent: (taskId: string, event: ProductTaskEvent) => void
}

export const useProductTaskRuntimeStore = create<ProductTaskRuntimeStore>((set, get) => {
  const updateTask = (
    taskId: string,
    update: (runtime: ProductTaskRuntime) => ProductTaskRuntime,
  ) => {
    set((state) => {
      const current = state.tasks[taskId] ?? createRuntime()
      return {
        tasks: {
          ...state.tasks,
          [taskId]: update(current),
        },
      }
    })
  }

  const refreshThread = async (
    taskId: string,
    _reason: ThreadRefreshReason = 'manual',
  ) => {
    const requestVersion = (historyRequestVersions.get(taskId) ?? 0) + 1
    historyRequestVersions.set(taskId, requestVersion)
    const liveEntryIdsAtRequestStart = liveEntryIds(get().tasks[taskId])
    updateTask(taskId, (runtime) => ({
      ...runtime,
      historyStatus: runtime.entries.length === 0 ? 'loading' : runtime.historyStatus,
      error: null,
    }))

    try {
      const response = await productTasksApi.getThread(taskId)
      const thread = parseProductTaskThread(response, taskId)
      if (!thread) throw new Error('Invalid product task thread payload')
      if (historyRequestVersions.get(taskId) !== requestVersion) return
      updateTask(taskId, (runtime) => ({
        ...runtime,
        historyStatus: 'ready',
        entries: mergeThreadSnapshot(thread, runtime, liveEntryIdsAtRequestStart),
      }))
    } catch {
      if (historyRequestVersions.get(taskId) !== requestVersion) return
      updateTask(taskId, (runtime) => ({ ...runtime, historyStatus: 'error' }))
    }
  }

  return {
    tasks: {},

    connectTask: async (taskId) => {
      if (!socketUnsubscribers.has(taskId)) {
        updateTask(taskId, (runtime) => ({ ...runtime, connectionState: 'connecting' }))
        socketUnsubscribers.set(taskId, productTaskSocket.connect(
          taskId,
          (event) => {
            get().handleEvent(taskId, event)
          },
          (lifecycleEvent) => {
            handleSocketLifecycle(taskId, lifecycleEvent, updateTask, refreshThread)
          },
        ))
      }
      await refreshThread(taskId, 'initial')
    },

    disconnectTask: (taskId) => {
      historyRequestVersions.set(taskId, (historyRequestVersions.get(taskId) ?? 0) + 1)
      socketUnsubscribers.get(taskId)?.()
      socketUnsubscribers.delete(taskId)
      productTaskSocket.disconnect(taskId)
      updateTask(taskId, (runtime) => ({
        ...runtime,
        connectionState: 'disconnected',
        historyStatus: runtime.entries.length === 0 ? 'idle' : 'ready',
      }))
    },

    sendText: (taskId, text) => get().sendMessage(taskId, text),

    sendMessage: (taskId, text, attachments = []) => {
      const content = text.trim()
      if (!canSendProductTaskMessage(content, attachments)) return false
      const attachmentSummaries = attachments.map(productAttachmentSummary)
      if (!socketUnsubscribers.has(taskId)) {
        void get().connectTask(taskId)
      }
      productTaskSocket.send(taskId, {
        type: 'user_message',
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
      updateTask(taskId, (runtime) => ({
        ...runtime,
        runState: 'working',
        error: null,
        activeActivity: null,
        runActivities: [],
        entries: content || attachmentSummaries.length > 0
          ? [
              ...runtime.entries,
              {
                id: liveEntryId(taskId, 'user'),
                type: 'user_text',
                text: content || (attachmentSummaries.length === 1 ? '已添加附件' : `已添加 ${attachmentSummaries.length} 个附件`),
                createdAt: createdAt(),
                ...(attachmentSummaries.length > 0 ? { attachments: attachmentSummaries } : {}),
              },
            ]
          : runtime.entries,
      }))
      return true
    },

    stopTask: (taskId) => {
      productTaskSocket.send(taskId, { type: 'stop_generation' })
    },

    respondToApproval: (taskId, allowed) => {
      const runtime = get().tasks[taskId]
      const pending = runtime?.pendingApproval
      if (!pending || pending.kind !== 'action' || runtime?.approvalResponsePending) return false

      productTaskSocket.send(taskId, {
        type: 'permission_response',
        requestId: pending.requestId,
        allowed,
      })
      updateTask(taskId, (current) => ({ ...current, approvalResponsePending: true }))
      return true
    },

    respondToQuestions: (taskId, answers) => {
      const runtime = get().tasks[taskId]
      const pending = runtime?.pendingApproval
      if (
        !pending ||
        pending.kind !== 'question' ||
        runtime?.approvalResponsePending ||
        !pending.questions ||
        answers.length !== pending.questions.length ||
        answers.some((answer) => !answer.trim())
      ) {
        return false
      }

      productTaskSocket.send(taskId, {
        type: 'ask_user_question_response',
        requestId: pending.requestId,
        answers: answers.map((answer) => answer.trim()),
      })
      updateTask(taskId, (current) => ({ ...current, approvalResponsePending: true }))
      return true
    },

    respondToComputerUseApproval: (taskId, allowed) => {
      const runtime = get().tasks[taskId]
      const pending = runtime?.pendingApproval
      if (
        !pending ||
        pending.kind !== 'computer_use' ||
        !pending.computerUse ||
        runtime?.approvalResponsePending
      ) {
        return false
      }

      // The product client chooses only this one-shot allow/deny decision.
      // The server reconstructs every app grant and requested capability from
      // the pending Computer Use request.
      productTaskSocket.send(taskId, {
        type: 'computer_use_permission_response',
        requestId: pending.requestId,
        allowed,
      })
      updateTask(taskId, (current) => ({ ...current, approvalResponsePending: true }))
      return true
    },

    refreshThread,

    handleEvent: (taskId, event) => {
      if (event.type === 'title_updated') {
        // The stream is the first place an Agent-generated task title arrives.
        // Keep every product-owned title surface in sync without addressing a
        // Core session or the legacy ChatStore.
        useProductTaskStore.getState().applyRuntimeTaskTitle(taskId, event.title)
        useTabStore.getState().updateProductTaskTitle(taskId, event.title)
        return
      }

      if (event.type === 'turn_complete') {
        updateTask(taskId, (runtime) => ({
          ...runtime,
          runState: 'idle',
          activeActivity: null,
          pendingApproval: null,
          approvalResponsePending: false,
          streamingEntryId: null,
        }))
        void refreshThread(taskId, 'turn_complete')
        return
      }

      if (event.type === 'run_snapshot') {
        const runActivities = snapshotRunActivities(event.activities)
        updateTask(taskId, (runtime) => ({
          ...runtime,
          runState: event.state,
          runActivities,
          activeActivity: activeActivityFromRunActivities(runActivities),
          // Permission details are deliberately not part of a run snapshot.
          // A following approval_required replay is the sole authority for a
          // new approval card.
          pendingApproval: null,
          approvalResponsePending: false,
        }))
        return
      }

      updateTask(taskId, (runtime) => {
        switch (event.type) {
          case 'connected':
            return { ...runtime, connectionState: 'connected' }

          case 'user_text': {
            const eventSignature = `${event.text}:${attachmentSignature(event.attachments)}`
            const alreadyOptimistic = runtime.entries.some((entry) => (
              entry.type === 'user_text' &&
              entry.id.startsWith('live_') &&
              `${entry.text}:${attachmentSignature(entry.attachments)}` === eventSignature
            ))
            if (alreadyOptimistic) return runtime
            return {
              ...runtime,
              activeActivity: null,
              runActivities: [],
              entries: [...runtime.entries, {
                id: liveEntryId(taskId, 'replayed-user'),
                type: 'user_text',
                text: event.text,
                createdAt: createdAt(),
                ...(event.attachments?.length ? { attachments: event.attachments } : {}),
              }],
            }
          }

          case 'assistant_text_start':
            return { ...runtime, streamingEntryId: liveEntryId(taskId, 'assistant') }

          case 'assistant_text_delta':
            return appendOrReplaceStreamingText(runtime, taskId, event.text)

          case 'status':
            return {
              ...runtime,
              runState: event.state,
              ...(event.state === 'awaiting_approval'
                ? {}
                : { pendingApproval: null, approvalResponsePending: false }),
            }

          case 'activity': {
            let next: ProductTaskRuntime = {
              ...runtime,
              activeActivity: {
                kind: event.kind,
                phase: event.phase,
                ...(event.summary ? { summary: event.summary } : {}),
              },
              runActivities: upsertRunActivity(runtime.runActivities, event),
            }
            if (!event.id && (event.phase === 'completed' || event.phase === 'failed')) {
              next = appendActivity(next, taskId, event.kind, event.phase)
            }
            return next
          }

          case 'approval_required':
            return {
              ...runtime,
              runState: 'awaiting_approval',
              pendingApproval: {
                requestId: event.requestId,
                kind: event.kind,
                ...(event.kind === 'question' ? { questions: event.questions } : {}),
                ...(event.kind === 'computer_use' ? { computerUse: event.computerUse } : {}),
              },
              approvalResponsePending: false,
            }

          case 'error':
            return {
              ...runtime,
              error: { code: event.code, retryable: event.retryable },
              streamingEntryId: null,
              approvalResponsePending: false,
              // A terminal product error has no corresponding Core completion
              // event to return the compact task UI to an actionable state.
              ...(event.retryable
                ? {}
                : { runState: 'idle', activeActivity: null, pendingApproval: null }),
            }
        }
      })
    },
  }
})
