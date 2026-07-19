import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskComputerUseApproval,
  ProductTaskComputerUseCapability,
  ProductTaskEvent,
  ProductTaskQuestion,
  ProductTaskQuestionOption,
  ProductTaskRunState,
  ProductTaskSafeErrorCode,
} from '../../../shared/product/taskEvents.js'
import type {
  ChatState,
  ComputerUsePermissionRequest,
  ServerMessage,
} from '../ws/events.js'
import { projectProductTaskUserReplay } from './taskAttachmentProjection.js'

type RecordValue = Record<string, unknown>

const MAX_QUESTION_COUNT = 8
const MAX_OPTION_COUNT = 12
const MAX_QUESTION_TEXT_LENGTH = 1_000
const MAX_OPTION_TEXT_LENGTH = 500
const MAX_TITLE_LENGTH = 200
const MAX_COMPUTER_USE_APP_COUNT = 24
const MAX_COMPUTER_USE_APP_NAME_LENGTH = 120

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function visibleString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLength)
}

function statusForCoreState(state: ChatState): ProductTaskRunState {
  if (state === 'idle') return 'idle'
  if (state === 'permission_pending') return 'awaiting_approval'
  return 'working'
}

export function productTaskActivityKindForTool(toolName: string | undefined): ProductTaskActivityKind {
  const normalized = toolName?.trim().toLowerCase() ?? ''
  if (!normalized) return 'tool'

  if (/^(read|write|edit|glob|grep|ls|notebookedit|todowrite)/.test(normalized)) {
    return 'workspace'
  }
  if (/(bash|shell|terminal|killshell|taskoutput|command)/.test(normalized)) {
    return 'command'
  }
  if (/(websearch|webfetch|search|fetch)/.test(normalized)) {
    return 'research'
  }
  if (/(browser|computer|playwright|preview)/.test(normalized)) {
    return 'browser'
  }
  if (/(image|video|media|ffmpeg)/.test(normalized)) {
    return 'media'
  }
  if (/(task|agent|team)/.test(normalized)) {
    return 'subtask'
  }
  return 'tool'
}

function projectQuestionOptions(value: unknown): ProductTaskQuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined

  const options: ProductTaskQuestionOption[] = []
  for (const candidate of value) {
    if (options.length >= MAX_OPTION_COUNT || !isRecord(candidate)) continue
    const label = visibleString(candidate.label, MAX_OPTION_TEXT_LENGTH)
    if (!label) continue
    const description = visibleString(candidate.description, MAX_OPTION_TEXT_LENGTH)
    options.push({
      label,
      ...(description ? { description } : {}),
    })
  }
  return options.length > 0 ? options : undefined
}

function projectQuestion(value: unknown): ProductTaskQuestion | null {
  if (!isRecord(value)) return null
  const question = visibleString(value.question, MAX_QUESTION_TEXT_LENGTH)
  if (!question) return null
  const header = visibleString(value.header, MAX_OPTION_TEXT_LENGTH)
  const options = projectQuestionOptions(value.options)
  return {
    question,
    ...(header ? { header } : {}),
    ...(options ? { options } : {}),
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  }
}

function isBundleIdentifierLike(value: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,}$/.test(value)
}

/**
 * A Computer Use request can carry a model-provided app selector. Product
 * surfaces only show a human-readable name; raw selectors may be bundle IDs,
 * local paths, or otherwise internal implementation values.
 */
function projectComputerUseAppName(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const name = visibleString(candidate, MAX_COMPUTER_USE_APP_NAME_LENGTH)
    if (
      name &&
      !name.includes('/') &&
      !name.includes('\\') &&
      !/^file:/i.test(name) &&
      !isBundleIdentifierLike(name)
    ) {
      return name
    }
  }
  return '请求的应用'
}

function projectComputerUseCapabilities(
  requestedFlags: ComputerUsePermissionRequest['requestedFlags'],
): ProductTaskComputerUseCapability[] {
  const capabilities: ProductTaskComputerUseCapability[] = []
  if (requestedFlags.clipboardRead === true) capabilities.push('clipboard_read')
  if (requestedFlags.clipboardWrite === true) capabilities.push('clipboard_write')
  if (requestedFlags.systemKeyCombos === true) capabilities.push('system_key_combos')
  return capabilities
}

/**
 * Keep Computer Use approval useful without exposing the legacy desktop
 * request. In particular, omit the reason, bundle IDs, paths, icon payloads,
 * screenshot implementation, hide previews, and every raw tool field.
 */
export function projectComputerUseApprovalForProductTask(
  request: ComputerUsePermissionRequest,
): ProductTaskComputerUseApproval {
  const apps = request.apps.slice(0, MAX_COMPUTER_USE_APP_COUNT).map((app) => ({
    name: projectComputerUseAppName(app.resolved?.displayName, app.requestedName),
    tier: app.proposedTier,
    alreadyAuthorized: app.alreadyGranted === true,
  }))
  const systemPermissions = request.tccState && (
    !request.tccState.accessibility || !request.tccState.screenRecording
  )
    ? {
        accessibilityRequired: !request.tccState.accessibility,
        screenRecordingRequired: !request.tccState.screenRecording,
      }
    : undefined

  return {
    apps,
    capabilities: projectComputerUseCapabilities(request.requestedFlags),
    ...(systemPermissions ? { systemPermissions } : {}),
  }
}

/**
 * Extract only the explicit question fields an AskUserQuestion card needs.
 * Unknown keys in the Agent Core tool input are intentionally discarded.
 */
export function projectAskUserQuestions(input: unknown): ProductTaskQuestion[] {
  if (!isRecord(input)) return []

  const candidates = Array.isArray(input.questions)
    ? input.questions
    : [input]
  const questions: ProductTaskQuestion[] = []
  for (const candidate of candidates) {
    if (questions.length >= MAX_QUESTION_COUNT) break
    const question = projectQuestion(candidate)
    if (question) questions.push(question)
  }
  return questions
}

/**
 * Use this variant for a live product approval. Every question key must be
 * reproduced exactly, otherwise the server cannot safely synthesize the Core
 * answers object from browser-provided ordered answers.
 */
export function projectAnswerableAskUserQuestions(input: unknown): ProductTaskQuestion[] {
  if (!isRecord(input)) return []

  const candidates = Array.isArray(input.questions)
    ? input.questions
    : [input]
  if (candidates.length === 0 || candidates.length > MAX_QUESTION_COUNT) return []

  const answerKeys = new Set<string>()
  const questions: ProductTaskQuestion[] = []
  for (const candidate of candidates) {
    if (!isRecord(candidate) || typeof candidate.question !== 'string') return []
    const projected = projectQuestion(candidate)
    if (
      !projected ||
      projected.question !== candidate.question ||
      answerKeys.has(candidate.question)
    ) {
      return []
    }
    answerKeys.add(candidate.question)
    questions.push(projected)
  }
  return questions
}

function activity(phase: ProductTaskActivityPhase, toolName?: string): ProductTaskEvent {
  return {
    type: 'activity',
    kind: productTaskActivityKindForTool(toolName),
    phase,
  }
}

function notificationActivityPhase(data: unknown): ProductTaskActivityPhase {
  if (!isRecord(data)) return 'completed'
  switch (data.status) {
    case 'failed':
      return 'failed'
    case 'running':
    case 'in_progress':
      return 'running'
    case 'completed':
    case 'stopped':
      return 'completed'
    default:
      return 'completed'
  }
}

function taskUpdateActivityPhase(status: string): ProductTaskActivityPhase {
  switch (status) {
    case 'failed':
    case 'error':
      return 'failed'
    case 'running':
    case 'in_progress':
      return 'running'
    default:
      return 'completed'
  }
}

function safeErrorCode(message: Extract<ServerMessage, { type: 'error' }>): ProductTaskSafeErrorCode {
  switch (message.businessErrorCode) {
    case 'pdf_too_large':
    case 'image_too_large':
    case 'request_too_large':
    case 'prompt_too_long':
      return 'input_too_large'
    case 'pdf_password_protected':
      return 'protected_input'
    case 'pdf_invalid':
    case 'image_unsupported':
      return 'unsupported_input'
    case 'auto_mode_unavailable':
      return 'temporarily_unavailable'
  }

  switch (message.code) {
    case 'CLI_NOT_RUNNING':
    case 'CLI_START_FAILED':
    case 'SESSION_DELETED':
      return 'task_unavailable'
    case 'CLI_RESTART_FAILED':
      return 'temporarily_unavailable'
    default:
      return 'task_failed'
  }
}

/**
 * Project one Agent Core websocket message into the narrow product stream.
 *
 * This function is intentionally a whitelist.  Adding a new core event does
 * not expose it to the product renderer until it receives an explicit branch
 * here and a focused test.
 */
export function projectServerMessageForProductTask(message: ServerMessage): ProductTaskEvent[] {
  switch (message.type) {
    case 'connected':
      return [{ type: 'connected' }]

    case 'user_message_replay': {
      const projected = projectProductTaskUserReplay(
        message.content,
        message.attachments,
      )
      return projected
        ? [{
            type: 'user_text',
            text: projected.text,
            replayed: true,
            ...(projected.attachments.length > 0 ? { attachments: projected.attachments } : {}),
          }]
        : []
    }

    case 'status':
      return [{ type: 'status', state: statusForCoreState(message.state) }]

    case 'thinking':
      return [{ type: 'status', state: 'working' }]

    case 'content_start':
      return message.blockType === 'text'
        ? [{ type: 'assistant_text_start' }]
        : [activity('started', message.toolName)]

    case 'content_delta':
      return typeof message.text === 'string' && message.text.length > 0
        ? [{ type: 'assistant_text_delta', text: message.text }]
        : []

    case 'tool_use_complete':
      return [activity('running', message.toolName)]

    case 'tool_result':
      return [activity(message.isError ? 'failed' : 'completed')]

    case 'permission_request': {
      const questions = message.toolName === 'AskUserQuestion'
        ? projectAnswerableAskUserQuestions(message.input)
        : []
      if (message.toolName === 'AskUserQuestion' && questions.length === 0) return []
      return questions.length > 0
        ? [{
            type: 'approval_required',
            requestId: message.requestId,
            kind: 'question',
            questions,
          }]
        : [{
            type: 'approval_required',
            requestId: message.requestId,
            kind: 'action',
          }]
    }

    case 'computer_use_permission_request':
      // The request ID is server-owned pending state. A mismatched event can
      // never be answered safely, so suppress it rather than creating a UI
      // card that could target a different approval.
      if (message.request.requestId !== message.requestId) return []
      return [{
        type: 'approval_required',
        requestId: message.requestId,
        kind: 'computer_use',
        computerUse: projectComputerUseApprovalForProductTask(message.request),
      }]

    case 'message_complete':
      return [
        { type: 'status', state: 'idle' },
        { type: 'turn_complete' },
      ]

    case 'api_retry':
    case 'streaming_fallback':
      return [{ type: 'status', state: 'working' }]

    case 'error':
      return [{
        type: 'error',
        code: safeErrorCode(message),
        retryable: message.retryable === true,
      }]

    case 'system_notification':
      switch (message.subtype) {
        case 'task_started':
          return [{ type: 'activity', kind: 'subtask', phase: 'started' }]
        case 'task_progress':
          return [{ type: 'activity', kind: 'subtask', phase: 'running' }]
        case 'task_notification':
          return [{
            type: 'activity',
            kind: 'subtask',
            phase: notificationActivityPhase(message.data),
          }]
        case 'compact_boundary':
        case 'compact_summary':
          return [{ type: 'status', state: 'working' }]
        default:
          return []
      }

    case 'team_created':
      return [{ type: 'activity', kind: 'subtask', phase: 'started' }]

    case 'team_update': {
      const phase = message.members.some((member) => member.status === 'error')
        ? 'failed'
        : message.members.some((member) => member.status === 'running')
          ? 'running'
          : 'completed'
      return [{ type: 'activity', kind: 'subtask', phase }]
    }

    case 'team_deleted':
      return [{ type: 'activity', kind: 'subtask', phase: 'completed' }]

    case 'task_update':
      return [{
        type: 'activity',
        kind: 'subtask',
        phase: taskUpdateActivityPhase(message.status),
      }]

    case 'session_title_updated': {
      const title = visibleString(message.title, MAX_TITLE_LENGTH)
      return title ? [{ type: 'title_updated', title }] : []
    }

    // Runtime configuration, permission modes, internal notifications and
    // usage metadata intentionally have no product-stream representation.
    case 'permission_mode_changed':
    case 'pong':
      return []
  }
}

export function projectServerMessagesForProductTask(
  messages: readonly ServerMessage[],
): ProductTaskEvent[] {
  return messages.flatMap(projectServerMessageForProductTask)
}
