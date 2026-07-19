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

/**
 * Safe Computer Use capabilities a product task can request. These are
 * deliberately capability labels rather than desktop grant flags, so the
 * browser never receives a mutable Computer Use policy object.
 */
export type ProductTaskComputerUseCapability =
  | 'clipboard_read'
  | 'clipboard_write'
  | 'system_key_combos'

/** A human-readable application summary with no bundle identifier or path. */
export type ProductTaskComputerUseApp = {
  name: string
  tier: 'read' | 'click' | 'full'
  alreadyAuthorized: boolean
}

/**
 * Product-safe Computer Use approval details. Local paths, bundle IDs, icon
 * payloads, raw tool input, and runtime metadata never cross this boundary.
 */
export type ProductTaskComputerUseApproval = {
  apps: ProductTaskComputerUseApp[]
  capabilities: ProductTaskComputerUseCapability[]
  systemPermissions?: {
    accessibilityRequired: boolean
    screenRecordingRequired: boolean
  }
}

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

/**
 * A persisted, user-readable attachment hint. It deliberately carries no
 * local path, upload handle, source data, checksum, or file contents.
 */
export type ProductTaskAttachmentSummary = {
  type: 'file' | 'image'
  name: string
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
}

export type ProductTaskEvent =
  | { type: 'connected' }
  | {
      type: 'user_text'
      text: string
      replayed: true
      attachments?: ProductTaskAttachmentSummary[]
    }
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
      kind: 'action'
    }
  | {
      type: 'approval_required'
      requestId: string
      kind: 'question'
      questions: ProductTaskQuestion[]
    }
  | {
      type: 'approval_required'
      requestId: string
      kind: 'computer_use'
      computerUse: ProductTaskComputerUseApproval
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
      type: 'user_text'
      text: string
      createdAt: string
      attachments?: ProductTaskAttachmentSummary[]
    }
  | {
      id: string
      type: 'assistant_text'
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
