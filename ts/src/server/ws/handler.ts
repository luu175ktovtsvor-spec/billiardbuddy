/**
 * WebSocket connection handler
 *
 * 管理 WebSocket 连接生命周期，处理消息路由。
 * 用户消息通过 CLI 子进程（stream-json 模式）处理，
 * CLI stdout 消息被转换为 ServerMessage 并转发到 WebSocket。
 */

import type { ServerWebSocket } from 'bun'
import type { ServerMessage, StreamingFallbackCause, TokenUsage } from './events.js'
import * as os from 'node:os'
import {
  ConversationStartupError,
  conversationService,
} from '../services/conversationService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'
import { isOpenAIOfficialProviderId } from '../services/openaiOfficialProvider.js'
import {
  getQfGatewayModel,
  isQfGatewayProviderId,
  qfGatewayConfigured,
  whenQfGatewayReady,
} from '../services/qfGatewayProvider.js'
import { diagnosticsService } from '../services/diagnosticsService.js'
import { projectProductTaskUserContent } from '../product/taskAttachmentProjection.js'
import {
  ProductTaskAgentCoreAdapter,
} from '../product/taskAgentCoreAdapter.js'
import { productTaskService } from '../product/taskService.js'
import { productTaskWorkerRuntimeEvents } from '../product/taskWorkerRuntimeEvents.js'
import { parseProductTaskInboundMessage } from '../product/taskInboundPolicy.js'
import { sessionAdmissionBarrier } from '../product/sessionAdmissionBarrier.js'
import { activeCoreRunRegistry } from '../product/activeCoreRunRegistry.js'
import {
  buildConversationTitleInput,
  deriveTitle,
  generateTitle,
  resolveTitleLanguagePreference,
  saveAiTitle,
  type TitleConversationTurn,
} from '../services/titleService.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import {
  getCommandMetadataDisplayText,
  shouldHideCommandMetadataContent,
} from '../../utils/commandMetadata.js'
import { shouldCreateWorktreeForSessionLaunch } from '../services/repositoryLaunchService.js'
import {
  startPreventSleep,
  stopPreventSleep,
} from '../../services/preventSleep.js'

const settingsService = new SettingsService()
const providerService = new ProviderService()

/**
 * Cache slash commands from CLI init messages, keyed by sessionId.
 */
export type SessionSlashCommand = {
  name: string
}

const sessionSlashCommands = new Map<string, SessionSlashCommand[]>()

/**
 * Timers for delayed session cleanup after client disconnect.
 * If a client reconnects before the timer fires, the timer is cancelled.
 */
const PENDING_PERMISSION_DISCONNECT_CLEANUP_MS = 30 * 60_000
const DEFAULT_IDLE_DISCONNECT_CLEANUP_MS = 30_000
const sessionCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * Per-session removers for the turn-completion watcher (issue #764). When the
 * last client disconnects while a turn is still running, we let the turn finish
 * in the background instead of killing the CLI, then start the idle grace timer
 * once the result arrives. The remover is also cleared on reconnect/cleanup.
 */
const sessionDisconnectWatchers = new Map<string, () => void>()
const sleepPreventedSessions = new Set<string>()
const pendingSleepPrevention = new Map<string, symbol>()

function startPreventSleepForProductTask(
  socket: ServerWebSocket<WebSocketData>,
): void {
  if (socket.data.channel !== 'product' || sleepPreventedSessions.has(socket.data.sessionId)) {
    return
  }
  const sessionId = socket.data.sessionId
  const request = Symbol(sessionId)
  pendingSleepPrevention.set(sessionId, request)
  void settingsService.getUserSettings().then((settings) => {
    if (
      pendingSleepPrevention.get(sessionId) !== request ||
      settings.preventSleepWhileRunning !== true
    ) {
      return
    }
    pendingSleepPrevention.delete(sessionId)
    sleepPreventedSessions.add(sessionId)
    startPreventSleep()
  }).catch(() => {
    if (pendingSleepPrevention.get(sessionId) === request) {
      pendingSleepPrevention.delete(sessionId)
    }
  })
}

function stopPreventSleepForSession(sessionId: string): void {
  pendingSleepPrevention.delete(sessionId)
  if (!sleepPreventedSessions.delete(sessionId)) return
  stopPreventSleep()
}

/**
 * Track sessions where user requested stop — suppress the CLI_ERROR that
 * follows an interrupt so the frontend doesn't show "处理过程中发生错误".
 */
const sessionStopRequested = new Set<string>()

/**
 * Track user message count and title state per session for auto-title generation.
 */
const sessionTitleState = new Map<string, {
  userMessageCount: number
  hasCustomTitle: boolean
  firstUserMessage: string
  completedTurns: TitleConversationTurn[]
  activeTurn?: TitleConversationTurn & { count: number }
  startedGenerationKeys: Set<string>
  generationSeq: number
}>()

type ActiveUserTurnState = {
  messageSent: boolean
}

type CoreUserMessage = {
  content: string
  attachments?: Parameters<typeof conversationService.sendMessage>[2]
}

const activeUserTurns = new Map<string, ActiveUserTurnState>()

const sessionStartupPromises = new Map<string, Promise<void>>()

async function sendRepositoryStartupStatus(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<void> {
  const launchInfo = await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
  const repository = launchInfo?.repository
  if (!repository) return

  if (shouldCreateWorktreeForSessionLaunch(launchInfo)) {
    sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Creating worktree' })
  }
}

export function getSlashCommands(sessionId: string): SessionSlashCommand[] {
  return sessionSlashCommands.get(sessionId) || []
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function translateCliUsage(usage: unknown): TokenUsage {
  const record = usage && typeof usage === 'object'
    ? usage as Record<string, unknown>
    : {}
  const cacheReadTokens = usageNumber(record.cache_read_input_tokens ?? record.cache_read_tokens)
  const cacheCreationTokens = usageNumber(record.cache_creation_input_tokens ?? record.cache_creation_tokens)

  return {
    input_tokens: usageNumber(record.input_tokens),
    output_tokens: usageNumber(record.output_tokens),
    ...(cacheReadTokens > 0 ? { cache_read_tokens: cacheReadTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cache_creation_tokens: cacheCreationTokens } : {}),
  }
}

export type WebSocketData = {
  sessionId: string
  productTaskId?: string
  connectedAt: number
  channel: 'product' | 'sdk'
  sdkToken: string | null
  serverPort: number
  serverHost: string
}

// Active WebSocket clients, grouped by session. Multiple desktop surfaces can
// legitimately watch the same running session at the same time.
const activeSessions = new Map<string, Set<ServerWebSocket<WebSocketData>>>()
productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
  for (const sockets of activeSessions.values()) {
    for (const socket of sockets) {
      if (socket.data.channel === 'product' && socket.data.productTaskId === taskId) {
        socket.send(JSON.stringify(event))
      }
    }
  }
})
// The CLI stream owns mutable per-session parsing state (partial tool input,
// parent ids, and completion bookkeeping). Translate it once, then fan the
// resulting events out to every connected renderer instead of letting each
// client consume the same state independently.
const sessionOutputCallbacks = new Map<
  string,
  {
    callback: (cliMsg: any) => void
    shouldForward?: (cliMsg: any) => boolean
  }
>()

const productTaskAgentCoreAdapter = new ProductTaskAgentCoreAdapter({
  getSessionWorkDir: resolveProductTaskWorkDir,
  sendUserMessage: (socket, message) => handleUserMessage(
    socket as ServerWebSocket<WebSocketData>,
    message,
  ),
  stopGeneration: (socket) => handleStopGeneration(socket as ServerWebSocket<WebSocketData>),
  getPendingPermission: (sessionId, requestId) => conversationService
    .getPendingPermissionRequests(sessionId)
    .find((request) => request.requestId === requestId),
  respondToPermission: (sessionId, requestId, allowed, updatedInput) => {
    if (updatedInput === undefined) {
      conversationService.respondToPermission(sessionId, requestId, allowed)
      return
    }
    conversationService.respondToPermission(
      sessionId,
      requestId,
      allowed,
      undefined,
      updatedInput,
    )
  },
  resolveComputerUseApproval: (sessionId, requestId, allowed) => (
    computerUseApprovalService.resolveProductTaskApproval(sessionId, requestId, allowed)
  ),
  isDesktopClearCommand,
  createSafeError: toSafeRuntimeError,
}, undefined, {
  // `startServer()` replaces the singleton for every isolated server root.
  // Keep this dependency live instead of capturing the import-time instance.
  requireWorkspaceCapability: (...args) => productTaskService.requireWorkspaceCapability(...args),
})

export const handleWebSocket = {
  open(ws: ServerWebSocket<WebSocketData>) {
    const { sessionId, channel, sdkToken } = ws.data

    if (channel === 'sdk') {
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        console.warn(`[WS] Rejected SDK connection for session: ${sessionId}`)
        ws.close(1008, 'Invalid SDK token')
        return
      }

      conversationService.attachSdkConnection(sessionId, ws)
      console.log(`[WS] SDK connected for session: ${sessionId}`)
      return
    }

    if (!productTaskAgentCoreAdapter.attach(ws)) {
      // This identifier comes from the task-scoped upgrade route. If a
      // malformed in-process caller bypasses that route, fail closed rather
      // than ever falling back to a Core-session identifier.
      ws.close(1008, 'Invalid product task')
      return
    }

    console.log(`[WS] Client connected for session: ${sessionId}`)

    // Cancel pending cleanup timer if client reconnects
    const pendingTimer = sessionCleanupTimers.get(sessionId)
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      sessionCleanupTimers.delete(sessionId)
    }
    // Cancel any "let the running turn finish, then clean up" watcher too —
    // the session is observed again (issue #764).
    cancelSessionDisconnectWatcher(sessionId)

    addActiveClient(sessionId, ws)
    bindClientSessionOutput(sessionId, ws)

    const msg: ServerMessage = { type: 'connected', sessionId }
    sendMessage(ws, msg)
    void replayDurableProductEvents(ws, 0)
    const workerSnapshot = productTaskWorkerRuntimeEvents.snapshot(ws.data.productTaskId!)
    if (workerSnapshot.state === 'idle') productTaskAgentCoreAdapter.sendRunSnapshot(ws)
    else ws.send(JSON.stringify({ type: 'run_snapshot', ...workerSnapshot }))
    void replayPendingWorkerApproval(ws)
    replayPendingPermissionRequests(ws, sessionId)
  },

  message(ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) {
    if (ws.data.channel === 'sdk') {
      const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      conversationService.handleSdkPayload(ws.data.sessionId, payload)
      return
    }

    try {
      const parsed = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      ) as unknown

      const resumeCursor = productResumeCursor(parsed)
      if (resumeCursor !== null) {
        void replayDurableProductEvents(ws, resumeCursor)
        return
      }

      // BB-02C has one submit path: durable HTTP submit with attachment IDs.
      // A websocket user_message is the retired raw transport, including a
      // text-only payload.  It must not reach Core or any filesystem path.
      if (isRetiredRawProductMessage(parsed)) {
        sendProductProtocolError(ws, 'attachment_ingest_unavailable')
        return
      }

      const productMessage = parseProductTaskInboundMessage(parsed)
      void (async () => {
        if (productMessage?.type === 'permission_response' && ws.data.productTaskId && productTaskWorkerRuntimeEvents.ownsApproval(ws.data.productTaskId, productMessage.requestId)) {
          const handled = await productTaskService.respondToTaskApproval(
            ws.data.productTaskId,
            productMessage.requestId,
            productMessage.allowed,
          )
          if (handled) return
        }
        await productTaskAgentCoreAdapter.handleIncoming(ws, parsed)
      })().catch((err) => {
        void diagnosticsService.recordEvent({
          type: 'ws_product_user_message_failed',
          severity: 'error',
          sessionId: ws.data.sessionId,
          summary: err instanceof Error ? err.message : String(err),
          details: err,
        })
        console.error(`[WS] Unhandled error in product task user message:`, err)
      })
    } catch {
      sendError(ws, 'PARSE_ERROR')
    }
  },

  close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
    const { sessionId, channel } = ws.data

    if (channel === 'sdk') {
      console.log(`[WS] SDK disconnected from session: ${sessionId} (${code}: ${reason})`)
      conversationService.detachSdkConnection(sessionId)
      return
    }

    console.log(`[WS] Client disconnected from session: ${sessionId} (${code}: ${reason})`)
    if (!removeActiveClient(sessionId, ws)) {
      console.log(`[WS] Ignoring stale client disconnect for session: ${sessionId}`)
      return
    }

    if (hasActiveClients(sessionId)) {
      return
    }

    // A product turn needs to keep translating Core output after the last
    // renderer closes. The process-local product run projection holds only a
    // bounded safe tree, and lets a reconnect receive the same real progress
    // rather than a fabricated loading state.
    if (!productTaskAgentCoreAdapter.hasActiveRunForSession(sessionId)) {
      removeSessionOutputCallback(sessionId)
    }

    // No clients left. A turn that is still running must finish in the
    // background (issue #764) — never kill it just because a phone locked its
    // screen. Defer cleanup until the turn completes, then apply the idle
    // grace period. Sessions that are already idle go straight to the timer.
    if (isSessionTurnActive(sessionId)) {
      console.log(`[WS] Session ${sessionId} still running after disconnect; keeping CLI alive until the turn finishes`)
      watchTurnCompletionForCleanup(sessionId)
      return
    }

    scheduleDisconnectCleanup(sessionId)
  },

  drain(ws: ServerWebSocket<WebSocketData>) {
    // Backpressure handling - called when the socket is ready to receive more data
  },
}

function productResumeCursor(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.type !== 'resume' || Object.keys(record).length !== 2 || !Number.isSafeInteger(record.cursor) || record.cursor < 0) return null
  return record.cursor
}

function isRetiredRawProductMessage(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'user_message'
}

function sendProductProtocolError(
  ws: ServerWebSocket<WebSocketData>,
  code: 'attachment_ingest_unavailable',
): void {
  ws.send(JSON.stringify({ type: 'error', code, retryable: false }))
}

async function replayDurableProductEvents(
  ws: ServerWebSocket<WebSocketData>,
  afterEventSequence: number,
): Promise<void> {
  const taskId = ws.data.productTaskId
  if (!taskId || ws.data.channel !== 'product') return
  try {
    const { events, cursor } = await productTaskService.listTaskEvents(taskId, afterEventSequence)
    for (const event of events) {
      ws.send(JSON.stringify({
        type: 'user_text',
        text: event.text,
        replayed: true,
        event_sequence: event.event_sequence,
        ...(event.attachments?.length ? { attachments: event.attachments } : {}),
        ...(event.reference_entry_ids?.length ? { referenceEntryIds: event.reference_entry_ids } : {}),
      }))
    }
    ws.send(JSON.stringify({ type: 'resume_cursor', cursor }))
  } catch {
    sendProductProtocolError(ws, 'attachment_ingest_unavailable')
  }
}

async function replayPendingWorkerApproval(ws: ServerWebSocket<WebSocketData>): Promise<void> {
  const taskId = ws.data.productTaskId
  if (!taskId || ws.data.channel !== 'product') return
  const approval = await productTaskService.readPendingTaskApproval(taskId).catch(() => null)
  if (approval) {
    productTaskWorkerRuntimeEvents.rememberApproval(taskId, approval)
    ws.send(JSON.stringify(approval))
  }
}

// ============================================================================
// Message handlers
// ============================================================================

async function resolveProductTaskWorkDir(sessionId: string): Promise<string | undefined> {
  const activeWorkDir = conversationService.getSessionWorkDir(sessionId).trim()
  if (activeWorkDir) return activeWorkDir

  const persistedWorkDir = (await sessionService.getSessionWorkDir(sessionId))?.trim()
  return persistedWorkDir || undefined
}

function isDesktopClearCommand(content: string): boolean {
  return getDesktopSlashCommand(content)?.commandName.trim().toLowerCase() === 'clear'
}

async function handleUserMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: CoreUserMessage,
) {
  return sessionAdmissionBarrier.withRunStart(
    ws.data.sessionId,
    () => handleUserMessageAdmitted(ws, message),
  )
}

async function handleUserMessageAdmitted(
  ws: ServerWebSocket<WebSocketData>,
  message: CoreUserMessage,
) {
  const { sessionId } = ws.data

  // Clear any stale stop flag from a previous turn
  sessionStopRequested.delete(sessionId)

  const desktopSlashCommand = getDesktopSlashCommand(message.content)
  if (desktopSlashCommand?.commandName === 'clear' && desktopSlashCommand.args.trim()) {
    sendMessage(ws, {
      type: 'error',
      message: 'The /clear command does not accept arguments.',
      code: 'INVALID_SLASH_COMMAND_ARGS',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  if (desktopSlashCommand?.commandName === 'clear') {
    await handleDesktopClearCommand(ws)
    return
  }

  // Send thinking status
  sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })

  const activeTurn: ActiveUserTurnState = { messageSent: false }
  setActiveUserTurn(sessionId, activeTurn)

  // Track and emit the first placeholder title before CLI startup/streaming.
  let titleState = sessionTitleState.get(sessionId)
  if (!titleState) {
    titleState = {
      userMessageCount: 0,
      hasCustomTitle: !!(await sessionService.getCustomTitle(sessionId)),
      firstUserMessage: '',
      completedTurns: [],
      startedGenerationKeys: new Set<string>(),
      generationSeq: 0,
    }
    sessionTitleState.set(sessionId, titleState)
  }
  const titleInput = getTitleInputForUserMessage(message.content, desktopSlashCommand)
  let titleTurnNumber: number | null = null
  if (titleInput) {
    titleState.userMessageCount++
    titleTurnNumber = titleState.userMessageCount
    titleState.activeTurn = {
      count: titleTurnNumber,
      userText: titleInput,
      assistantText: '',
    }
    if (titleState.userMessageCount === 1) {
      titleState.firstUserMessage = titleInput
    }
    triggerTitleGeneration(ws, sessionId, 'user-message')
  }

  // 启动 CLI 子进程（如果还没有）
  try {
    await ensureCliSessionStarted(ws, sessionId)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[WS] CLI start failed for ${sessionId}: ${errMsg}`)
    sendMessage(ws, projectStartupError(err))
    sendMessage(ws, { type: 'status', state: 'idle' })
    clearActiveUserTurn(sessionId, activeTurn)
    return
  }

  // Register the callback before sending the turn so startup errors are not lost.
  // Keep output muted until the current user turn is enqueued to avoid forwarding
  // any pre-turn SDK chatter as fresh chat history.
  let userMessageSent = false
  const shouldForwardCurrentTurnLocalCommand =
    createCurrentTurnLocalCommandForwarder(desktopSlashCommand)
  const removeTitleOutputCallback = titleTurnNumber === null
    ? null
    : bindTitleSessionOutput(ws, sessionId, () => userMessageSent)

  bindAllClientSessionOutputs(sessionId, {
    shouldForward: (cliMsg) => {
      if (userMessageSent || (cliMsg.type === 'result' && cliMsg.is_error)) {
        return true
      }
      return shouldForwardCurrentTurnLocalCommand(cliMsg)
    },
  })
  const removeActiveTurnOutputCallback = bindActiveUserTurnCompletion(sessionId, activeTurn)

  startPreventSleepForProductTask(ws)
  let sent = false
  try {
    sent = await conversationService.sendMessage(
      sessionId,
      message.content,
      message.attachments
    )
  } catch (error) {
    stopPreventSleepForSession(sessionId)
    throw error
  }
  if (!sent) {
    stopPreventSleepForSession(sessionId)
    removeActiveTurnOutputCallback()
    clearActiveUserTurn(sessionId, activeTurn)
    removeTitleOutputCallback?.()
    discardActiveTitleTurn(sessionId, titleTurnNumber)
    sendMessage(ws, toSafeRuntimeError('CLI_NOT_RUNNING', true))
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  userMessageSent = true
  activeTurn.messageSent = true
}

function setActiveUserTurn(sessionId: string, activeTurn: ActiveUserTurnState): void {
  // The map models one generic Core turn per session. Replacement must not
  // leak a registry reference for the overwritten turn.
  if (activeUserTurns.has(sessionId)) activeCoreRunRegistry.markInactive(sessionId)
  activeUserTurns.set(sessionId, activeTurn)
  activeCoreRunRegistry.markActive(sessionId)
}

function clearActiveUserTurn(sessionId: string, activeTurn: ActiveUserTurnState): void {
  if (activeUserTurns.get(sessionId) === activeTurn) {
    activeUserTurns.delete(sessionId)
    activeCoreRunRegistry.markInactive(sessionId)
  }
}

function bindActiveUserTurnCompletion(
  sessionId: string,
  activeTurn: ActiveUserTurnState,
): () => void {
  const callback = (cliMsg: any) => {
    if (cliMsg?.type !== 'result') return
    stopPreventSleepForSession(sessionId)
    if (!activeTurn.messageSent) return

    conversationService.removeOutputCallback(sessionId, callback)
    clearActiveUserTurn(sessionId, activeTurn)
    sessionService.invalidateSessionList()
  }

  conversationService.onOutput(sessionId, callback)
  return () => conversationService.removeOutputCallback(sessionId, callback)
}

async function handleDesktopClearCommand(
  ws: ServerWebSocket<WebSocketData>,
) {
  const { sessionId } = ws.data

  const workDir = conversationService.getSessionWorkDir(sessionId)
  const permissionMode = conversationService.hasSession(sessionId)
    ? conversationService.getSessionPermissionMode(sessionId)
    : undefined
  conversationService.stopSession(sessionId)
  stopPreventSleepForSession(sessionId)
  conversationService.clearOutputCallbacks(sessionId)
  sessionOutputCallbacks.delete(sessionId)
  sessionSlashCommands.delete(sessionId)
  sessionTitleState.delete(sessionId)
  cleanupStreamState(sessionId)

  try {
    await sessionService.clearSessionTranscript(sessionId, workDir || undefined, permissionMode)
  } catch {
    sendMessage(ws, toSafeRuntimeError('SESSION_CLEAR_FAILED', true))
    sendMessage(ws, { type: 'status', state: 'idle' })
    return
  }

  productTaskAgentCoreAdapter.clearRunForSocket(ws)

  sendMessage(ws, {
    type: 'system_notification',
    subtype: 'session_cleared',
    message: 'Conversation cleared',
  })
  sendMessage(ws, {
    type: 'message_complete',
    usage: { input_tokens: 0, output_tokens: 0 },
  })
}


async function persistSessionPermissionMode(
  sessionId: string,
  mode: string,
  knownWorkDir?: string | null,
): Promise<boolean> {
  const workDir =
    knownWorkDir ||
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId).catch(() => null)

  if (!workDir) return false

  await sessionService.appendSessionMetadata(sessionId, {
    workDir,
    permissionMode: mode,
  })
  return true
}

function handleStopGeneration(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  console.log(`[WS] Stop generation requested for session: ${sessionId}`)

  if (ws.data.channel === 'product' && ws.data.productTaskId) {
    void productTaskService.stopActiveTaskRun(ws.data.productTaskId).then((stopped) => {
      if (!stopped) sendMessage(ws, { type: 'status', state: 'idle' })
    }).catch(() => ws.send(JSON.stringify({ type: 'error', code: 'temporarily_unavailable', retryable: true })))
    return
  }

  sessionStopRequested.add(sessionId)
  stopPreventSleepForSession(sessionId)

  if (conversationService.hasSession(sessionId)) {
    // First try graceful interrupt via SDK control message
    conversationService.sendInterrupt(sessionId)

    // Force-kill if still running after 3 seconds
    setTimeout(() => {
      if (conversationService.hasSession(sessionId)) {
        console.log(`[WS] Force-killing CLI subprocess for session: ${sessionId}`)
        conversationService.stopSession(sessionId)
      }
    }, 3_000)
  }

  sendMessage(ws, { type: 'status', state: 'idle' })
}

// ============================================================================
// Title generation
// ============================================================================

type TitleGenerationPhase = 'user-message' | 'turn-complete'

function triggerTitleGeneration(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  phase: TitleGenerationPhase,
  completedTurnCount?: number,
): void {
  const state = sessionTitleState.get(sessionId)
  if (!state || state.hasCustomTitle) return

  const count = phase === 'turn-complete'
    ? completedTurnCount ?? state.userMessageCount
    : state.userMessageCount

  if (phase === 'user-message') {
    if (count !== 1) return
    const key = 'placeholder:1'
    if (state.startedGenerationKeys.has(key)) return
    state.startedGenerationKeys.add(key)

    void (async () => {
      try {
        const text = state.firstUserMessage
        const placeholder = deriveTitle(text)
        if (placeholder) {
          const saved = await saveAiTitle(sessionId, placeholder)
          if (!saved) {
            state.hasCustomTitle = true
            return
          }
          sendSessionTitleUpdated(ws, sessionId, placeholder)
        }
      } catch (err) {
        console.error(`[Title] Failed to derive title for ${sessionId}:`, err)
      }
    })()
    return
  }

  // Generate polished titles after assistant output completes on turn 1 and 3.
  if (count !== 1 && count !== 3) return
  const key = `complete:${count}`
  if (state.startedGenerationKeys.has(key)) return
  state.startedGenerationKeys.add(key)

  const text = buildConversationTitleInput(state.completedTurns)
  const generationSeq = ++state.generationSeq

  void (async () => {
    try {
      const runtimeProviderId = (
        await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
      )?.runtimeProviderId
      const responseLanguage = await getResponseLanguageSetting()
      const titleLanguagePreference = resolveTitleLanguagePreference(
        state.firstUserMessage,
        responseLanguage,
      )
      const aiTitle = await generateTitle(
        text,
        runtimeProviderId,
        titleLanguagePreference,
      )
      if (generationSeq !== state.generationSeq) return
      if (aiTitle) {
        const saved = await saveAiTitle(sessionId, aiTitle)
        if (!saved) {
          state.hasCustomTitle = true
          return
        }
        sendSessionTitleUpdated(ws, sessionId, aiTitle)
      }
    } catch (err) {
      console.error(`[Title] Failed to generate title for ${sessionId}:`, err)
    }
  })()
}

async function getResponseLanguageSetting(): Promise<string | undefined> {
  const userSettings = await settingsService.getUserSettings().catch(() => ({}))
  return typeof userSettings.language === 'string'
    ? userSettings.language
    : undefined
}

function sendSessionTitleUpdated(
  fallbackWs: ServerWebSocket<WebSocketData>,
  sessionId: string,
  title: string,
): void {
  const payload: ServerMessage = { type: 'session_title_updated', sessionId, title }
  const clients = activeSessions.get(sessionId)
  if (!clients?.size) {
    sendMessage(fallbackWs, payload)
    return
  }
  for (const client of clients) {
    sendMessage(client, payload)
  }
}

function bindTitleSessionOutput(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
  shouldProcess: () => boolean,
): () => void {
  const callback = (cliMsg: any) => {
    if (!shouldProcess() && !(cliMsg?.type === 'result' && cliMsg?.is_error)) {
      return
    }

    appendAssistantTextForTitle(sessionId, cliMsg)

    if (cliMsg?.type === 'result') {
      conversationService.removeOutputCallback(sessionId, callback)
      const completedTurnCount = completeActiveTitleTurn(sessionId)
      if (!cliMsg.is_error) {
        triggerTitleGeneration(ws, sessionId, 'turn-complete', completedTurnCount ?? undefined)
      }
    }
  }

  conversationService.onOutput(sessionId, callback)
  return () => conversationService.removeOutputCallback(sessionId, callback)
}

function appendAssistantTextForTitle(sessionId: string, cliMsg: any): void {
  const activeTurn = sessionTitleState.get(sessionId)?.activeTurn
  if (!activeTurn) return

  const streamText = extractAssistantStreamTextForTitle(cliMsg)
  if (streamText) {
    activeTurn.assistantText = `${activeTurn.assistantText ?? ''}${streamText}`
    return
  }

  const assistantText = extractAssistantMessageTextForTitle(cliMsg)
  if (assistantText) {
    activeTurn.assistantText = activeTurn.assistantText
      ? `${activeTurn.assistantText}\n${assistantText}`
      : assistantText
    return
  }

  if (
    cliMsg?.type === 'result' &&
    !cliMsg.is_error &&
    !activeTurn.assistantText &&
    typeof cliMsg.result === 'string'
  ) {
    activeTurn.assistantText = cliMsg.result
  }
}

function extractAssistantStreamTextForTitle(cliMsg: any): string | null {
  const event = cliMsg?.event
  if (
    cliMsg?.type !== 'stream_event' ||
    event?.type !== 'content_block_delta' ||
    event.delta?.type !== 'text_delta' ||
    typeof event.delta.text !== 'string'
  ) {
    return null
  }
  return event.delta.text
}

function extractAssistantMessageTextForTitle(cliMsg: any): string | null {
  if (cliMsg?.type !== 'assistant') return null
  const content = cliMsg.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return []
      const typedBlock = block as { type?: unknown; text?: unknown }
      return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
        ? [typedBlock.text]
        : []
    })
    .join('\n')
    .trim()
  return text || null
}

function completeActiveTitleTurn(sessionId: string): number | null {
  const state = sessionTitleState.get(sessionId)
  const activeTurn = state?.activeTurn
  if (!state || !activeTurn) return null

  state.completedTurns.push({
    userText: activeTurn.userText,
    assistantText: activeTurn.assistantText?.trim(),
  })
  state.activeTurn = undefined
  return activeTurn.count
}

function discardActiveTitleTurn(sessionId: string, count: number | null): void {
  if (count === null) return
  const state = sessionTitleState.get(sessionId)
  if (state?.activeTurn?.count === count) {
    state.activeTurn = undefined
  }
}

// ============================================================================
// CLI message translation
// ============================================================================

/**
 * Per-session streaming state to avoid cross-session interference.
 * Each session tracks its own dedup flag, active block types, and tool blocks.
 */
type SessionStreamState = {
  hasReceivedStreamEvents: boolean
  activeBlockTypes: Map<number, 'text' | 'tool_use' | 'thinking'>
  activeToolBlocks: Map<number, { toolName: string; toolUseId: string; inputJson: string; parentToolUseId?: string }>
  pendingLocalCommand?: { name: string; args: string }
  /** Tool blocks whose input JSON failed to parse in content_block_stop.
   *  The assistant message carries the complete input — defer to that. */
  pendingToolBlocks: Map<string, { toolName: string; toolUseId: string; parentToolUseId?: string }>
  toolParentUseIds: Map<string, string>
  lastApiError?: {
    message: string
    code: string
  }
}

const SAFE_BUSINESS_ERROR_CODES = new Set([
  'pdf_too_large',
  'pdf_password_protected',
  'pdf_invalid',
  'image_too_large',
  'image_unsupported',
  'request_too_large',
  'prompt_too_long',
  'auto_mode_unavailable',
])

const SAFE_RUNTIME_ERROR_MESSAGE = 'The task could not be completed. Please try again.'

function toSafeRuntimeError(
  code: string,
  retryable: boolean,
  businessErrorCode?: string,
): Extract<ServerMessage, { type: 'error' }> {
  return {
    type: 'error',
    code,
    message: SAFE_RUNTIME_ERROR_MESSAGE,
    retryable,
    ...(businessErrorCode ? { businessErrorCode } : {}),
  }
}

function projectStartupError(error: unknown): Extract<ServerMessage, { type: 'error' }> {
  if (!(error instanceof ConversationStartupError)) {
    return toSafeRuntimeError('CLI_START_FAILED', false)
  }

  return toSafeRuntimeError(error.code, error.retryable)
}

function safeBusinessErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_BUSINESS_ERROR_CODES.has(value)
    ? value
    : undefined
}

const sessionStreamStates = new Map<string, SessionStreamState>()

function getStreamState(sessionId: string): SessionStreamState {
  let state = sessionStreamStates.get(sessionId)
  if (!state) {
    state = {
      hasReceivedStreamEvents: false,
      activeBlockTypes: new Map(),
      activeToolBlocks: new Map(),
      pendingLocalCommand: undefined,
      pendingToolBlocks: new Map(),
      toolParentUseIds: new Map(),
      lastApiError: undefined,
    }
    sessionStreamStates.set(sessionId, state)
  }
  return state
}

function cliParentToolUseId(cliMsg: any): string | undefined {
  return typeof cliMsg.parent_tool_use_id === 'string' && cliMsg.parent_tool_use_id.length > 0
    ? cliMsg.parent_tool_use_id
    : undefined
}

function rememberToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
  parentToolUseId: string | undefined,
): void {
  if (!toolUseId || !parentToolUseId) return
  streamState.toolParentUseIds.set(toolUseId, parentToolUseId)
}

function consumeToolParentUseId(
  streamState: SessionStreamState,
  toolUseId: string | undefined,
): string | undefined {
  if (!toolUseId) return undefined
  const parentToolUseId = streamState.toolParentUseIds.get(toolUseId)
  streamState.toolParentUseIds.delete(toolUseId)
  return parentToolUseId
}

/** Clean up stream state when session disconnects */
function cleanupStreamState(sessionId: string) {
  sessionStreamStates.delete(sessionId)
}

function cleanupSessionRuntimeState(sessionId: string) {
  stopPreventSleepForSession(sessionId)
  cancelSessionDisconnectWatcher(sessionId)
  productTaskAgentCoreAdapter.removeSession(sessionId)
  cleanupStreamState(sessionId)
  sessionSlashCommands.delete(sessionId)
  sessionTitleState.delete(sessionId)
  const activeTurn = activeUserTurns.get(sessionId)
  if (activeTurn) clearActiveUserTurn(sessionId, activeTurn)
  sessionStartupPromises.delete(sessionId)
}

function cacheSessionInitMetadata(sessionId: string, cliMsg: any) {
  if (cliMsg?.type !== 'system' || cliMsg.subtype !== 'init') return
  if (typeof cliMsg.cwd === 'string' && cliMsg.cwd.trim()) {
    conversationService.updateSessionWorkDir(sessionId, cliMsg.cwd)
    void (async () => {
      await sessionService.appendSessionMetadata(sessionId, {
        workDir: cliMsg.cwd,
      })
      await sessionService.deletePlaceholderSessionFiles(sessionId, cliMsg.cwd)
    })()
  }
  if (cliMsg.slash_commands && Array.isArray(cliMsg.slash_commands)) {
    updateSessionSlashCommands(sessionId, cliMsg.slash_commands, { notifyClient: false })
  }
}

function extractAssistantText(cliMsg: any): string {
  const content = cliMsg?.message?.content
  if (!Array.isArray(content)) return ''
  const textBlock = content.find(
    (block: unknown): block is { type: string; text: string } =>
      !!block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  )
  return textBlock?.text || ''
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeAskUserQuestionToolResult(content: unknown, toolUseResult: unknown): unknown {
  const result = readObject(toolUseResult)
  const answers = readObject(result?.answers)
  if (!result || !answers || !Array.isArray(result.questions)) return content
  return {
    questions: result.questions,
    answers,
  }
}

function isDuplicateOfLastApiError(
  lastApiError: SessionStreamState['lastApiError'],
  resultMessage: string,
): boolean {
  if (!lastApiError?.message) return false
  if (resultMessage === lastApiError.message) return true
  return (
    resultMessage.includes(lastApiError.message) &&
    /CLI (?:process exited unexpectedly|exited during startup)/i.test(resultMessage)
  )
}

async function resolveSessionWorkDir(sessionId: string, fallback = os.homedir()): Promise<string> {
  let workDir = fallback
  try {
    const resolved = await sessionService.getSessionWorkDir(sessionId)
    if (resolved) workDir = resolved
    console.log(
      `[WS] resolveSessionWorkDir: sessionId=${sessionId}, resolved workDir=${JSON.stringify(
        resolved,
      )}, will spawn CLI with workDir=${workDir}`,
    )
  } catch (resolveErr) {
    console.warn(
      `[WS] resolveSessionWorkDir: failed to resolve workDir for ${sessionId}, using fallback=${workDir}: ${
        resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
      }`,
    )
  }
  return workDir
}

async function ensureCliSessionStarted(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): Promise<void> {
  const pendingStartup = sessionStartupPromises.get(sessionId)
  if (pendingStartup) {
    await pendingStartup
    return
  }

  if (conversationService.hasSession(sessionId)) return

  const startup = (async () => {
    const workDir = await resolveSessionWorkDir(sessionId)
    const runtimeSettings = await getRuntimeSettings(sessionId)
    const sdkUrl =
      `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
      `?token=${encodeURIComponent(crypto.randomUUID())}`
    await sendRepositoryStartupStatus(ws, sessionId)
    console.log(`[WS] Starting CLI for ${sessionId} due to user message`)
    await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)
  })()

  sessionStartupPromises.set(sessionId, startup)
  try {
    await startup
  } finally {
    if (sessionStartupPromises.get(sessionId) === startup) {
      sessionStartupPromises.delete(sessionId)
    }
  }
}

export function translateCliMessage(cliMsg: any, sessionId: string): ServerMessage[] {
  const streamState = getStreamState(sessionId)
  switch (cliMsg.type) {
    case 'assistant': {
      if (cliMsg.error || cliMsg.isApiErrorMessage) {
        // If the user requested stop, suppress API errors caused by the
        // stream being interrupted (e.g. "Stream ended without receiving
        // any events"). The result message handler also checks this flag,
        // but the assistant error arrives first and would leak to the UI.
        if (sessionStopRequested.has(sessionId)) {
          return []
        }
        const rawMessage = extractAssistantText(cliMsg) || cliMsg.error || 'Unknown API error'
        streamState.lastApiError = { message: rawMessage, code: 'CLI_ERROR' }
        const businessErrorCode = safeBusinessErrorCode(cliMsg.businessErrorCode)
        return [toSafeRuntimeError('CLI_ERROR', !businessErrorCode, businessErrorCode)]
      }

      // If we already received stream_events, text/thinking were already sent.
      // Only extract tool_use blocks (stream_event's content_block_stop lacks complete tool info).
      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        const messages: ServerMessage[] = []

        for (const block of cliMsg.message.content) {
          if (streamState.hasReceivedStreamEvents) {
            // Stream events handled most blocks — but any tool_use whose
            // input JSON failed to parse in content_block_stop was deferred.
            // Emit those now with the complete input from the assistant message.
            if (block.type === 'tool_use' && streamState.pendingToolBlocks.has(block.id)) {
              const pending = streamState.pendingToolBlocks.get(block.id)!
              streamState.pendingToolBlocks.delete(block.id)
              rememberToolParentUseId(streamState, block.id, pending.parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: pending.toolName || block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId: pending.parentToolUseId,
              })
            }
          } else {
            // No stream events received — this is the only source, process everything
            if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', text: block.thinking })
            } else if (block.type === 'text' && block.text) {
              messages.push({ type: 'content_start', blockType: 'text' })
              messages.push({ type: 'content_delta', text: block.text })
            } else if (block.type === 'tool_use') {
              const parentToolUseId = cliParentToolUseId(cliMsg)
              rememberToolParentUseId(streamState, block.id, parentToolUseId)
              messages.push({
                type: 'tool_use_complete',
                toolName: block.name,
                toolUseId: block.id,
                input: block.input,
                parentToolUseId,
              })
            }
          }
        }

        // Reset flags for next turn
        streamState.hasReceivedStreamEvents = false
        streamState.pendingToolBlocks.clear()
        return messages
      }
      return []
    }

    case 'user': {
      // Bug #1: 处理 tool_result 消息
      // CLI 发送 type:'user' 消息，其中 content 包含 tool_result 块
      const messages: ServerMessage[] = []

      if (isCompactSummaryMessageContent(cliMsg.message?.content)) {
        messages.push({
          type: 'system_notification',
          subtype: 'compact_summary',
          message: cliMsg.message.content,
          data: {
            isSynthetic: cliMsg.isSynthetic,
          },
        })
      }

      const localCommandOutput = extractLocalCommandOutput(
        cliMsg.message?.content,
      )
      if (localCommandOutput) {
        const pendingLocalCommand = streamState.pendingLocalCommand
        streamState.pendingLocalCommand = undefined
        const productOutput = projectLocalCommandOutput(
          localCommandOutput,
          pendingLocalCommand,
        )
        if (!isCompactLocalCommandOutput(productOutput)) {
          const goalEvent = extractGoalEvent(
            productOutput,
            pendingLocalCommand,
          )
          if (goalEvent) {
            messages.push({
              type: 'system_notification',
              subtype: 'goal_event',
              message: goalEvent.message,
              data: goalEvent,
            })
          } else {
            messages.push({ type: 'content_start', blockType: 'text' })
            messages.push({ type: 'content_delta', text: productOutput })
          }
        }
      }

      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        for (const block of cliMsg.message.content) {
          if (block.type === 'tool_result') {
            const rememberedParentToolUseId = consumeToolParentUseId(streamState, block.tool_use_id)
            const parentToolUseId =
              cliParentToolUseId(cliMsg) ?? rememberedParentToolUseId
            messages.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: normalizeAskUserQuestionToolResult(block.content, cliMsg.toolUseResult),
              isError: !!block.is_error,
              parentToolUseId,
            })
          }
        }
      }

      const replayText = extractReplayUserText(cliMsg)
      if (replayText) {
        const attachmentProjection = projectProductTaskUserContent(cliMsg.message?.content)
        messages.push({
          type: 'user_message_replay',
          content: replayText,
          ...(attachmentProjection?.attachments.length
            ? { attachments: attachmentProjection.attachments }
            : {}),
        })
      }

      return messages
    }

    case 'stream_event': {
      streamState.hasReceivedStreamEvents = true
      const event = cliMsg.event
      if (!event) return []

      switch (event.type) {
        case 'message_start': {
          return [{ type: 'status', state: 'thinking' }]
        }

        case 'content_block_start': {
          const contentBlock = event.content_block
          if (!contentBlock) return []

          const index = event.index ?? 0

          if (contentBlock.type === 'tool_use') {
            const parentToolUseId = cliParentToolUseId(cliMsg)
            streamState.activeBlockTypes.set(index, 'tool_use')
            // Track tool info so content_block_stop can emit complete data
            streamState.activeToolBlocks.set(index, {
              toolName: contentBlock.name || '',
              toolUseId: contentBlock.id || '',
              inputJson: '',
              parentToolUseId,
            })
            return [{
              type: 'content_start',
              blockType: 'tool_use',
              toolName: contentBlock.name,
              toolUseId: contentBlock.id,
              parentToolUseId,
            }]
          }

          if (contentBlock.type === 'thinking' || contentBlock.type === 'redacted_thinking') {
            streamState.activeBlockTypes.set(index, 'thinking')
            return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
          }

          streamState.activeBlockTypes.set(index, 'text')
          return [{ type: 'content_start', blockType: 'text' }]
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (!delta) return []

          if (delta.type === 'text_delta' && delta.text) {
            return [{ type: 'content_delta', text: delta.text }]
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            // Accumulate tool input JSON
            const index = event.index ?? 0
            const toolBlock = streamState.activeToolBlocks.get(index)
            if (toolBlock) toolBlock.inputJson += delta.partial_json
            return [{ type: 'content_delta', toolInput: delta.partial_json }]
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            return [{ type: 'thinking', text: delta.thinking }]
          }
          return []
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          const blockType = streamState.activeBlockTypes.get(index)
          streamState.activeBlockTypes.delete(index)

          if (blockType === 'tool_use') {
            const toolBlock = streamState.activeToolBlocks.get(index)
            streamState.activeToolBlocks.delete(index)
            if (toolBlock) {
              const parentToolUseId =
                cliParentToolUseId(cliMsg) ?? toolBlock.parentToolUseId
              let parsedInput = null
              try { parsedInput = JSON.parse(toolBlock.inputJson) } catch {}

              if (parsedInput !== null) {
                rememberToolParentUseId(streamState, toolBlock.toolUseId, parentToolUseId)
                return [{
                  type: 'tool_use_complete',
                  toolName: toolBlock.toolName,
                  toolUseId: toolBlock.toolUseId,
                  input: parsedInput,
                  parentToolUseId,
                }]
              }

              // JSON parse failed — defer to the assistant message which
              // carries the complete, already-parsed tool input. This is the
              // normal streaming partial-input case, not a fault: keep it at
              // debug so it doesn't surface as a diagnostics warning.
              console.debug(
                `[WS] Tool input JSON parse failed for ${toolBlock.toolName} (${toolBlock.toolUseId}), deferring to assistant message`,
              )
              streamState.pendingToolBlocks.set(toolBlock.toolUseId, {
                toolName: toolBlock.toolName,
                toolUseId: toolBlock.toolUseId,
                parentToolUseId,
              })
            }
          }
          return []
        }

        case 'message_stop': {
          // message_stop is handled by the 'result' message
          return []
        }

        case 'message_delta': {
          // message_delta may contain stop_reason or usage updates
          return []
        }

        default:
          return []
      }
    }

    case 'control_request': {
      // 权限请求 — CLI 需要用户授权才能执行工具
      if (cliMsg.request?.subtype === 'can_use_tool') {
        return [{
          type: 'permission_request',
          requestId: cliMsg.request_id,
          toolName: cliMsg.request.tool_name || 'Unknown',
          toolUseId:
            typeof cliMsg.request.tool_use_id === 'string'
              ? cliMsg.request.tool_use_id
              : undefined,
          input: cliMsg.request.input || {},
          description: cliMsg.request.description,
        }]
      }
      return []
    }

    case 'control_response':
      return []

    case 'result': {
      // 对话结果（成功或错误）
      const usage = translateCliUsage(cliMsg.usage)

      if (cliMsg.is_error) {
        // If the user requested stop, this "error" is just the interrupt
        // result — don't show it as an error in the chat UI.
        if (sessionStopRequested.has(sessionId)) {
          sessionStopRequested.delete(sessionId)
          return [{ type: 'message_complete', usage }]
        }

        const resultMessage =
          (typeof cliMsg.result === 'string' && cliMsg.result) ||
          (Array.isArray(cliMsg.errors) && cliMsg.errors.length > 0
            ? cliMsg.errors.join('\n')
            : 'Unknown error')
        if (isDuplicateOfLastApiError(streamState.lastApiError, resultMessage)) {
          streamState.lastApiError = undefined
          return [{ type: 'message_complete', usage }]
        }
        // 错误和完成消息都发送
        return [
          toSafeRuntimeError('CLI_ERROR', true),
          { type: 'message_complete', usage },
        ]
      }

      // Clear stop flag on successful completion too
      sessionStopRequested.delete(sessionId)
      streamState.lastApiError = undefined
      return [{ type: 'message_complete', usage }]
    }

    case 'system': {
      // 区分不同的 system 子类型
      const subtype = cliMsg.subtype
      if (subtype === 'api_retry') {
        const apiRetryMessage = toApiRetryServerMessage(cliMsg)
        return apiRetryMessage ? [apiRetryMessage] : []
      }
      if (subtype === 'streaming_fallback') {
        return [toStreamingFallbackServerMessage(cliMsg)]
      }
      if (subtype === 'init') {
        // CLI 初始化完成 — 缓存 slash commands，但不把模型或其他
        // runtime metadata 透传到普通产品界面。
        // NOTE: Do NOT send status:idle here — the CLI init fires while
        // processing the first user message, and sending idle would reset
        // the frontend's streaming state prematurely.
        cacheSessionInitMetadata(sessionId, cliMsg)
        // Slash command discovery is intentionally pull-only: the active
        // Composer asks for name-only commands after a user types '/'. Do not
        // push a catalog while opening or initializing a normal session.
        return []
      }
      if (subtype === 'status') {
        if (cliMsg.status === 'compacting') {
          return [{
            type: 'status',
            state: 'compacting',
            verb: 'Compacting conversation',
          }]
        }
        // CLI 在权限模式变化时也会 enqueue 一条 status 事件（status:null +
        // permissionMode）。会话状态已在输出回调中先被记录并持久化；它不是
        // 产品流事件，也不是 thinking 信号，因此必须在下面的 null→thinking
        // 兜底之前拦截。
        if (typeof cliMsg.permissionMode === 'string') {
          return []
        }
        if (cliMsg.status == null) {
          return [{ type: 'status', state: 'thinking', verb: 'Thinking' }]
        }
        return []
      }
      if (subtype === 'hook_started' || subtype === 'hook_response') {
        // Hook 执行中 — 不转发给前端
        return []
      }
      if (subtype === 'local_command' || subtype === 'local_command_output') {
        const localCommand = extractLocalCommand(cliMsg.content ?? cliMsg.message)
        if (localCommand) {
          streamState.pendingLocalCommand = localCommand
          return []
        }

        const localCommandOutput = extractLocalCommandOutput(
          cliMsg.content ?? cliMsg.message,
          { allowUntagged: subtype === 'local_command_output' },
        )
        if (!localCommandOutput) return []
        const pendingLocalCommand = streamState.pendingLocalCommand
        const productOutput = projectLocalCommandOutput(
          localCommandOutput,
          pendingLocalCommand,
        )
        const goalEvent = extractGoalEvent(
          productOutput,
          pendingLocalCommand,
        )
        streamState.pendingLocalCommand = undefined
        if (goalEvent) {
          return [{
            type: 'system_notification',
            subtype: 'goal_event',
            message: goalEvent.message,
            data: goalEvent,
          }]
        }
        return [
          { type: 'content_start', blockType: 'text' },
          { type: 'content_delta', text: productOutput },
        ]
      }
      // Bug #7: 处理 task/team system 消息
      if (subtype === 'task_notification') {
        return [{
          type: 'system_notification',
          subtype: 'task_notification',
          message: cliMsg.message || cliMsg.title,
          data: cliMsg,
        }]
      }
      if (subtype === 'task_started') {
        return [
          {
            type: 'system_notification',
            subtype: 'task_started',
            message: cliMsg.message || cliMsg.description || 'Task started',
            data: cliMsg,
          },
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.description || 'Task started',
          },
        ]
      }
      if (subtype === 'task_progress') {
        return [
          {
            type: 'system_notification',
            subtype: 'task_progress',
            message: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
            data: cliMsg,
          },
          {
            type: 'status',
            state: 'tool_executing',
            verb: cliMsg.message || cliMsg.summary || cliMsg.description || 'Task in progress',
          },
        ]
      }
      if (subtype === 'agent_tool_activity') {
        // Tool activity streamed from a background (async) agent. Re-emit as a
        // normal tool_use_complete / tool_result carrying the parent Agent
        // tool_use_id, so the desktop groups it under the agent card exactly
        // like a synchronous subagent (childToolCallsByParent).
        const activity = cliMsg.activity
        const parentToolUseId =
          typeof cliMsg.tool_use_id === 'string' ? cliMsg.tool_use_id : undefined
        if (activity?.kind === 'tool_use') {
          return [{
            type: 'tool_use_complete',
            toolName: activity.tool_name,
            toolUseId: activity.tool_use_id,
            input: activity.input,
            parentToolUseId,
          }]
        }
        if (activity?.kind === 'tool_result') {
          return [{
            type: 'tool_result',
            toolUseId: activity.tool_use_id,
            content: activity.content,
            isError: activity.is_error === true,
            parentToolUseId,
          }]
        }
        return []
      }
      if (subtype === 'session_state_changed') {
        return [{
          type: 'system_notification',
          subtype: 'session_state_changed',
          message: cliMsg.message,
          data: cliMsg,
        }]
      }
      if (subtype === 'compact_boundary') {
        return [{
          type: 'system_notification',
          subtype: 'compact_boundary',
          message: getCompactBoundaryMessage(cliMsg),
          data: cliMsg.compact_metadata ?? cliMsg,
        }]
      }
      // 其他 system 消息
      return []
    }

    default:
      // 未知类型 — 调试输出但不转发
      console.log(`[WS] Unknown CLI message type: ${cliMsg.type}`, JSON.stringify(cliMsg).substring(0, 200))
      return []
  }
}

// ============================================================================
// Helpers
// ============================================================================

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRetryCount(value: unknown): number | null {
  const numeric = finiteNumber(value)
  if (numeric === null) return null
  return Math.max(0, Math.trunc(numeric))
}

function readRetryErrorRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toApiRetryServerMessage(cliMsg: any): ServerMessage | null {
  const attempt = normalizeRetryCount(cliMsg.attempt)
  const maxRetries = normalizeRetryCount(cliMsg.max_retries)
  const retryDelayMs = normalizeRetryCount(cliMsg.retry_delay_ms)
  if (attempt === null || maxRetries === null || retryDelayMs === null) return null

  const embeddedError = readRetryErrorRecord(cliMsg.error)
  const embeddedStatus = embeddedError ? finiteNumber(embeddedError.status) : null
  const rawStatus = cliMsg.error_status === null
    ? null
    : finiteNumber(cliMsg.error_status) ?? embeddedStatus
  const errorStatus = rawStatus !== null && rawStatus >= 100 && rawStatus <= 599
    ? Math.trunc(rawStatus)
    : null

  return {
    type: 'api_retry',
    code: 'API_RETRYING',
    retryable: true,
    attempt,
    maxRetries,
    retryDelayMs,
    errorStatus,
  }
}

const STREAMING_FALLBACK_CAUSES: ReadonlySet<StreamingFallbackCause> = new Set([
  'watchdog',
  'stream_error',
  '404_stream_creation',
])

function toStreamingFallbackServerMessage(cliMsg: any): ServerMessage {
  // 未识别的 cause 兜底为 unknown 而不是丢消息：提示本身比成因重要。
  const cause: StreamingFallbackCause =
    typeof cliMsg.cause === 'string' && STREAMING_FALLBACK_CAUSES.has(cliMsg.cause as StreamingFallbackCause)
      ? (cliMsg.cause as StreamingFallbackCause)
      : 'unknown'
  return { type: 'streaming_fallback', cause }
}

function sendMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: ServerMessage,
) {
  if (productTaskAgentCoreAdapter.isProductSocket(ws)) {
    productTaskAgentCoreAdapter.sendCoreMessage(ws, message)
    return
  }
  ws.send(JSON.stringify(message))
}

/**
 * Translate a Core message once, project it once per public product task, and
 * then fan out the already-safe events. This keeps parent/tool-kind context
 * stable across multiple product windows and still advances an active run
 * when there are temporarily no windows at all.
 */
function sendServerMessagesToSessionClients(
  sessionId: string,
  messages: readonly ServerMessage[],
): void {
  const clients = activeSessions.get(sessionId)
  for (const message of messages) {
    const productEventsByTask = productTaskAgentCoreAdapter.projectSessionMessage(sessionId, message)
    if (!clients?.size) continue
    for (const client of clients) {
      if (productTaskAgentCoreAdapter.isProductSocket(client)) {
        productTaskAgentCoreAdapter.sendCoreMessage(client, message, productEventsByTask)
        continue
      }
      sendMessage(client, message)
    }
  }
}

function sendError(ws: ServerWebSocket<WebSocketData>, code: string) {
  sendMessage(ws, toSafeRuntimeError(code, false))
}

/**
 * Idle disconnect cleanup delay. A session waiting on a pending permission
 * keeps the long 30-minute window so a transient renderer disconnect does not
 * abort a prompt the user is about to answer. Otherwise desktop sessions use
 * the fixed local grace period.
 */
function getDisconnectCleanupDelayMs(sessionId: string): number {
  return conversationService.getPendingPermissionRequests(sessionId).length > 0
    ? PENDING_PERMISSION_DISCONNECT_CLEANUP_MS
    : DEFAULT_IDLE_DISCONNECT_CLEANUP_MS
}

/**
 * Whether the session is mid-turn (a user message was sent and no result has
 * arrived yet). Such a turn must not be killed on disconnect.
 */
function isSessionTurnActive(sessionId: string): boolean {
  return activeUserTurns.get(sessionId)?.messageSent === true
}

/**
 * Start the idle grace timer for a disconnected, idle session. If no client
 * reconnects before it fires, the CLI subprocess is stopped.
 */
function scheduleDisconnectCleanup(sessionId: string): void {
  computerUseApprovalService.cancelSession(sessionId)

  const existing = sessionCleanupTimers.get(sessionId)
  if (existing) clearTimeout(existing)

  const cleanupDelayMs = getDisconnectCleanupDelayMs(sessionId)
  const cleanupTimer = setTimeout(() => {
    sessionCleanupTimers.delete(sessionId)
    if (!hasActiveClients(sessionId)) {
      console.log(`[WS] Session ${sessionId} not reconnected after ${cleanupDelayMs}ms, stopping CLI subprocess`)
      removeSessionOutputCallback(sessionId)
      conversationService.stopSession(sessionId)
      cleanupSessionRuntimeState(sessionId)
    }
  }, cleanupDelayMs)
  sessionCleanupTimers.set(sessionId, cleanupTimer)
}

/**
 * Keep a still-running session alive after the last client leaves, and start
 * the idle grace timer only once the current turn completes (issue #764). If a
 * client reconnects first, cancelSessionDisconnectWatcher() tears this down.
 */
function watchTurnCompletionForCleanup(sessionId: string): void {
  cancelSessionDisconnectWatcher(sessionId)

  const onComplete = (cliMsg: any) => {
    if (cliMsg?.type !== 'result') return
    cancelSessionDisconnectWatcher(sessionId)
    // The turn finished while still unobserved — fall back to the idle timer.
    if (!hasActiveClients(sessionId)) {
      scheduleDisconnectCleanup(sessionId)
    }
  }

  conversationService.onOutput(sessionId, onComplete)
  sessionDisconnectWatchers.set(sessionId, () => {
    conversationService.removeOutputCallback(sessionId, onComplete)
  })
}

/** Remove any pending turn-completion watcher for a session. */
function cancelSessionDisconnectWatcher(sessionId: string): void {
  const remove = sessionDisconnectWatchers.get(sessionId)
  if (remove) {
    remove()
    sessionDisconnectWatchers.delete(sessionId)
  }
}

function replayPendingPermissionRequests(
  ws: ServerWebSocket<WebSocketData>,
  sessionId: string,
): void {
  for (const request of conversationService.getPendingPermissionRequests(sessionId)) {
    sendMessage(ws, {
      type: 'permission_request',
      requestId: request.requestId,
      toolName: request.toolName,
      ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}),
      input: request.input,
      ...(request.description ? { description: request.description } : {}),
    })
  }
}

function getDesktopSlashCommand(content: string): ReturnType<typeof parseSlashCommand> {
  const parsed = parseSlashCommand(content.trim())
  if (!parsed || parsed.isMcp) return null
  return parsed
}

function getTitleInputForUserMessage(
  content: string,
  command: ReturnType<typeof parseSlashCommand>,
): string | null {
  if (command?.commandName !== 'goal') return content

  const args = command.args.trim()
  if (!args || args === 'clear') return null
  return args
}

export function createCurrentTurnLocalCommandForwarder(
  command: ReturnType<typeof parseSlashCommand>,
): (cliMsg: any) => boolean {
  let awaitingCurrentTurnLocalCommandOutput = false

  return (cliMsg: any) => {
    if (command && isMatchingCurrentTurnLocalCommand(cliMsg, command)) {
      awaitingCurrentTurnLocalCommandOutput = true
      return true
    }
    if (command?.commandName === 'goal' && isLocalCommandOutputMessage(cliMsg)) {
      const output = extractLocalCommandOutput(
        cliMsg.content ?? cliMsg.message,
        { allowUntagged: cliMsg.subtype === 'local_command_output' },
      )
      if (output && looksLikeGoalCommandOutput(output)) {
        awaitingCurrentTurnLocalCommandOutput = false
        return true
      }
    }
    if (
      awaitingCurrentTurnLocalCommandOutput &&
      isLocalCommandOutputMessage(cliMsg)
    ) {
      awaitingCurrentTurnLocalCommandOutput = false
      return true
    }
    return false
  }
}

function isMatchingCurrentTurnLocalCommand(
  cliMsg: any,
  command: NonNullable<ReturnType<typeof parseSlashCommand>>,
): boolean {
  if (cliMsg?.type !== 'system' || cliMsg?.subtype !== 'local_command') {
    return false
  }
  const localCommand = extractLocalCommand(cliMsg.content ?? cliMsg.message)
  if (!localCommand) return false
  return (
    localCommand.name === command.commandName &&
    localCommand.args.trim() === command.args.trim()
  )
}

function isLocalCommandOutputMessage(cliMsg: any): boolean {
  if (
    cliMsg?.type !== 'system' ||
    (cliMsg?.subtype !== 'local_command' &&
      cliMsg?.subtype !== 'local_command_output')
  ) {
    return false
  }
  return extractLocalCommandOutput(
    cliMsg.content ?? cliMsg.message,
    { allowUntagged: cliMsg.subtype === 'local_command_output' },
  ) !== null
}

function extractLocalCommandOutput(
  content: unknown,
  options: { allowUntagged?: boolean } = {},
): string | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  if (!raw) return null

  const stdout = extractTaggedContent(raw, LOCAL_COMMAND_STDOUT_TAG)
  if (stdout !== null) return stdout

  const stderr = extractTaggedContent(raw, LOCAL_COMMAND_STDERR_TAG)
  if (stderr !== null) return stderr

  if (options.allowUntagged) {
    const normalized = raw.trim()
    return normalized || null
  }

  return null
}

function projectLocalCommandOutput(
  output: string,
  command: { name: string; args: string } | undefined,
): string {
  if (command?.name !== 'memory') return output

  if (/^error opening memory file:/i.test(output.trim())) {
    return 'Unable to open memory editor.'
  }
  if (/^cancelled memory editing/i.test(output.trim())) {
    return 'Memory editing cancelled.'
  }
  return 'Memory editor opened.'
}

function isCompactLocalCommandOutput(output: string): boolean {
  return output.trim() === 'Compacted'
}

function extractTaggedContent(raw: string, tag: string): string | null {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
  return match?.[1]?.trim() ?? null
}

function extractLocalCommand(content: unknown): { name: string; args: string } | null {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const text = (block as { text?: unknown }).text
          return typeof text === 'string' ? [text] : []
        })
        .join('\n')
      : ''

  const name = extractTaggedContent(raw, COMMAND_NAME_TAG)
  if (!name) return null
  return {
    name: name.replace(/^\//, ''),
    args: extractTaggedContent(raw, 'command-args') ?? '',
  }
}

type GoalEventData = {
  action: 'created' | 'replaced' | 'status' | 'paused' | 'resumed' | 'completed' | 'cleared' | 'message'
  status?: string
  objective?: string
  budget?: string
  elapsed?: string
  continuations?: string
  message?: string
}

function extractGoalEvent(
  output: string,
  command?: { name: string; args: string },
): GoalEventData | null {
  if (command && command.name !== 'goal') return null

  const trimmed = output.trim()
  if (!trimmed) return null

  if (trimmed === 'Goal cleared.' || trimmed.startsWith('Goal cleared:')) {
    return { action: 'cleared', message: trimmed }
  }
  if (trimmed === 'Goal marked complete.') {
    return { action: 'completed', message: trimmed }
  }
  if (trimmed === 'No active goal.') {
    return { action: 'message', message: trimmed }
  }
  if (trimmed.startsWith('Goal continuing:')) {
    return {
      action: 'status',
      status: 'continuing',
      message: trimmed,
    }
  }

  if (trimmed.startsWith('Goal set:')) {
    const objective = trimmed.slice('Goal set:'.length).trim()
    return {
      action: 'created',
      status: 'active',
      objective: objective || undefined,
      message: trimmed,
    }
  }

  return command?.name === 'goal' ? { action: 'message', message: trimmed } : null
}

function looksLikeGoalCommandOutput(output: string): boolean {
  const trimmed = output.trim()
  return (
    trimmed.startsWith('Goal set:') ||
    trimmed.startsWith('Goal continuing:') ||
    trimmed.startsWith('Goal cleared:') ||
    trimmed === 'Goal cleared.' ||
    trimmed === 'Goal marked complete.' ||
    trimmed === 'No active goal.'
  )
}

function getCompactBoundaryMessage(cliMsg: any): string {
  const message = typeof cliMsg?.message === 'string' ? cliMsg.message.trim() : ''
  if (message) return message

  const content = typeof cliMsg?.content === 'string' ? cliMsg.content.trim() : ''
  if (content) return content

  return 'Context compacted'
}

function isCompactSummaryMessageContent(content: unknown): content is string {
  return (
    typeof content === 'string' &&
    content.trim().startsWith(
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    )
  )
}

function hasToolResultBlock(content: unknown): boolean {
  return Array.isArray(content) &&
    content.some((block) =>
      Boolean(block) &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_result')
}

function extractReplayUserText(cliMsg: any): string | null {
  if (cliMsg?.isReplay !== true) return null
  const content = cliMsg.message?.content
  const commandDisplayText = getCommandMetadataDisplayText(content)
  if (commandDisplayText) return commandDisplayText
  if (shouldHideCommandMetadataContent(content)) return null
  if (isCompactSummaryMessageContent(content)) return null
  if (hasToolResultBlock(content)) return null
  if (extractLocalCommandOutput(content)) return null

  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return []
          const typedBlock = block as { type?: unknown; text?: unknown }
          return typedBlock.type === 'text' && typeof typedBlock.text === 'string'
            ? [typedBlock.text]
            : []
        })
        .join('\n')
      : ''

  const trimmed = text.trim()
  return trimmed || null
}

function addActiveClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): void {
  let clients = activeSessions.get(sessionId)
  if (!clients) {
    clients = new Set()
    activeSessions.set(sessionId, clients)
  }
  clients.add(ws)
}

function removeActiveClient(
  sessionId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  const clients = activeSessions.get(sessionId)
  if (!clients?.has(ws)) return false
  clients.delete(ws)
  if (clients.size === 0) {
    activeSessions.delete(sessionId)
  }
  return true
}

function hasActiveClients(sessionId: string): boolean {
  return (activeSessions.get(sessionId)?.size ?? 0) > 0
}

function bindAllClientSessionOutputs(
  sessionId: string,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
): void {
  bindSessionOutput(sessionId, options, true)
}

function bindClientSessionOutput(
  sessionId: string,
  _ws: ServerWebSocket<WebSocketData>,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
) {
  bindSessionOutput(sessionId, options)
}

function bindSessionOutput(
  sessionId: string,
  options?: {
    shouldForward?: (cliMsg: any) => boolean
  },
  replaceForwardingGuard = false,
) {
  if (!conversationService.hasSession(sessionId)) return

  const existing = sessionOutputCallbacks.get(sessionId)
  if (existing) {
    // A just-sent turn replaces the pre-send forwarding guard. Keep the one
    // callback alive so translating a live stream never resets its state.
    if (replaceForwardingGuard) {
      existing.shouldForward = options?.shouldForward
    }
    return
  }

  const callback = (cliMsg: any) => {
    const current = sessionOutputCallbacks.get(sessionId)
    if (current?.shouldForward && !current.shouldForward(cliMsg)) {
      return
    }

    handleCliPermissionModeBroadcast(sessionId, cliMsg)
    const serverMsgs = translateCliMessage(cliMsg, sessionId)
    sendServerMessagesToSessionClients(sessionId, serverMsgs)
  }

  sessionOutputCallbacks.set(sessionId, { callback, shouldForward: options?.shouldForward })
  conversationService.onOutput(sessionId, callback)
}

function removeSessionOutputCallback(sessionId: string): void {
  const entry = sessionOutputCallbacks.get(sessionId)
  if (!entry) return
  conversationService.removeOutputCallback(sessionId, entry.callback)
  sessionOutputCallbacks.delete(sessionId)
}

function getCliPermissionModeBroadcast(cliMsg: any): string | null {
  if (
    cliMsg?.type === 'system' &&
    cliMsg.subtype === 'status' &&
    typeof cliMsg.permissionMode === 'string'
  ) {
    return cliMsg.permissionMode
  }
  return null
}

function handleCliPermissionModeBroadcast(sessionId: string, cliMsg: any): void {
  const mode = getCliPermissionModeBroadcast(cliMsg)
  if (!mode) return

  const currentMode = conversationService.getSessionPermissionMode(sessionId)
  if (currentMode === mode) return

  if (!conversationService.recordSessionPermissionMode(sessionId, mode)) return
  void persistSessionPermissionMode(sessionId, mode).catch((err) => {
    console.warn(`[WS] Failed to persist CLI permission mode broadcast for ${sessionId}:`, err)
  })
}

type RuntimeSettings = {
  permissionMode?: string
  model?: string
  effort?: string
  thinking?: 'enabled' | 'disabled'
  providerId?: string | null
}

export function isKnownRuntimeProviderId(
  providerId: string,
  providers: Array<{ id: string }>,
): boolean {
  return (
    isOpenAIOfficialProviderId(providerId) ||
    isQfGatewayProviderId(providerId) ||
    providers.some((provider) => provider.id === providerId)
  )
}

async function getRuntimeSettings(sessionId?: string): Promise<RuntimeSettings> {
  // Gate every session/turn start on the product-gateway registration so the first
  // session never reads a pre-registration null activeId. No-op after first resolve.
  await whenQfGatewayReady()
  const launchInfo = sessionId
    ? await sessionService.getSessionLaunchInfo(sessionId).catch(() => null)
    : null
  const sessionPermissionMode = launchInfo?.permissionMode
  const persistedRuntimeSettings =
    !qfGatewayConfigured() && launchInfo?.runtimeModelId
      ? {
          providerId: launchInfo.runtimeProviderId ?? null,
          modelId: launchInfo.runtimeModelId,
          ...(launchInfo.effortLevel ? { effort: launchInfo.effortLevel } : {}),
        }
      : undefined
  if (persistedRuntimeSettings) {
    if (typeof persistedRuntimeSettings.providerId === 'string') {
      const { providers } = await providerService.listProviders()
      const providerExists = isKnownRuntimeProviderId(persistedRuntimeSettings.providerId, providers)
      if (!providerExists) {
        console.warn(
          `[WS] Ignoring stale persisted runtime provider id for ${sessionId}: ${persistedRuntimeSettings.providerId}`,
        )
        const defaults = await getDefaultRuntimeSettings()
        return {
          ...defaults,
          permissionMode: sessionPermissionMode ?? defaults.permissionMode,
        }
      }
    }

    const thinking = resolveProductThinkingMode(
      await settingsService.getUserSettings(),
      persistedRuntimeSettings.providerId,
      persistedRuntimeSettings.modelId,
    )

    return {
      permissionMode: sessionPermissionMode ?? await settingsService.getPermissionMode().catch(() => undefined),
      model: persistedRuntimeSettings.modelId,
      effort: persistedRuntimeSettings.effort,
      thinking,
      providerId: persistedRuntimeSettings.providerId,
    }
  }

  const defaults = await getDefaultRuntimeSettings()
  return {
    ...defaults,
    permissionMode: sessionPermissionMode ?? defaults.permissionMode,
    effort: launchInfo?.effortLevel ?? defaults.effort,
  }
}

async function getDefaultRuntimeSettings(): Promise<RuntimeSettings> {
  // Check if a custom provider is active
  const { providers, activeId } = await providerService.listProviders()
  let resolvedActiveId = activeId
  if (activeId && !isKnownRuntimeProviderId(activeId, providers)) {
    console.warn(`[WS] Active provider id is stale, falling back to official provider: ${activeId}`)
    resolvedActiveId = null
    await providerService.activateOfficial()
  }

  const userSettings = await settingsService.getUserSettings()
  const providerSettings = resolvedActiveId
    ? await providerService.getManagedSettings()
    : undefined
  const modelSettings = providerSettings ?? userSettings
  const modelContext =
    typeof modelSettings.modelContext === 'string' && modelSettings.modelContext.trim()
      ? modelSettings.modelContext
      : undefined
  const effort =
    typeof userSettings.effort === 'string' && userSettings.effort.trim()
      ? userSettings.effort
      : undefined

  let model: string | undefined
  if (resolvedActiveId) {
    // Provider is active — only consult provider-managed billiardbuddy settings.
    // Global ~/.claude/settings.json model values must not bleed into provider mode.
    const baseModel =
      typeof modelSettings.model === 'string' && modelSettings.model.trim()
        ? modelSettings.model
        : ''
    if (baseModel) {
      model = baseModel
      if (modelContext) model += `:${modelContext}`
    }
  } else {
    // No provider — pass model normally
    const baseModel =
      typeof userSettings.model === 'string' && userSettings.model.trim()
        ? userSettings.model
        : undefined
    model = baseModel ? (modelContext ? `${baseModel}:${modelContext}` : baseModel) : undefined
  }

  const thinking = resolveProductThinkingMode(
    userSettings,
    resolvedActiveId,
    model ?? (isQfGatewayProviderId(resolvedActiveId) ? getQfGatewayModel() : undefined),
  )

  return {
    permissionMode: await settingsService.getPermissionMode().catch(() => undefined),
    model,
    effort,
    thinking,
    providerId: resolvedActiveId,
  }
}

/**
 * The product preference is intentionally separate from Core's
 * `alwaysThinkingEnabled`: it is read only while a new desktop CLI process is
 * being started. Existing processes retain their launch argument.
 *
 * The managed gateway's non-DeepSeek routes stay explicitly disabled so a
 * product Deep Thinking toggle can never enable MiMo or its VisionBridge work.
 */
export function resolveProductThinkingMode(
  settings: Record<string, unknown>,
  providerId: string | null | undefined,
  model: string | undefined,
): 'enabled' | 'disabled' | undefined {
  if (!isQfGatewayProviderId(providerId)) return undefined
  if (!isManagedDeepSeekModel(model)) return 'disabled'
  return settings.deepThinkingEnabled === false ? 'disabled' : 'enabled'
}

function isManagedDeepSeekModel(model: string | undefined): boolean {
  return /^deepseek(?:[-_]|$)/i.test(model?.trim() ?? '')
}

/**
 * Send a message to a specific session's WebSocket (for use by services)
 */
export function sendToSession(sessionId: string, message: ServerMessage): boolean {
  const clients = activeSessions.get(sessionId)
  if (!clients || clients.size === 0) return false
  sendServerMessagesToSessionClients(sessionId, [message])
  return true
}

export function updateSessionSlashCommands(
  sessionId: string,
  commands: unknown[],
  _options: { notifyClient?: boolean } = {},
): SessionSlashCommand[] {
  const normalized = commands
    .map(normalizeSessionSlashCommand)
    .filter((command): command is SessionSlashCommand => command !== null)

  sessionSlashCommands.set(sessionId, normalized)

  return normalized
}

function normalizeSessionSlashCommand(command: unknown): SessionSlashCommand | null {
  if (typeof command === 'string') {
    const name = command.trim()
    return name ? { name } : null
  }
  if (!command || typeof command !== 'object') return null

  const record = command as {
    name?: unknown
    command?: unknown
  }
  const name =
    typeof record.name === 'string'
      ? record.name
      : typeof record.command === 'string'
        ? record.command
        : ''
  if (!name.trim()) return null

  return { name: name.trim() }
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeSessions.keys())
}

export function __resetWebSocketHandlerStateForTests(): void {
  for (const timer of sessionCleanupTimers.values()) clearTimeout(timer)
  for (const remove of sessionDisconnectWatchers.values()) remove()
  activeSessions.clear()
  productTaskAgentCoreAdapter.reset()
  sessionOutputCallbacks.clear()
  sessionCleanupTimers.clear()
  sessionDisconnectWatchers.clear()
}

/** Test hook: mark a session as mid-turn so disconnect keeps the CLI alive. */
export function __markActiveTurnForTests(sessionId: string): void {
  setActiveUserTurn(sessionId, { messageSent: true })
}
