import { create } from 'zustand'
import { productTasksApi } from '../api/tasks'
import { productTaskSocket } from '../api/taskSocket'
import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskApprovalKind,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskRunState,
  ProductTaskSafeErrorCode,
  ProductTaskThread,
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
  } | null
  pendingApproval: {
    requestId: string
    kind: ProductTaskApprovalKind
    questions?: ProductTaskQuestion[]
  } | null
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
  pendingApproval: null,
  error: null,
  streamingEntryId: null,
}

const MAX_PRODUCT_TASK_TEXT_LENGTH = 32_000

export function canSendProductTaskText(value: string): boolean {
  const content = value.trim()
  return Boolean(content) && content.length <= MAX_PRODUCT_TASK_TEXT_LENGTH && !content.startsWith('/')
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

function mergeInitialThread(
  thread: ProductTaskThread,
  runtime: ProductTaskRuntime,
): ProductTaskThreadEntry[] {
  const transient = runtime.entries.filter((entry) => entry.id.startsWith('live_'))
  return [...thread.entries, ...transient]
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

const socketUnsubscribers = new Map<string, () => void>()
const historyRequestVersions = new Map<string, number>()

type ProductTaskRuntimeStore = {
  tasks: Record<string, ProductTaskRuntime | undefined>
  connectTask: (taskId: string) => Promise<void>
  disconnectTask: (taskId: string) => void
  sendText: (taskId: string, text: string) => boolean
  stopTask: (taskId: string) => void
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

  const refreshThread = async (taskId: string) => {
    const requestVersion = (historyRequestVersions.get(taskId) ?? 0) + 1
    historyRequestVersions.set(taskId, requestVersion)
    updateTask(taskId, (runtime) => ({
      ...runtime,
      historyStatus: runtime.entries.length === 0 ? 'loading' : runtime.historyStatus,
      error: null,
    }))

    try {
      const thread = await productTasksApi.getThread(taskId)
      if (historyRequestVersions.get(taskId) !== requestVersion) return
      updateTask(taskId, (runtime) => ({
        ...runtime,
        historyStatus: 'ready',
        entries: mergeInitialThread(thread, runtime),
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
        socketUnsubscribers.set(taskId, productTaskSocket.connect(taskId, (event) => {
          get().handleEvent(taskId, event)
        }))
      }
      await refreshThread(taskId)
    },

    disconnectTask: (taskId) => {
      socketUnsubscribers.get(taskId)?.()
      socketUnsubscribers.delete(taskId)
      productTaskSocket.disconnect(taskId)
      updateTask(taskId, (runtime) => ({ ...runtime, connectionState: 'disconnected' }))
    },

    sendText: (taskId, text) => {
      const content = text.trim()
      if (!canSendProductTaskText(content)) return false
      if (!socketUnsubscribers.has(taskId)) {
        void get().connectTask(taskId)
      }
      productTaskSocket.send(taskId, { type: 'user_message', content })
      updateTask(taskId, (runtime) => ({
        ...runtime,
        runState: 'working',
        error: null,
        entries: [
          ...runtime.entries,
          {
            id: liveEntryId(taskId, 'user'),
            type: 'user_text',
            text: content,
            createdAt: createdAt(),
          },
        ],
      }))
      return true
    },

    stopTask: (taskId) => {
      productTaskSocket.send(taskId, { type: 'stop_generation' })
    },

    refreshThread,

    handleEvent: (taskId, event) => {
      if (event.type === 'turn_complete') {
        updateTask(taskId, (runtime) => ({
          ...runtime,
          runState: 'idle',
          activeActivity: null,
          pendingApproval: null,
          streamingEntryId: null,
        }))
        void get().refreshThread(taskId)
        return
      }

      updateTask(taskId, (runtime) => {
        switch (event.type) {
          case 'connected':
            return { ...runtime, connectionState: 'connected' }

          case 'user_text': {
            const alreadyOptimistic = runtime.entries.some((entry) => (
              entry.type === 'user_text' && entry.id.startsWith('live_') && entry.text === event.text
            ))
            if (alreadyOptimistic) return runtime
            return {
              ...runtime,
              entries: [...runtime.entries, {
                id: liveEntryId(taskId, 'replayed-user'),
                type: 'user_text',
                text: event.text,
                createdAt: createdAt(),
              }],
            }
          }

          case 'assistant_text_start':
            return { ...runtime, streamingEntryId: liveEntryId(taskId, 'assistant') }

          case 'assistant_text_delta':
            return appendOrReplaceStreamingText(runtime, taskId, event.text)

          case 'status':
            return { ...runtime, runState: event.state }

          case 'activity': {
            let next: ProductTaskRuntime = {
              ...runtime,
              activeActivity: { kind: event.kind, phase: event.phase },
            }
            if (event.phase === 'completed' || event.phase === 'failed') {
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
                ...(event.questions ? { questions: event.questions } : {}),
              },
            }

          case 'error':
            return {
              ...runtime,
              error: { code: event.code, retryable: event.retryable },
              streamingEntryId: null,
            }

          case 'title_updated':
            return runtime
        }
      })
    },
  }
})
