import { createHmac, randomBytes } from 'node:crypto'
import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
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
const MAX_ACTIVITY_SOURCE_LENGTH = 512
const DEFAULT_MAX_TRACKED_ACTIVITIES = 256
const MAX_TRACKED_ACTIVITIES = 1_024
// Kept only in the server process. This makes identifiers opaque even when a
// Core source ID has a predictable shape, while reconnects to the same server
// continue to derive the same activity identity.
const ACTIVITY_ID_SECRET = randomBytes(32)

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
 * Keep Computer Use approval useful without exposing the raw desktop
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

type ProductTaskActivityEvent = Extract<ProductTaskEvent, { type: 'activity' }>

type TrackedToolActivity = {
  kind: ProductTaskActivityKind
  parentId?: string
  planRelated: boolean
}

export type ProductTaskRunActivityProjectorOptions = {
  /**
   * Number of recently observed tool identities retained to enrich a later
   * result event. The cache is bounded and contains Core identifiers only in
   * server memory; none are included in the projected event.
   */
  maxTrackedActivities?: number
}

function opaqueSource(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACTIVITY_SOURCE_LENGTH ||
    value.trim() !== value
  ) {
    return null
  }
  return value
}

function completedProgress(total: number, completed: number): ProductTaskActivityProgress | undefined {
  if (
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(completed) ||
    total < 1 ||
    completed < 0 ||
    completed > total
  ) {
    return undefined
  }
  return { completed, total }
}

function isPlanRelatedTool(toolName: unknown): boolean {
  if (typeof toolName !== 'string') return false
  switch (toolName.trim().toLowerCase()) {
    case 'enterplanmode':
    case 'exitplanmode':
    case 'todowrite':
      return true
    default:
      return false
  }
}

function activitySummary(
  kind: ProductTaskActivityKind,
  phase: ProductTaskActivityPhase,
  planRelated = false,
): string {
  if (planRelated) {
    switch (phase) {
      case 'started':
      case 'running':
        return '正在整理任务计划'
      case 'completed':
        return '已整理任务计划'
      case 'failed':
        return '任务计划整理未完成'
    }
  }

  const wording: Record<ProductTaskActivityKind, {
    active: string
    completed: string
    failed: string
  }> = {
    workspace: { active: '正在整理工作内容', completed: '已整理工作内容', failed: '工作内容整理未完成' },
    command: { active: '正在处理任务操作', completed: '已完成任务操作', failed: '任务操作未完成' },
    research: { active: '正在查询资料', completed: '已完成资料查询', failed: '资料查询未完成' },
    browser: { active: '正在查看网页', completed: '已完成网页查看', failed: '网页查看未完成' },
    media: { active: '正在处理素材', completed: '已完成素材处理', failed: '素材处理未完成' },
    subtask: { active: '正在协同处理事项', completed: '已完成协同事项', failed: '协同事项未完成' },
    tool: { active: '正在处理任务', completed: '已完成任务处理', failed: '任务处理未完成' },
  }
  switch (phase) {
    case 'started':
    case 'running':
      return wording[kind].active
    case 'completed':
      return wording[kind].completed
    case 'failed':
      return wording[kind].failed
  }
}

function strictTaskActivityPhase(status: unknown): ProductTaskActivityPhase | null {
  switch (status) {
    case 'pending':
      return 'started'
    case 'running':
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    default:
      return null
  }
}

function backgroundTaskIdentity(data: unknown): {
  taskId: string
  parentToolUseId?: string
  status?: string
} | null {
  if (!isRecord(data)) return null
  const taskId = opaqueSource(data.task_id)
  if (!taskId) return null
  const parentToolUseId = opaqueSource(data.tool_use_id) ?? undefined
  const status = typeof data.status === 'string' ? data.status : undefined
  return {
    taskId,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(status ? { status } : {}),
  }
}

/**
 * Projects Core execution events into activity records suitable for a product
 * run timeline. It intentionally has a separate entry point from
 * `projectServerMessageForProductTask`: that generic safe projection omits
 * activity messages entirely, while this projector gives live activity a
 * stable opaque identity and product-authored summary.
 *
 * A caller must construct one instance with the persistent product task ID
 * and reuse that ID after reconnect. IDs are deterministic HMAC digests scoped
 * to that product task for the life of this server process, never raw Core
 * tool, team, task, or session identifiers.
 */
export class ProductTaskRunActivityProjector {
  private readonly identityScope: string
  private readonly maxTrackedActivities: number
  private readonly trackedTools = new Map<string, TrackedToolActivity>()

  constructor(productTaskId: string, options: ProductTaskRunActivityProjectorOptions = {}) {
    const identityScope = opaqueSource(productTaskId)
    if (!identityScope) {
      throw new TypeError('A bounded product task ID is required for activity projection')
    }
    const maxTrackedActivities = options.maxTrackedActivities ?? DEFAULT_MAX_TRACKED_ACTIVITIES
    if (
      !Number.isSafeInteger(maxTrackedActivities) ||
      maxTrackedActivities < 1 ||
      maxTrackedActivities > MAX_TRACKED_ACTIVITIES
    ) {
      throw new RangeError('maxTrackedActivities must be a safe bounded integer')
    }
    this.identityScope = identityScope
    this.maxTrackedActivities = maxTrackedActivities
  }

  project(message: ServerMessage): ProductTaskEvent[] {
    switch (message.type) {
      case 'content_start':
        return message.blockType === 'tool_use'
          ? this.projectToolStart(message)
          : projectServerMessageForProductTask(message)

      case 'tool_use_complete':
        return this.projectToolRunning(message)

      case 'tool_result':
        return this.projectToolResult(message)

      case 'system_notification':
        return this.projectSystemActivity(message)

      case 'team_created':
        return this.projectTeamCreated(message)

      case 'team_update':
        return this.projectTeamUpdate(message)

      case 'team_deleted':
        // Deleting a team does not prove that its work completed, so avoid
        // inventing a terminal activity from this lifecycle-only signal.
        return []

      case 'task_update':
        return this.projectTaskUpdate(message)

      default:
        return projectServerMessageForProductTask(message)
    }
  }

  projectMany(messages: readonly ServerMessage[]): ProductTaskEvent[] {
    return messages.flatMap((message) => this.project(message))
  }

  private opaqueActivityId(sourceType: 'tool' | 'team' | 'task', source: string): string {
    const digest = createHmac('sha256', ACTIVITY_ID_SECRET)
      .update('billiardbuddy.product-task.activity.v1\0')
      .update(this.identityScope)
      .update('\0')
      .update(sourceType)
      .update('\0')
      .update(source)
      .digest('hex')
      .slice(0, 32)
    return `activity_${digest}`
  }

  private parentActivityId(rawParentId: unknown, childId: string): string | undefined {
    const parentSource = opaqueSource(rawParentId)
    if (!parentSource) return undefined
    const parentId = this.opaqueActivityId('tool', parentSource)
    return parentId === childId ? undefined : parentId
  }

  private rememberTool(rawToolId: string, activity: TrackedToolActivity): void {
    // Refreshing the key makes this a small LRU-style cache rather than an
    // unbounded log of Core tool IDs.
    this.trackedTools.delete(rawToolId)
    this.trackedTools.set(rawToolId, activity)
    while (this.trackedTools.size > this.maxTrackedActivities) {
      const oldest = this.trackedTools.keys().next().value
      if (typeof oldest !== 'string') break
      this.trackedTools.delete(oldest)
    }
  }

  private productActivity(
    sourceType: 'tool' | 'team' | 'task',
    source: string,
    kind: ProductTaskActivityKind,
    phase: ProductTaskActivityPhase,
    options: {
      parentToolUseId?: unknown
      parentId?: string
      planRelated?: boolean
      progress?: ProductTaskActivityProgress
    } = {},
  ): ProductTaskActivityEvent {
    const id = this.opaqueActivityId(sourceType, source)
    const parentId = options.parentId ?? this.parentActivityId(options.parentToolUseId, id)
    return {
      type: 'activity',
      id,
      ...(parentId ? { parentId } : {}),
      kind,
      phase,
      summary: activitySummary(kind, phase, options.planRelated === true),
      ...(options.progress ? { progress: options.progress } : {}),
    }
  }

  private projectToolStart(message: Extract<ServerMessage, { type: 'content_start' }>): ProductTaskEvent[] {
    const toolUseId = opaqueSource(message.toolUseId)
    if (!toolUseId) return []
    const kind = productTaskActivityKindForTool(message.toolName)
    const activity = this.productActivity('tool', toolUseId, kind, 'started', {
      parentToolUseId: message.parentToolUseId,
      planRelated: isPlanRelatedTool(message.toolName),
    })
    this.rememberTool(toolUseId, {
      kind,
      ...(activity.parentId ? { parentId: activity.parentId } : {}),
      planRelated: isPlanRelatedTool(message.toolName),
    })
    return [activity]
  }

  private projectToolRunning(message: Extract<ServerMessage, { type: 'tool_use_complete' }>): ProductTaskEvent[] {
    const toolUseId = opaqueSource(message.toolUseId)
    if (!toolUseId) return []
    const kind = productTaskActivityKindForTool(message.toolName)
    const activity = this.productActivity('tool', toolUseId, kind, 'running', {
      parentToolUseId: message.parentToolUseId,
      planRelated: isPlanRelatedTool(message.toolName),
    })
    this.rememberTool(toolUseId, {
      kind,
      ...(activity.parentId ? { parentId: activity.parentId } : {}),
      planRelated: isPlanRelatedTool(message.toolName),
    })
    return [activity]
  }

  private projectToolResult(message: Extract<ServerMessage, { type: 'tool_result' }>): ProductTaskEvent[] {
    const toolUseId = opaqueSource(message.toolUseId)
    if (!toolUseId) return []
    const tracked = this.trackedTools.get(toolUseId)
    const id = this.opaqueActivityId('tool', toolUseId)
    const explicitParentId = this.parentActivityId(message.parentToolUseId, id)
    return [this.productActivity(
      'tool',
      toolUseId,
      tracked?.kind ?? 'tool',
      message.isError === true ? 'failed' : 'completed',
      {
        ...(explicitParentId
          ? { parentId: explicitParentId }
          : tracked?.parentId
            ? { parentId: tracked.parentId }
            : {}),
        planRelated: tracked?.planRelated === true,
      },
    )]
  }

  private projectSystemActivity(
    message: Extract<ServerMessage, { type: 'system_notification' }>,
  ): ProductTaskEvent[] {
    if (
      message.subtype !== 'task_started' &&
      message.subtype !== 'task_progress' &&
      message.subtype !== 'task_notification'
    ) {
      return projectServerMessageForProductTask(message)
    }

    const identity = backgroundTaskIdentity(message.data)
    if (!identity) return []
    const phase = message.subtype === 'task_started'
      ? 'started'
      : message.subtype === 'task_progress'
        ? 'running'
        : strictTaskActivityPhase(identity.status)
    if (!phase) return []
    return [this.productActivity('task', identity.taskId, 'subtask', phase, {
      parentToolUseId: identity.parentToolUseId,
    })]
  }

  private projectTeamCreated(message: Extract<ServerMessage, { type: 'team_created' }>): ProductTaskEvent[] {
    const teamName = opaqueSource(message.teamName)
    return teamName
      ? [this.productActivity('team', teamName, 'subtask', 'started')]
      : []
  }

  private projectTeamUpdate(message: Extract<ServerMessage, { type: 'team_update' }>): ProductTaskEvent[] {
    const teamName = opaqueSource(message.teamName)
    if (!teamName || !Array.isArray(message.members) || message.members.length === 0) return []

    const statuses = message.members.map((member) => member?.status)
    if (!statuses.every((status) => (
      status === 'running' || status === 'idle' || status === 'completed' || status === 'error'
    ))) {
      return []
    }

    const phase = statuses.some((status) => status === 'error')
      ? 'failed'
      : statuses.some((status) => status === 'running')
        ? 'running'
        : statuses.every((status) => status === 'completed')
          ? 'completed'
          : null
    if (!phase) return []

    const progress = completedProgress(
      statuses.length,
      statuses.filter((status) => status === 'completed').length,
    )
    return [this.productActivity('team', teamName, 'subtask', phase, {
      ...(progress ? { progress } : {}),
    })]
  }

  private projectTaskUpdate(message: Extract<ServerMessage, { type: 'task_update' }>): ProductTaskEvent[] {
    const taskId = opaqueSource(message.taskId)
    const phase = strictTaskActivityPhase(message.status)
    return taskId && phase
      ? [this.productActivity('task', taskId, 'subtask', phase)]
      : []
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
        : []

    case 'content_delta':
      return typeof message.text === 'string' && message.text.length > 0
        ? [{ type: 'assistant_text_delta', text: message.text }]
        : []

    case 'tool_use_complete':
    case 'tool_result':
      // Live activity must use ProductTaskRunActivityProjector so its opaque
      // identity and product-authored summary remain mandatory.
      return []

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
        case 'compact_boundary':
        case 'compact_summary':
          return [{ type: 'status', state: 'working' }]
        default:
          return []
      }

    case 'team_created':
    case 'team_update':
    case 'team_deleted':
    case 'task_update':
      return []

    case 'session_title_updated': {
      const title = visibleString(message.title, MAX_TITLE_LENGTH)
      return title ? [{ type: 'title_updated', title }] : []
    }

    // Runtime configuration, internal notifications and usage metadata
    // intentionally have no product-stream representation.
    case 'pong':
      return []
  }
}
