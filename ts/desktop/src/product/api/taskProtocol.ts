import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
  ProductTaskAttachmentSummary,
  ProductTaskApprovalKind,
  ProductTaskComputerUseApp,
  ProductTaskComputerUseApproval,
  ProductTaskComputerUseCapability,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskRunState,
  ProductTaskSafeErrorCode,
  ProductTaskThread,
  ProductTaskThreadEntry,
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
const MAX_COMPUTER_USE_APP_COUNT = 24
const MAX_COMPUTER_USE_APP_NAME_LENGTH = 120
const MAX_ACTIVITY_SUMMARY_LENGTH = 80
const MAX_ACTIVITY_PROGRESS_TOTAL = 10_000

const PRODUCT_TASK_RUN_STATES = new Set<ProductTaskRunState>([
  'idle',
  'working',
  'awaiting_approval',
])
const PRODUCT_TASK_ACTIVITY_KINDS = new Set<ProductTaskActivityKind>([
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
  'computer_use',
])
const PRODUCT_TASK_COMPUTER_USE_TIERS = new Set<ProductTaskComputerUseApp['tier']>([
  'read',
  'click',
  'full',
])
const PRODUCT_TASK_COMPUTER_USE_CAPABILITIES = new Set<ProductTaskComputerUseCapability>([
  'clipboard_read',
  'clipboard_write',
  'system_key_combos',
])
const PRODUCT_TASK_SAFE_ERROR_CODES = new Set<ProductTaskSafeErrorCode>([
  'task_failed',
  'task_unavailable',
  'input_too_large',
  'protected_input',
  'unsupported_input',
  'temporarily_unavailable',
])
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

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: RecordValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
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

function isBundleIdentifierLike(value: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,}$/.test(value)
}

function isSafeComputerUseAppName(value: unknown): value is string {
  return isVisibleString(value, MAX_COMPUTER_USE_APP_NAME_LENGTH) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/^file:/i.test(value) &&
    !isBundleIdentifierLike(value)
}

function parseComputerUseApp(value: unknown): ProductTaskComputerUseApp | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'tier', 'alreadyAuthorized'])) return null
  if (
    !isSafeComputerUseAppName(value.name) ||
    !isEnumValue(value.tier, PRODUCT_TASK_COMPUTER_USE_TIERS) ||
    typeof value.alreadyAuthorized !== 'boolean'
  ) {
    return null
  }
  return {
    name: value.name,
    tier: value.tier,
    alreadyAuthorized: value.alreadyAuthorized,
  }
}

function parseComputerUseApproval(value: unknown): ProductTaskComputerUseApproval | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['apps', 'capabilities', 'systemPermissions'])) {
    return null
  }
  if (!Array.isArray(value.apps) || value.apps.length > MAX_COMPUTER_USE_APP_COUNT) return null
  if (!Array.isArray(value.capabilities) || value.capabilities.length > PRODUCT_TASK_COMPUTER_USE_CAPABILITIES.size) {
    return null
  }

  const apps = value.apps.map(parseComputerUseApp)
  if (apps.some((app): app is null => app === null)) return null
  const capabilities = value.capabilities
  if (
    !capabilities.every((capability) => isEnumValue(capability, PRODUCT_TASK_COMPUTER_USE_CAPABILITIES)) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    return null
  }

  let systemPermissions: ProductTaskComputerUseApproval['systemPermissions']
  if ('systemPermissions' in value) {
    const permissions = value.systemPermissions
    if (
      !isRecord(permissions) ||
      !hasOnlyKeys(permissions, ['accessibilityRequired', 'screenRecordingRequired']) ||
      typeof permissions.accessibilityRequired !== 'boolean' ||
      typeof permissions.screenRecordingRequired !== 'boolean' ||
      (!permissions.accessibilityRequired && !permissions.screenRecordingRequired)
    ) {
      return null
    }
    systemPermissions = {
      accessibilityRequired: permissions.accessibilityRequired,
      screenRecordingRequired: permissions.screenRecordingRequired,
    }
  }

  return {
    apps: apps as ProductTaskComputerUseApp[],
    capabilities: capabilities as ProductTaskComputerUseCapability[],
    ...(systemPermissions ? { systemPermissions } : {}),
  }
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
        !hasOnlyKeys(value, ['type', 'text', 'replayed', 'attachments']) ||
        !isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH) ||
        value.replayed !== true
      ) {
        return null
      }
      const attachments = 'attachments' in value
        ? parseAttachmentSummaries(value.attachments)
        : undefined
      if ('attachments' in value && !attachments) return null
      return {
        type: 'user_text',
        text: value.text,
        replayed: true,
        ...(attachments ? { attachments } : {}),
      }
    }

    case 'assistant_text_start':
      return hasOnlyKeys(value, ['type']) ? { type: 'assistant_text_start' } : null

    case 'assistant_text_delta':
      return hasOnlyKeys(value, ['type', 'text']) && isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH)
        ? { type: 'assistant_text_delta', text: value.text }
        : null

    case 'status':
      return hasOnlyKeys(value, ['type', 'state']) && isEnumValue(value.state, PRODUCT_TASK_RUN_STATES)
        ? { type: 'status', state: value.state }
        : null

    case 'activity': {
      if (
        !hasOnlyKeys(value, ['type', 'kind', 'phase', 'id', 'parentId', 'summary', 'progress']) ||
        !isEnumValue(value.kind, PRODUCT_TASK_ACTIVITY_KINDS) ||
        !isEnumValue(value.phase, PRODUCT_TASK_ACTIVITY_PHASES)
      ) {
        return null
      }

      // Keep the legacy flat activity envelope readable while migration is in
      // flight.  The richer activity tree is all-or-nothing, so a malformed
      // ID cannot smuggle arbitrary auxiliary fields into the renderer.
      if (!('id' in value)) {
        return !('parentId' in value) && !('summary' in value) && !('progress' in value)
          ? { type: 'activity', kind: value.kind, phase: value.phase }
          : null
      }
      if (!isProductActivityId(value.id) || !isProductActivitySummary(value.summary)) return null
      if ('parentId' in value && (!isProductActivityId(value.parentId) || value.parentId === value.id)) {
        return null
      }
      const progress = 'progress' in value ? parseActivityProgress(value.progress) : undefined
      if ('progress' in value && !progress) return null
      return {
        type: 'activity',
        id: value.id,
        ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
        kind: value.kind,
        phase: value.phase,
        summary: value.summary,
        ...(progress ? { progress } : {}),
      }
    }

    case 'approval_required': {
      if (
        !hasOnlyKeys(value, ['type', 'requestId', 'kind', 'questions', 'computerUse']) ||
        !isVisibleString(value.requestId, MAX_REQUEST_ID_LENGTH) ||
        !isEnumValue(value.kind, PRODUCT_TASK_APPROVAL_KINDS)
      ) {
        return null
      }

      const questions = 'questions' in value ? parseQuestions(value.questions) : undefined
      const computerUse = 'computerUse' in value
        ? parseComputerUseApproval(value.computerUse)
        : undefined
      if (('questions' in value && !questions) || ('computerUse' in value && !computerUse)) return null

      if (value.kind === 'question') {
        return questions && !computerUse
          ? {
              type: 'approval_required',
              requestId: value.requestId,
              kind: 'question',
              questions,
            }
          : null
      }

      if (value.kind === 'computer_use') {
        return computerUse && !questions
          ? {
              type: 'approval_required',
              requestId: value.requestId,
              kind: 'computer_use',
              computerUse,
            }
          : null
      }

      return !questions && !computerUse
        ? { type: 'approval_required', requestId: value.requestId, kind: 'action' }
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

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value, MAX_TIMESTAMP_LENGTH) && Number.isFinite(Date.parse(value))
}

function parseThreadEntry(value: unknown): ProductTaskThreadEntry | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (!isVisibleString(value.id, MAX_ENTRY_ID_LENGTH) || !isTimestamp(value.createdAt)) return null

  if (value.type === 'user_text') {
    if (
      !hasOnlyKeys(value, ['id', 'type', 'text', 'createdAt', 'attachments']) ||
      !isNonEmptyString(value.text, MAX_PRODUCT_TEXT_LENGTH)
    ) {
      return null
    }
    const attachments = 'attachments' in value
      ? parseAttachmentSummaries(value.attachments)
      : undefined
    if ('attachments' in value && !attachments) return null
    return {
      id: value.id,
      type: 'user_text',
      text: value.text,
      createdAt: value.createdAt,
      ...(attachments ? { attachments } : {}),
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
    !hasOnlyKeys(value, ['taskId', 'entries']) ||
    value.taskId !== taskId ||
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

  return { taskId, entries: typedEntries }
}
