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

/**
 * Product-safe classes of an Agent Run effect.  They identify the boundary a
 * person may need to check, but never reveal a provider request, tool input,
 * workspace path, or response body.
 */
export const PRODUCT_TASK_EXTERNAL_OPERATION_KINDS = [
  // An accepted Codex app-server Turn is an external execution boundary even
  // though the process is local: its model request can begin immediately.
  'engine_turn',
  // A running Codex Turn may accept a user steer and immediately alter its
  // next model/tool decision, so it has its own durable receipt.
  'engine_steer',
  'mcp_prepare',
  'chat_prompt',
  'command_prompt',
  'model',
  'tools',
  'hook_command',
  'hook_http',
  'model_ack',
  'workspace_init',
  'auto_memory_append',
] as const

export type ProductTaskExternalOperationKind = typeof PRODUCT_TASK_EXTERNAL_OPERATION_KINDS[number]

/**
 * A durable reconciliation requirement for one interrupted Agent Run.  The
 * identity is deliberately opaque and contains no effect payload; it binds a
 * user confirmation to the exact run generation and effect receipt instead of
 * treating a stale boolean confirmation as permission to replay work.
 */
export type ProductTaskOutcomeUnknown = {
  runId: string
  generation: number
  operation: {
    id: string
    kind: ProductTaskExternalOperationKind
    startedAt: string
  }
}

export type ProductTaskActivityKind =
  | 'file_read'
  | 'file_change'
  | 'workspace'
  | 'command'
  | 'research'
  | 'browser'
  | 'media'
  | 'extension'
  | 'automation'
  | 'subtask'
  | 'tool'

export type ProductTaskActivityPhase =
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'

/**
 * A bounded, count-based progress signal for a product activity.  It is
 * intentionally not a percentage or a raw runtime message: callers only set
 * it when both counts are known from a structured Core event.
 */
export type ProductTaskActivityProgress = {
  completed: number
  total: number
}

/**
 * One safe, opaque item in a product task's active run tree.  It intentionally
 * contains no Core tool identity, raw input/output, path, or session metadata.
 * Its kind still identifies the user-verifiable class of work.
 */
export type ProductTaskRunActivity = {
  id: string
  parentId?: string
  kind: ProductTaskActivityKind
  phase: ProductTaskActivityPhase
  summary: string
  progress?: ProductTaskActivityProgress
}

/** A durable, user-visible task plan. It never exposes a Core tool envelope. */
export type ProductTaskPlanStep = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type ProductTaskPlan = {
  id: string
  steps: ProductTaskPlanStep[]
}

/**
 * The bounded, task-scoped run state replayed when a product task socket
 * connects. It has no task/session/run identifier because the websocket URL
 * already scopes it to one public product task.
 */
export type ProductTaskRunSnapshot = {
  state: ProductTaskRunState
  activities: ProductTaskRunActivity[]
  plan?: ProductTaskPlan
  /** Always present so a newer authoritative snapshot can clear an old block. */
  outcomeUnknown: ProductTaskOutcomeUnknown | null
}

export type ProductTaskApprovalKind =
  | 'action'
  | 'question'

/** Product-authored explanation of one Core boundary crossing. */
export type ProductTaskActionApproval = {
  what: string
  scope: string
  consequence: string
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

export const PRODUCT_TASK_RUN_FAILURE_CODES = [
  'task_model_configuration',
  'task_authentication',
  'task_capacity_limited',
  'task_model_unavailable',
  'task_network_unavailable',
  'task_context_limit',
  'task_model_response_invalid',
  'task_project_automation_failed',
  'task_attachment_processing_failed',
  'task_execution_environment_failed',
  'task_failed',
] as const

export type ProductTaskRunFailureCode = typeof PRODUCT_TASK_RUN_FAILURE_CODES[number]

export type ProductTaskRunFailure = {
  code: ProductTaskRunFailureCode
  retryable: boolean
}

export type ProductTaskSafeErrorCode =
  | 'attachment_ingest_unavailable'
  | ProductTaskRunFailureCode
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

export type ProductTaskQueuedInput = {
  id: string
  text: string
  state: 'queued' | 'injected' | 'promoted' | 'failed' | 'cancelled'
  createdAt: string
  attachmentCount: number
  /** Present while a queued steer is locked to, or after it joins, an actual Turn. */
  targetRunId?: string
}

export type ProductTaskContextCompaction = {
  id: string
  phase: 'started' | 'completed' | 'failed'
  source: 'automatic' | 'manual'
  generation: number
}

export type ProductTaskEvent =
  | {
      type: 'user_text'
      text: string
      replayed: true
      /** Permanent durable-ledger cursor; absent only for legacy Core replay. */
      event_sequence?: number
      /** Stable public Item identity when replayed from the durable ledger. */
      id?: string
      attachments?: ProductTaskAttachmentSummary[]
      referenceEntryIds?: string[]
    }
  | { type: 'assistant_text_start' }
  | { type: 'assistant_text_delta'; text: string }
  /** Authoritative replacement for the currently streaming item after reconnect. */
  | { type: 'assistant_text_snapshot'; text: string }
  | {
      type: 'assistant_text'
      id: string
      text: string
      replayed: true
      event_sequence: number
    }
  | { type: 'status'; state: ProductTaskRunState }
  | {
      type: 'queue_updated'
      item: ProductTaskQueuedInput
      event_sequence: number
      replayed?: true
    }
  | {
      type: 'context_compaction'
      item: ProductTaskContextCompaction
      event_sequence: number
      replayed?: true
    }
  | ({ type: 'run_snapshot' } & ProductTaskRunSnapshot)
  | {
      type: 'plan_updated'
      plan: ProductTaskPlan
      event_sequence: number
      replayed?: true
    }
  | {
      type: 'activity'
      kind: ProductTaskActivityKind
      phase: ProductTaskActivityPhase
      /**
       * Opaque, product-scoped identity for one Core activity.
       */
      id: string
      /** Opaque parent activity identity when Core supplied a reliable link. */
      parentId?: string
      /** Product-authored, human-readable status text. Never a Core message. */
      summary: string
      /** Present only when the source exposes a trustworthy bounded count. */
      progress?: ProductTaskActivityProgress
      /** Durable-ledger cursor when this activity is replayed after reconnect. */
      event_sequence?: number
      replayed?: true
    }
  | {
      type: 'approval_required'
      requestId: string
      kind: 'action'
      /** Optional only while replaying an older v1 runtime event. */
      action?: ProductTaskActionApproval
    }
  | {
      type: 'approval_required'
      requestId: string
      kind: 'question'
      questions: ProductTaskQuestion[]
    }
  | { type: 'turn_complete' }
  | {
      type: 'run_terminal'
      id: string
      state: 'completed' | 'stopped' | 'recovery_required'
      failure?: ProductTaskRunFailure
      replayed: true
      event_sequence: number
    }
  | {
      type: 'outcome_unknown'
      outcome: ProductTaskOutcomeUnknown
      event_sequence: number
      replayed?: true
    }
  | {
      type: 'error'
      code: ProductTaskSafeErrorCode
      retryable: boolean
    }
  | { type: 'resume_cursor'; cursor: number }
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
      referenceEntryIds?: string[]
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
  /** A user-confirmed retry is required before the blocked queue can advance. */
  recoveryRequired?: boolean
  /** An admitted external effect lost its final receipt; never auto-replay it. */
  outcomeUnknown?: ProductTaskOutcomeUnknown
}

type TaskEventBase = {
  event_sequence: number
  task_id: string
  created_at: string
}

/** Durable BB-02C Item/Event ledger. This is distinct from authority operation audit. */
type TaskEventPayload =
  | {
      type: 'user_text'
      run_id: string
      entry_id: string
      item_id?: string
      text: string
      attachment_ids: string[]
      /** Safe historic summaries when no attachment blob was retained. */
      attachment_summaries?: ProductTaskAttachmentSummary[]
      reference_entry_ids?: string[]
    }
  | {
      type: 'assistant_text'
      run_id: string
      dispatch_generation: number
      item_id: string
      text: string
    }
  | {
      type: 'activity'
      run_id: string
      dispatch_generation: number
      item_id: string
      parent_item_id?: string
      kind: ProductTaskActivityKind
      phase: ProductTaskActivityPhase
      summary: string
      progress?: ProductTaskActivityProgress
    }
  | {
      type: 'plan_updated'
      run_id: string
      dispatch_generation: number
      item_id: string
      steps: ProductTaskPlanStep[]
    }
  | {
      type: 'run_terminal'
      run_id: string
      dispatch_generation: number
      item_id: string
      state: 'completed' | 'stopped' | 'recovery_required'
    }
  | {
      type: 'outcome_unknown'
      run_id: string
      dispatch_generation: number
      operation_id: string
      operation_kind: ProductTaskExternalOperationKind
      operation_started_at: string
    }
  | {
      type: 'queue_updated'
      queue_item_id: string
      entry_id: string
      phase: 'queued' | 'injected' | 'promoted' | 'failed' | 'cancelled'
      text: string
      attachment_count: number
      target_run_id?: string
    }
  | {
      type: 'context_compaction'
      run_id: string
      dispatch_generation: number
      item_id: string
      phase: 'started' | 'completed' | 'failed'
      source: 'automatic' | 'manual'
      generation: number
      input_tokens: number
      output_tokens?: number
    }
  | {
      type: 'approval'
      run_id: string
      dispatch_generation: number
      item_id: string
      request_id: string
      phase: 'requested' | 'resolved'
      action: ProductTaskActionApproval
      decision?: 'allowed' | 'denied'
      reviewer?: 'user' | 'automatic'
    }

/** Keep the persisted event as an explicit discriminated union so callers can
 * narrow on `type` without falling back to unchecked property access. */
export type TaskEvent = {
  [Kind in TaskEventPayload['type']]: TaskEventBase & Extract<TaskEventPayload, { type: Kind }>
}[TaskEventPayload['type']]
