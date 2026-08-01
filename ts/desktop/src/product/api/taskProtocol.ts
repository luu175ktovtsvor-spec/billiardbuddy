import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
  ProductTaskRunActivity,
  ProductTaskPlan,
  ProductTaskPlanStep,
  ProductTaskAttachmentSummary,
  ProductTaskActionApproval,
  ProductTaskApprovalKind,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskRunState,
  ProductTaskRunFailure,
  ProductTaskRunFailureCode,
  ProductTaskSafeErrorCode,
  ProductTaskQueuedInput,
  ProductTaskThread,
  ProductTaskThreadEntry,
  ProductPublicWorkspace,
  ProductPublicComposerDraft,
  ProductPublicConversationLineage,
  ProductPublicOperationReceipt,
  ProductAttachmentOperationResult,
} from '../domain/types'

const MAX_PRODUCT_TEXT_LENGTH = 100_000
const MAX_PRODUCT_TITLE_LENGTH = 200
const MAX_REQUEST_ID_LENGTH = 200
const MAX_QUESTION_COUNT = 8
const MAX_OPTION_COUNT = 12
const MAX_QUESTION_TEXT_LENGTH = 1_000
const MAX_OPTION_TEXT_LENGTH = 500
const MAX_THREAD_ENTRY_COUNT = 10_000
const MAX_ENTRY_ID_LENGTH = 200
const MAX_TIMESTAMP_LENGTH = 64
const MAX_ATTACHMENT_COUNT = 16
const MAX_ATTACHMENT_NAME_LENGTH = 160
const MAX_ACTIVITY_SUMMARY_LENGTH = 80
const MAX_ACTIVITY_PROGRESS_TOTAL = 10_000
const MAX_RUN_ACTIVITY_COUNT = 256
const MAX_APPROVAL_EXPLANATION_LENGTH = 500
const MAX_PLAN_STEP_COUNT = 100
const MAX_PLAN_STEP_LENGTH = 500

const PRODUCT_TASK_RUN_STATES = new Set<ProductTaskRunState>([
  'idle',
  'working',
  'awaiting_approval',
])
const PRODUCT_TASK_ACTIVITY_KINDS = new Set<ProductTaskActivityKind>([
  'file_read',
  'file_change',
  'workspace',
  'command',
  'research',
  'browser',
  'media',
  'subtask',
  'tool',
])
const PRODUCT_TASK_ACTIVITY_PHASES = new Set<ProductTaskActivityPhase>([
  'started',
  'running',
  'completed',
  'failed',
])
// Activity summaries are product-authored labels.  Do not allow arbitrary
// runtime text through this field: even a generic-looking string could carry
// a Core tool argument, file path, or model message.
const PRODUCT_TASK_ACTIVITY_SUMMARIES = new Set([
  '正在读取工作区内容',
  '已读取工作区内容',
  '工作区内容读取未完成',
  '正在修改工作区内容',
  '已修改工作区内容',
  '工作区内容修改未完成',
  '正在整理任务计划',
  '已整理任务计划',
  '任务计划整理未完成',
  '正在整理工作内容',
  '已整理工作内容',
  '工作内容整理未完成',
  '正在处理任务操作',
  '已完成任务操作',
  '任务操作未完成',
  '正在查询资料',
  '已完成资料查询',
  '资料查询未完成',
  '正在查看网页',
  '已完成网页查看',
  '网页查看未完成',
  '正在处理素材',
  '已完成素材处理',
  '素材处理未完成',
  '正在协同处理事项',
  '已完成协同事项',
  '协同事项未完成',
  '正在处理任务',
  '已完成任务处理',
  '任务处理未完成',
])
const PRODUCT_TASK_APPROVAL_KINDS = new Set<ProductTaskApprovalKind>([
  'action',
  'question',
])
const PRODUCT_TASK_SAFE_ERROR_CODES = new Set<ProductTaskSafeErrorCode>([
  'attachment_ingest_unavailable',
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
  'task_unavailable',
  'input_too_large',
  'protected_input',
  'unsupported_input',
  'temporarily_unavailable',
])
const PRODUCT_TASK_RUN_FAILURE_CODES = new Set<ProductTaskRunFailureCode>([
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
])
const PRODUCT_TASK_RETRYABLE_RUN_FAILURE_CODES = new Set<ProductTaskRunFailureCode>([
  'task_capacity_limited',
  'task_model_unavailable',
  'task_network_unavailable',
  'task_model_response_invalid',
])

function parseRunFailure(value: unknown): ProductTaskRunFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return hasOnlyKeys(record, ['code', 'retryable']) &&
    isEnumValue(record.code, PRODUCT_TASK_RUN_FAILURE_CODES) &&
    typeof record.retryable === 'boolean' &&
    record.retryable === PRODUCT_TASK_RETRYABLE_RUN_FAILURE_CODES.has(record.code)
    ? { code: record.code, retryable: record.retryable }
    : undefined
}
const PRODUCT_TASK_ATTACHMENT_TYPES = new Set<ProductTaskAttachmentSummary['type']>([
  'file',
  'image',
])
const PRODUCT_TASK_IMAGE_MIME_TYPES = new Set<NonNullable<ProductTaskAttachmentSummary['mimeType']>>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

type RecordValue = Record<string, unknown>

const DANGEROUS_PROTOCOL_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function isRecord(value: unknown): value is RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return !hasDangerousProtocolKey(value)
}
function hasDangerousProtocolKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDangerousProtocolKey)
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return true
  for (const key of Object.keys(value as RecordValue)) if (DANGEROUS_PROTOCOL_KEYS.has(key) || hasDangerousProtocolKey((value as RecordValue)[key])) return true
  return false
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return !hasDangerousProtocolKey(value) && Object.keys(value).every((key) => keys.includes(key))
}

function isEnumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  return typeof value === 'string' && allowed.has(value as T)
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isVisibleString(value: unknown, maxLength: number): value is string {
  return isNonEmptyString(value, maxLength) && value.trim().length > 0
}

function isProductActivityId(value: unknown): value is string {
  return typeof value === 'string' && /^activity_[a-f0-9]{32}$/.test(value)
}

function isProductActivitySummary(value: unknown): value is string {
  return isVisibleString(value, MAX_ACTIVITY_SUMMARY_LENGTH) && PRODUCT_TASK_ACTIVITY_SUMMARIES.has(value)
}

function parseActivityProgress(value: unknown): ProductTaskActivityProgress | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['completed', 'total'])) return null
  const completed = value.completed
  const total = value.total
  if (
    typeof completed !== 'number' ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(completed) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    total > MAX_ACTIVITY_PROGRESS_TOTAL ||
    completed < 0 ||
    completed > total
  ) {
    return null
  }
  return { completed, total }
}

function parseRunActivity(value: unknown): ProductTaskRunActivity | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'parentId', 'kind', 'phase', 'summary', 'progress']) ||
    !isProductActivityId(value.id) ||
    !isEnumValue(value.kind, PRODUCT_TASK_ACTIVITY_KINDS) ||
    !isEnumValue(value.phase, PRODUCT_TASK_ACTIVITY_PHASES) ||
    !isProductActivitySummary(value.summary)
  ) {
    return null
  }
  if ('parentId' in value && (!isProductActivityId(value.parentId) || value.parentId === value.id)) {
    return null
  }
  const progress = 'progress' in value ? parseActivityProgress(value.progress) : undefined
  if ('progress' in value && !progress) return null
  return {
    id: value.id,
    ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    kind: value.kind,
    phase: value.phase,
    summary: value.summary,
    ...(progress ? { progress } : {}),
  }
}

function parseTaskPlan(value: unknown): ProductTaskPlan | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'steps']) || typeof value.id !== 'string' || !/^plan_[a-f0-9]{32}$/.test(value.id) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_PLAN_STEP_COUNT) return null
  let inProgress = 0
  const steps: ProductTaskPlanStep[] = []
  for (const candidate of value.steps) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['content', 'status']) || !isVisibleString(candidate.content, MAX_PLAN_STEP_LENGTH) || !isEnumValue(candidate.status, new Set(['pending', 'in_progress', 'completed'] as const))) return null
    if (candidate.status === 'in_progress') inProgress += 1
    steps.push({ content: candidate.content, status: candidate.status })
  }
  return inProgress > 1 ? null : { id: value.id, steps }
}

function parseQuestionOption(value: unknown): ProductTaskQuestionOption | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['label', 'description'])) return null
  if (!isVisibleString(value.label, MAX_OPTION_TEXT_LENGTH)) return null
  if ('description' in value && !isVisibleString(value.description, MAX_OPTION_TEXT_LENGTH)) {
    return null
  }
  return {
    label: value.label,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
  }
}

function parseQuestion(value: unknown): ProductTaskQuestion | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['question', 'header', 'options', 'multiSelect'])) {
    return null
  }
  if (!isVisibleString(value.question, MAX_QUESTION_TEXT_LENGTH)) return null
  if ('header' in value && !isVisibleString(value.header, MAX_OPTION_TEXT_LENGTH)) return null
  if ('multiSelect' in value && typeof value.multiSelect !== 'boolean') return null

  let options: ProductTaskQuestionOption[] | undefined
  if ('options' in value) {
    if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > MAX_OPTION_COUNT) {
      return null
    }
    const parsedOptions = value.options.map(parseQuestionOption)
    if (!parsedOptions.every((option): option is ProductTaskQuestionOption => option !== null)) {
      return null
    }
    options = parsedOptions
  }

  return {
    question: value.question,
    ...(typeof value.header === 'string' ? { header: value.header } : {}),
    ...(options ? { options } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  }
}

function parseQuestions(value: unknown): ProductTaskQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTION_COUNT) return null
  const questions = value.map(parseQuestion)
  return questions.some((question) => question === null)
    ? null
    : questions as ProductTaskQuestion[]
}

function parseActionApproval(value: unknown): ProductTaskActionApproval | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['what', 'scope', 'consequence'])) return null
  if (!isVisibleString(value.what, MAX_APPROVAL_EXPLANATION_LENGTH) ||
    !isVisibleString(value.scope, MAX_APPROVAL_EXPLANATION_LENGTH) ||
    !isVisibleString(value.consequence, MAX_APPROVAL_EXPLANATION_LENGTH)) return null
  return { what: value.what, scope: value.scope, consequence: value.consequence }
}

function parseAttachmentSummary(value: unknown): ProductTaskAttachmentSummary | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['type', 'name', 'mimeType'])) return null
  if (!isEnumValue(value.type, PRODUCT_TASK_ATTACHMENT_TYPES)) return null
  if (!isVisibleString(value.name, MAX_ATTACHMENT_NAME_LENGTH)) return null
  if (
    'mimeType' in value &&
    !isEnumValue(value.mimeType, PRODUCT_TASK_IMAGE_MIME_TYPES)
  ) {
    return null
  }
  if (value.type !== 'image' && 'mimeType' in value) return null

  const mimeType = 'mimeType' in value && isEnumValue(value.mimeType, PRODUCT_TASK_IMAGE_MIME_TYPES)
    ? value.mimeType
    : undefined

  return {
    type: value.type,
    name: value.name,
    ...(mimeType ? { mimeType } : {}),
  }
}

function parseAttachmentSummaries(value: unknown): ProductTaskAttachmentSummary[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENT_COUNT) return null
  const attachments = value.map(parseAttachmentSummary)
  return attachments.some((attachment) => attachment === null)
    ? null
    : attachments as ProductTaskAttachmentSummary[]
}

/**
 * Runtime-validate the browser-facing product event contract.  TypeScript
 * types alone cannot protect the reducer from a malformed socket payload.
 */
export function parseProductTaskEvent(value: unknown): ProductTaskEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  switch (value.type) {
    case 'connected':
      return hasOnlyKeys(value, ['type']) ? { type: 'connected' } : null

    case 'user_text': {
      if (
        !hasOnlyKeys(value, ['type', 'id', 'text', 'replayed', 'event_sequence', 'attachments', 'referenceEntryIds']) ||
        !isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH) ||
        value.replayed !== true ||
        ('id' in value && (typeof value.id !== 'string' || !/^thread_[a-f0-9]{20}$/.test(value.id))) ||
        ('event_sequence' in value && (typeof value.event_sequence !== 'number' || !Number.isSafeInteger(value.event_sequence) || value.event_sequence < 1))
      ) {
        return null
      }
      const attachments = 'attachments' in value
        ? parseAttachmentSummaries(value.attachments)
        : undefined
      if ('attachments' in value && !attachments) return null
      const referenceEntryIds = 'referenceEntryIds' in value && Array.isArray(value.referenceEntryIds)
        && value.referenceEntryIds.length <= 8
        && new Set(value.referenceEntryIds).size === value.referenceEntryIds.length
        && value.referenceEntryIds.every(id => typeof id === 'string' && /^thread_[a-f0-9]{20}$/.test(id))
        ? value.referenceEntryIds as string[]
        : undefined
      if ('referenceEntryIds' in value && !referenceEntryIds) return null
      return {
        type: 'user_text',
        text: value.text,
        replayed: true,
        ...(typeof value.id === 'string' ? { id: value.id } : {}),
        ...(typeof value.event_sequence === 'number' ? { event_sequence: value.event_sequence } : {}),
        ...(attachments ? { attachments } : {}),
        ...(referenceEntryIds?.length ? { referenceEntryIds } : {}),
      }
    }

    case 'resume_cursor':
      return hasOnlyKeys(value, ['type', 'cursor']) && typeof value.cursor === 'number' && Number.isSafeInteger(value.cursor) && value.cursor >= 0
        ? { type: 'resume_cursor', cursor: value.cursor }
        : null

    case 'assistant_text_start':
      return hasOnlyKeys(value, ['type']) ? { type: 'assistant_text_start' } : null

    case 'assistant_text_delta':
      return hasOnlyKeys(value, ['type', 'text']) && isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH)
        ? { type: 'assistant_text_delta', text: value.text }
        : null

    case 'assistant_text':
      return hasOnlyKeys(value, ['type', 'id', 'text', 'replayed', 'event_sequence']) &&
        typeof value.id === 'string' && /^thread_[a-f0-9]{20}$/.test(value.id) &&
        isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH) && value.replayed === true &&
        typeof value.event_sequence === 'number' && Number.isSafeInteger(value.event_sequence) && value.event_sequence > 0
        ? { type: 'assistant_text', id: value.id, text: value.text, replayed: true, event_sequence: value.event_sequence }
        : null

    case 'status':
      return hasOnlyKeys(value, ['type', 'state']) && isEnumValue(value.state, PRODUCT_TASK_RUN_STATES)
        ? { type: 'status', state: value.state }
        : null

    case 'queue_updated': {
      if (
        !hasOnlyKeys(value, ['type', 'item', 'event_sequence', 'replayed']) ||
        typeof value.event_sequence !== 'number' ||
        !Number.isSafeInteger(value.event_sequence) ||
        value.event_sequence < 1 ||
        ('replayed' in value && value.replayed !== true)
      ) return null
      const item = parseProductTaskQueuedInput(value.item)
      return item
        ? {
            type: 'queue_updated',
            item,
            event_sequence: value.event_sequence,
            ...(value.replayed === true ? { replayed: true as const } : {}),
          }
        : null
    }

    case 'context_compaction': {
      if (
        !hasOnlyKeys(value, ['type', 'item', 'event_sequence', 'replayed']) ||
        !isRecord(value.item) ||
        !hasOnlyKeys(value.item, ['id', 'phase', 'source', 'generation']) ||
        typeof value.item.id !== 'string' || !/^compact_[a-f0-9]{32}$/.test(value.item.id) ||
        (value.item.phase !== 'started' && value.item.phase !== 'completed' && value.item.phase !== 'failed') ||
        (value.item.source !== 'automatic' && value.item.source !== 'manual') ||
        typeof value.item.generation !== 'number' || !Number.isSafeInteger(value.item.generation) || value.item.generation < 1 ||
        typeof value.event_sequence !== 'number' || !Number.isSafeInteger(value.event_sequence) || value.event_sequence < 1 ||
        ('replayed' in value && value.replayed !== true)
      ) return null
      return {
        type: 'context_compaction',
        item: {
          id: value.item.id,
          phase: value.item.phase,
          source: value.item.source,
          generation: value.item.generation,
        },
        event_sequence: value.event_sequence,
        ...(value.replayed === true ? { replayed: true as const } : {}),
      }
    }

    case 'run_snapshot': {
      if (
        !hasOnlyKeys(value, ['type', 'state', 'activities', 'plan']) ||
        !isEnumValue(value.state, PRODUCT_TASK_RUN_STATES) ||
        !Array.isArray(value.activities) ||
        value.activities.length > MAX_RUN_ACTIVITY_COUNT
      ) {
        return null
      }
      const activities = value.activities.map(parseRunActivity)
      if (activities.some((activity): activity is null => activity === null)) return null

      const parsedActivities = activities as ProductTaskRunActivity[]
      const activityIds = new Set(parsedActivities.map((activity) => activity.id))
      if (activityIds.size !== parsedActivities.length) return null
      const plan = 'plan' in value ? parseTaskPlan(value.plan) : undefined
      if ('plan' in value && !plan) return null
      return {
        type: 'run_snapshot',
        state: value.state,
        activities: parsedActivities,
        ...(plan ? { plan } : {}),
      }
    }

    case 'assistant_text_snapshot':
      return hasOnlyKeys(value, ['type', 'text']) && typeof value.text === 'string' && value.text.length <= MAX_PRODUCT_TEXT_LENGTH
        ? { type: 'assistant_text_snapshot', text: value.text }
        : null

    case 'plan_updated': {
      if (!hasOnlyKeys(value, ['type', 'plan', 'event_sequence', 'replayed']) || typeof value.event_sequence !== 'number' || !Number.isSafeInteger(value.event_sequence) || value.event_sequence < 1 || ('replayed' in value && value.replayed !== true)) return null
      const plan = parseTaskPlan(value.plan)
      return plan ? { type: 'plan_updated', plan, event_sequence: value.event_sequence, ...(value.replayed === true ? { replayed: true as const } : {}) } : null
    }

    case 'activity': {
      if (
        !hasOnlyKeys(value, ['type', 'kind', 'phase', 'id', 'parentId', 'summary', 'progress', 'event_sequence', 'replayed']) ||
        !isEnumValue(value.kind, PRODUCT_TASK_ACTIVITY_KINDS) ||
        !isEnumValue(value.phase, PRODUCT_TASK_ACTIVITY_PHASES) ||
        !isProductActivityId(value.id) ||
        !isProductActivitySummary(value.summary)
      ) {
        return null
      }
      if ('parentId' in value && (!isProductActivityId(value.parentId) || value.parentId === value.id)) {
        return null
      }
      const progress = 'progress' in value ? parseActivityProgress(value.progress) : undefined
      if ('progress' in value && !progress) return null
      if ('event_sequence' in value && (typeof value.event_sequence !== 'number' || !Number.isSafeInteger(value.event_sequence) || value.event_sequence < 1 || value.replayed !== true)) return null
      if ('replayed' in value && value.replayed !== true) return null
      return {
        type: 'activity',
        id: value.id,
        ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
        kind: value.kind,
        phase: value.phase,
        summary: value.summary,
        ...(progress ? { progress } : {}),
        ...(typeof value.event_sequence === 'number' ? { event_sequence: value.event_sequence, replayed: true as const } : {}),
      }
    }

    case 'run_terminal': {
      const failure = 'failure' in value ? parseRunFailure(value.failure) : undefined
      return hasOnlyKeys(value, ['type', 'id', 'state', 'failure', 'replayed', 'event_sequence']) &&
        typeof value.id === 'string' && /^turn_[a-f0-9]{32}$/.test(value.id) &&
        (value.state === 'completed' || value.state === 'stopped' || value.state === 'recovery_required') &&
        (!('failure' in value) || failure !== undefined) &&
        ((value.state === 'recovery_required') === (failure !== undefined)) &&
        value.replayed === true && typeof value.event_sequence === 'number' && Number.isSafeInteger(value.event_sequence) && value.event_sequence > 0
        ? { type: 'run_terminal', id: value.id, state: value.state, ...(failure ? { failure } : {}), replayed: true, event_sequence: value.event_sequence }
        : null
    }

    case 'approval_required': {
      if (
        !hasOnlyKeys(value, ['type', 'requestId', 'kind', 'questions', 'action']) ||
        !isVisibleString(value.requestId, MAX_REQUEST_ID_LENGTH) ||
        !isEnumValue(value.kind, PRODUCT_TASK_APPROVAL_KINDS)
      ) {
        return null
      }

      const questions = 'questions' in value ? parseQuestions(value.questions) : undefined
      const action = 'action' in value ? parseActionApproval(value.action) : undefined
      if (('questions' in value && !questions) || ('action' in value && !action)) return null

      if (value.kind === 'question') {
        return questions && !action
          ? {
              type: 'approval_required',
              requestId: value.requestId,
              kind: 'question',
              questions,
            }
          : null
      }

      return !questions
        ? { type: 'approval_required', requestId: value.requestId, kind: 'action', ...(action ? { action } : {}) }
        : null
    }

    case 'turn_complete':
      return hasOnlyKeys(value, ['type']) ? { type: 'turn_complete' } : null

    case 'error':
      return hasOnlyKeys(value, ['type', 'code', 'retryable']) &&
        isEnumValue(value.code, PRODUCT_TASK_SAFE_ERROR_CODES) &&
        typeof value.retryable === 'boolean'
        ? { type: 'error', code: value.code, retryable: value.retryable }
        : null

    case 'title_updated':
      return hasOnlyKeys(value, ['type', 'title']) && isVisibleString(value.title, MAX_PRODUCT_TITLE_LENGTH)
        ? { type: 'title_updated', title: value.title }
        : null

    default:
      return null
  }
}

export function parseProductTaskQueuedInput(value: unknown): ProductTaskQueuedInput | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'text', 'state', 'createdAt', 'attachmentCount', 'targetRunId']) ||
    typeof value.id !== 'string' ||
    !/^queue_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) ||
    !isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH) ||
    !isEnumValue(value.state, new Set(['queued', 'injected', 'promoted', 'failed', 'cancelled'] as const)) ||
    !isTimestamp(value.createdAt) ||
    typeof value.attachmentCount !== 'number' ||
    !Number.isSafeInteger(value.attachmentCount) ||
    value.attachmentCount < 0 ||
    value.attachmentCount > MAX_ATTACHMENT_COUNT ||
    ('targetRunId' in value && (typeof value.targetRunId !== 'string' || !/^run_[0-9a-f-]{36}$/.test(value.targetRunId))) ||
    ((value.state === 'injected' || value.state === 'promoted') && !('targetRunId' in value)) ||
    (value.state !== 'queued' && value.state !== 'injected' && value.state !== 'promoted' && 'targetRunId' in value)
  ) return null
  return {
    id: value.id,
    text: value.text,
    state: value.state,
    createdAt: value.createdAt,
    attachmentCount: value.attachmentCount,
    ...(typeof value.targetRunId === 'string' ? { targetRunId: value.targetRunId } : {}),
  }
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value, MAX_TIMESTAMP_LENGTH) && Number.isFinite(Date.parse(value))
}

function parseThreadEntry(value: unknown): ProductTaskThreadEntry | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (!isVisibleString(value.id, MAX_ENTRY_ID_LENGTH) || !isTimestamp(value.createdAt)) return null

  if (value.type === 'user_text') {
    if (
      !hasOnlyKeys(value, ['id', 'type', 'text', 'createdAt', 'attachments', 'referenceEntryIds']) ||
      !isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH)
    ) {
      return null
    }
    const attachments = 'attachments' in value
      ? parseAttachmentSummaries(value.attachments)
      : undefined
    if ('attachments' in value && !attachments) return null
    const referenceEntryIds = 'referenceEntryIds' in value && Array.isArray(value.referenceEntryIds)
      && value.referenceEntryIds.length <= 8
      && new Set(value.referenceEntryIds).size === value.referenceEntryIds.length
      && value.referenceEntryIds.every(id => typeof id === 'string' && /^thread_[a-f0-9]{20}$/.test(id))
      ? value.referenceEntryIds as string[]
      : undefined
    if ('referenceEntryIds' in value && !referenceEntryIds) return null
    return {
      id: value.id,
      type: 'user_text',
      text: value.text,
      createdAt: value.createdAt,
      ...(attachments ? { attachments } : {}),
      ...(referenceEntryIds?.length ? { referenceEntryIds } : {}),
    }
  }

  if (value.type === 'assistant_text') {
    return hasOnlyKeys(value, ['id', 'type', 'text', 'createdAt']) &&
      isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH)
      ? { id: value.id, type: 'assistant_text', text: value.text, createdAt: value.createdAt }
      : null
  }

  if (value.type === 'activity') {
    return hasOnlyKeys(value, ['id', 'type', 'kind', 'phase', 'createdAt']) &&
      isEnumValue(value.kind, PRODUCT_TASK_ACTIVITY_KINDS) &&
      (value.phase === 'completed' || value.phase === 'failed')
      ? {
          id: value.id,
          type: 'activity',
          kind: value.kind,
          phase: value.phase,
          createdAt: value.createdAt,
        }
      : null
  }

  return null
}

/** Validate a task-scoped transcript before it reaches product runtime state. */
export function parseProductTaskThread(value: unknown, taskId: string): ProductTaskThread | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['taskId', 'entries', 'recoveryRequired']) ||
    value.taskId !== taskId ||
    ('recoveryRequired' in value && typeof value.recoveryRequired !== 'boolean') ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_THREAD_ENTRY_COUNT
  ) {
    return null
  }

  const entries = value.entries.map(parseThreadEntry)
  if (entries.some((entry) => entry === null)) return null

  const typedEntries = entries as ProductTaskThreadEntry[]
  const ids = new Set(typedEntries.map((entry) => entry.id))
  if (ids.size !== typedEntries.length) return null

  return { taskId, entries: typedEntries, ...(value.recoveryRequired === true ? { recoveryRequired: true } : {}) }
}


const WORKSPACE_AVAILABILITY = new Set<ProductPublicWorkspace['availability']>([
  'available', 'missing', 'read_only', 'identity_changed', 'relink_required',
])
const DRAFT_STATES = new Set<ProductPublicComposerDraft['state']>(['active', 'consumed', 'expired'])
const LINEAGE_STATES = new Set<ProductPublicConversationLineage['state']>(['active', 'parked', 'recovery_required'])
const OPERATION_OUTCOMES = new Set<ProductPublicOperationReceipt['outcome']>(['accepted', 'replayed'])

function isNonNegativeRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Parses the path-free renderer workspace projection and rejects server internals. */
export function parseProductPublicWorkspace(value: unknown): ProductPublicWorkspace | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['workspace_id', 'revision', 'availability', 'created_at', 'updated_at']) ||
    !isVisibleString(value.workspace_id, 200) || !isNonNegativeRevision(value.revision) ||
    !isEnumValue(value.availability, WORKSPACE_AVAILABILITY) || !isTimestamp(value.created_at) || !isTimestamp(value.updated_at)) return null
  return { workspace_id: value.workspace_id, revision: value.revision, availability: value.availability, created_at: value.created_at, updated_at: value.updated_at }
}

export function parseProductPublicOperationReceipt(value: unknown): ProductPublicOperationReceipt | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['outcome', 'revision']) || !isEnumValue(value.outcome, OPERATION_OUTCOMES) || !isNonNegativeRevision(value.revision)) return null
  return { outcome: value.outcome, revision: value.revision }
}

export function parseProductPublicComposerDraft(value: unknown): ProductPublicComposerDraft | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['draft_id', 'workspace_id', 'target_task_id', 'revision', 'last_activity', 'state', 'created_at', 'expires_at']) ||
    !isVisibleString(value.draft_id, 200) || !isVisibleString(value.target_task_id, 200) || !isNonNegativeRevision(value.revision) ||
    !isTimestamp(value.last_activity) || !isEnumValue(value.state, DRAFT_STATES) || !isTimestamp(value.created_at) || !isTimestamp(value.expires_at) ||
    ('workspace_id' in value && !isVisibleString(value.workspace_id, 200))) return null
  return { draft_id: value.draft_id, target_task_id: value.target_task_id, ...(typeof value.workspace_id === 'string' ? { workspace_id: value.workspace_id } : {}), revision: value.revision, last_activity: value.last_activity, state: value.state, created_at: value.created_at, expires_at: value.expires_at }
}

export function parseProductPublicConversationLineage(value: unknown): ProductPublicConversationLineage | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['lineage_id', 'product_task_id', 'parent_lineage_id', 'fork_checkpoint_id', 'head_entry_id', 'revision', 'compact_generation', 'state', 'created_at', 'updated_at']) ||
    !isVisibleString(value.lineage_id, 200) || !isVisibleString(value.product_task_id, 200) || !isNonNegativeRevision(value.revision) || !isNonNegativeRevision(value.compact_generation) ||
    !isEnumValue(value.state, LINEAGE_STATES) || !isTimestamp(value.created_at) || !isTimestamp(value.updated_at) ||
    ['parent_lineage_id', 'fork_checkpoint_id', 'head_entry_id'].some((key) => key in value && !isVisibleString(value[key], 200))) return null
  return { lineage_id: value.lineage_id, product_task_id: value.product_task_id, ...(typeof value.parent_lineage_id === 'string' ? { parent_lineage_id: value.parent_lineage_id } : {}), ...(typeof value.fork_checkpoint_id === 'string' ? { fork_checkpoint_id: value.fork_checkpoint_id } : {}), ...(typeof value.head_entry_id === 'string' ? { head_entry_id: value.head_entry_id } : {}), revision: value.revision, compact_generation: value.compact_generation, state: value.state, created_at: value.created_at, updated_at: value.updated_at }
}


const ATTACHMENT_OUTCOMES = new Set<ProductAttachmentOperationResult['outcome']>(['accepted', 'duplicate', 'conflict', 'rejected'])
/** Validates only opaque attachment operation outcomes; content metadata never enters renderer state. */
export function parseProductAttachmentOperationResult(value: unknown): ProductAttachmentOperationResult | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['authority_revision', 'attachment_revision', 'outcome']) || !isNonNegativeRevision(value.authority_revision) || !isNonNegativeRevision(value.attachment_revision) || !isEnumValue(value.outcome, ATTACHMENT_OUTCOMES)) return null
  return { authority_revision: value.authority_revision, attachment_revision: value.attachment_revision, outcome: value.outcome }
}
