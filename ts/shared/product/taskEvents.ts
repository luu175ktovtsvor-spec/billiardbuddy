/**
 * Public, product-facing task-stream contract.
 *
 * These events deliberately describe what a person can act on in a task page.
 * They are not a mirror of the Agent Core websocket protocol: reasoning,
 * tool arguments/results, runtime configuration, and usage metadata do not
 * cross this boundary.
 */

export const PRODUCT_TASK_EVENT_VERSION = 1 as const

export type ProductTaskRunState =
  | 'idle'
  | 'working'
  | 'awaiting_approval'

export type ProductTaskActivityKind =
  | 'workspace'
  | 'command'
  | 'research'
  | 'browser'
  | 'media'
  | 'subtask'
  | 'tool'

export type ProductTaskActivityPhase =
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'

export type ProductTaskApprovalKind =
  | 'action'
  | 'question'
  | 'computer_use'

export type ProductTaskQuestionOption = {
  label: string
  description?: string
}

/**
 * A deliberately narrow projection of AskUserQuestion.  It carries only the
 * fields needed to render a question and collect an answer, never the raw
 * tool input envelope.
 */
export type ProductTaskQuestion = {
  question: string
  header?: string
  options?: ProductTaskQuestionOption[]
  multiSelect?: boolean
}

export type ProductTaskSafeErrorCode =
  | 'task_failed'
  | 'task_unavailable'
  | 'input_too_large'
  | 'protected_input'
  | 'unsupported_input'
  | 'temporarily_unavailable'

export type ProductTaskEvent =
  | { type: 'connected' }
  | { type: 'user_text'; text: string; replayed: true }
  | { type: 'assistant_text_start' }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'status'; state: ProductTaskRunState }
  | {
      type: 'activity'
      kind: ProductTaskActivityKind
      phase: ProductTaskActivityPhase
    }
  | {
      type: 'approval_required'
      requestId: string
      kind: ProductTaskApprovalKind
      questions?: ProductTaskQuestion[]
    }
  | { type: 'turn_complete' }
  | {
      type: 'error'
      code: ProductTaskSafeErrorCode
      retryable: boolean
    }
  | { type: 'title_updated'; title: string }

/**
 * A persisted, product-safe rendering of a task transcript.  It deliberately
 * carries no Agent Core message envelope, tool argument/result payload, model,
 * token usage, or Core session id.
 */
export type ProductTaskThreadEntry =
  | {
      id: string
      type: 'user_text' | 'assistant_text'
      text: string
      createdAt: string
    }
  | {
      id: string
      type: 'activity'
      kind: ProductTaskActivityKind
      phase: Extract<ProductTaskActivityPhase, 'completed' | 'failed'>
      createdAt: string
    }

export type ProductTaskThread = {
  taskId: string
  entries: ProductTaskThreadEntry[]
}
