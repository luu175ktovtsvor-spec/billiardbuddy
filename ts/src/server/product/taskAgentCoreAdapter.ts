/**
 * Product task runtime boundary for the Coding Agent core.
 *
 * The public task socket deliberately speaks only the product protocol. This
 * adapter owns its task-scoped input policy, safe event projection, run
 * snapshots, and approval translation. The injected port is the only route
 * back into the generic Agent Core websocket lifecycle.
 */

import type { ProductTaskEvent } from '../../../shared/product/taskEvents.js'
import type { ServerMessage } from '../ws/events.js'
import {
  productTaskRunProjection,
  type ProductTaskRunProjection,
} from './taskRunProjection.js'
import {
  classifyProductTaskCommand,
  resolveProductTaskText,
  type ProductTaskCommandResolution,
} from './taskCommandPolicy.js'
import {
  buildProductTaskAskUserQuestionUpdatedInput,
  parseProductTaskInboundMessage,
  type ProductTaskInboundMessage,
} from './taskInboundPolicy.js'

export type ProductTaskSocket = {
  data: {
    sessionId: string
    productTaskId?: string
    channel: 'product' | 'sdk'
  }
  send(payload: string): unknown
}

type ProductTaskUserMessage = Extract<ProductTaskInboundMessage, { type: 'user_message' }>

type PendingCorePermission = {
  requestId: string
  toolName?: unknown
  input?: unknown
}

/**
 * Narrow operations the product task surface is allowed to request from the
 * generic Agent Core websocket runtime. It intentionally excludes runtime
 * configuration, raw transport messages, and private session details.
 */
export type ProductTaskAgentCorePort = {
  getSessionWorkDir(sessionId: string): Promise<string | undefined>
  sendUserMessage(socket: ProductTaskSocket, message: ProductTaskUserMessage): Promise<void>
  stopGeneration(socket: ProductTaskSocket): void
  getPendingPermission(
    sessionId: string,
    requestId: string,
  ): PendingCorePermission | undefined
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    updatedInput?: Record<string, unknown>,
  ): void
  resolveComputerUseApproval(sessionId: string, requestId: string, allowed: boolean): boolean
  isDesktopClearCommand(content: string): boolean
  createSafeError(code: string, retryable: boolean): Extract<ServerMessage, { type: 'error' }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isUnanswerableAskUserQuestion(
  message: ServerMessage,
  events: readonly ProductTaskEvent[],
): message is Extract<ServerMessage, { type: 'permission_request' }> {
  return message.type === 'permission_request' &&
    message.toolName === 'AskUserQuestion' &&
    events.length === 0
}

/**
 * The one product-facing runtime adapter. Core output is projected once per
 * task and can advance a bounded reconnect snapshot even while no product
 * window is attached.
 */
export type ProductTaskWorkspaceGuard = {
  requireWorkspaceCapability(taskId: string, capability: 'agent' | 'skill' | 'bash'): Promise<unknown>
}

export class ProductTaskAgentCoreAdapter {
  private readonly rejectedAskRequests = new Set<string>()

  constructor(
    private readonly core: ProductTaskAgentCorePort,
    private readonly runs: ProductTaskRunProjection = productTaskRunProjection,
    private readonly workspaceGuard: ProductTaskWorkspaceGuard = {
      requireWorkspaceCapability: async () => { throw new Error('WORKSPACE_REQUIRED') },
    },
  ) {}

  isProductSocket(socket: ProductTaskSocket): boolean {
    return socket.data.channel === 'product'
  }

  attach(socket: ProductTaskSocket): boolean {
    const taskId = this.taskIdFor(socket)
    if (!taskId) return false
    try {
      this.runs.register(taskId, socket.data.sessionId)
      return true
    } catch {
      // A product socket must never fall back to a private Core-session shape.
      return false
    }
  }

  sendRunSnapshot(socket: ProductTaskSocket): void {
    const taskId = this.taskIdFor(socket)
    if (!taskId) return
    try {
      const snapshot = this.runs.getSnapshot(taskId, socket.data.sessionId)
      socket.send(JSON.stringify({ type: 'run_snapshot', ...snapshot }))
    } catch {
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
    }
  }

  handleIncoming(socket: ProductTaskSocket, payload: unknown): Promise<void> {
    const message = parseProductTaskInboundMessage(payload)
    if (!message) {
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
      return Promise.resolve()
    }

    switch (message.type) {
      case 'user_message':
        return this.handleUserMessage(socket, message)

      case 'permission_response':
        this.handlePermissionResponse(socket, message)
        return Promise.resolve()

      case 'ask_user_question_response':
        this.handleAskUserQuestionResponse(socket, message)
        return Promise.resolve()

      case 'computer_use_permission_response':
        this.handleComputerUsePermissionResponse(socket, message)
        return Promise.resolve()

      case 'stop_generation':
        this.core.stopGeneration(socket)
        return Promise.resolve()

      case 'ping':
        // Product events intentionally omit Core transport metadata such as pong.
        return Promise.resolve()
    }
  }

  clearRunForSocket(socket: ProductTaskSocket): void {
    const taskId = this.taskIdFor(socket)
    if (!taskId) return
    this.runs.clearRun(taskId, socket.data.sessionId)
  }

  hasActiveRunForSession(sessionId: string): boolean {
    return this.runs.hasActiveRunForSession(sessionId)
  }

  projectSessionMessage(
    sessionId: string,
    message: ServerMessage,
  ): ReadonlyMap<string, ProductTaskEvent[]> {
    return this.runs.projectSessionMessage(sessionId, message)
  }

  sendCoreMessage(
    socket: ProductTaskSocket,
    message: ServerMessage,
    projectedEventsByTask?: ReadonlyMap<string, readonly ProductTaskEvent[]>,
  ): void {
    const taskId = this.taskIdFor(socket)
    if (!taskId) return
    const events = projectedEventsByTask?.get(taskId) ?? this.projectTaskMessage(taskId, socket.data.sessionId, message)

    if (isUnanswerableAskUserQuestion(message, events)) {
      this.rejectUnanswerableAskUserQuestion(socket, message)
      return
    }

    for (const event of events) {
      socket.send(JSON.stringify(event))
    }
  }

  removeSession(sessionId: string): void {
    this.runs.removeSession(sessionId)
    for (const key of this.rejectedAskRequests) {
      if (key.startsWith(`${sessionId}:`)) this.rejectedAskRequests.delete(key)
    }
  }

  reset(): void {
    this.runs.reset()
    this.rejectedAskRequests.clear()
  }

  private async handleUserMessage(
    socket: ProductTaskSocket,
    message: ProductTaskUserMessage,
  ): Promise<void> {
    const taskId = this.taskIdFor(socket)
    if (!taskId) {
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
      return
    }
    // BB-02C has no Agent/Core execution capability. This rejection is
    // unconditional: a bound or available workspace must not become a bypass.
    this.sendSafeError(socket, 'WORKSPACE_REQUIRED')
    return

    // Attachment-only product turns have no slash command to validate; their
    // narrow input shape was already checked by taskInboundPolicy.
    if (message.content.trim()) {
      const resolution = await this.resolveTaskText(socket.data.sessionId, message.content)
      if (!resolution.allowed) {
        this.sendSafeError(socket, 'PRODUCT_COMMAND_NOT_ALLOWED')
        // A rejected command never reaches the Core, so no later event can
        // settle the product composer on its behalf.
        this.sendCoreMessage(socket, { type: 'status', state: 'idle' })
        return
      }
      if (!this.core.isDesktopClearCommand(resolution.content)) {
        this.runs.beginRun(taskId, socket.data.sessionId)
      }
      await this.core.sendUserMessage(socket, { ...message, content: resolution.content })
      return
    }

    this.runs.beginRun(taskId, socket.data.sessionId)
    await this.core.sendUserMessage(socket, message)
  }

  private async resolveTaskText(
    sessionId: string,
    content: string,
  ): Promise<ProductTaskCommandResolution> {
    const candidate = classifyProductTaskCommand(content)
    if (candidate.kind === 'plain_text' || candidate.kind === 'local_command') {
      return resolveProductTaskText(content)
    }
    if (candidate.kind === 'rejected') return { allowed: false }

    try {
      const workDir = await this.core.getSessionWorkDir(sessionId)
      if (!workDir) return { allowed: false }
      return resolveProductTaskText(content, { cwd: workDir })
    } catch {
      // A command without a task workspace cannot discover a trusted Skill or
      // Agent. Keep the browser-visible result generic.
      return { allowed: false }
    }
  }

  private handlePermissionResponse(
    socket: ProductTaskSocket,
    message: Extract<ProductTaskInboundMessage, { type: 'permission_response' }>,
  ): void {
    const pending = this.core.getPendingPermission(socket.data.sessionId, message.requestId)
    // AskUserQuestion needs server-built answers. Product sockets must never
    // turn a generic approval into raw updatedInput pass-through.
    if (!pending || pending.toolName === 'AskUserQuestion') {
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
      return
    }
    this.core.respondToPermission(socket.data.sessionId, message.requestId, message.allowed)
  }

  private handleAskUserQuestionResponse(
    socket: ProductTaskSocket,
    message: Extract<ProductTaskInboundMessage, { type: 'ask_user_question_response' }>,
  ): void {
    const pending = this.core.getPendingPermission(socket.data.sessionId, message.requestId)
    if (!pending || pending.toolName !== 'AskUserQuestion' || !isRecord(pending.input)) {
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
      return
    }

    const updatedInput = buildProductTaskAskUserQuestionUpdatedInput(
      pending.input,
      message.answers,
    )
    if (!updatedInput) {
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
      return
    }
    // Only this server-side synthesis carries a Core-specific input field
    // back to the CLI. The browser contributed ordered answer strings only.
    this.core.respondToPermission(
      socket.data.sessionId,
      message.requestId,
      true,
      updatedInput,
    )
  }

  private handleComputerUsePermissionResponse(
    socket: ProductTaskSocket,
    message: Extract<ProductTaskInboundMessage, { type: 'computer_use_permission_response' }>,
  ): void {
    if (!this.taskIdFor(socket) || !this.core.resolveComputerUseApproval(
      socket.data.sessionId,
      message.requestId,
      message.allowed,
    )) {
      // Unknown, expired, or cross-session requests never reach Computer Use.
      this.sendSafeError(socket, 'PRODUCT_MESSAGE_NOT_ALLOWED')
    }
  }

  private projectTaskMessage(
    taskId: string,
    sessionId: string,
    message: ServerMessage,
  ): ProductTaskEvent[] {
    try {
      return this.runs.projectTaskMessage(taskId, sessionId, message)
    } catch {
      return []
    }
  }

  private rejectUnanswerableAskUserQuestion(
    socket: ProductTaskSocket,
    message: Extract<ServerMessage, { type: 'permission_request' }>,
  ): void {
    const key = `${socket.data.sessionId}:${message.requestId}`
    if (!this.rejectedAskRequests.has(key)) {
      this.rejectedAskRequests.add(key)
      // No raw input, option key, or error detail leaves the product channel.
      this.core.respondToPermission(socket.data.sessionId, message.requestId, false)
    }
    socket.send(JSON.stringify({ type: 'error', code: 'task_failed', retryable: false }))
  }

  private sendSafeError(socket: ProductTaskSocket, code: string): void {
    this.sendCoreMessage(socket, this.core.createSafeError(code, false))
  }

  private taskIdFor(socket: ProductTaskSocket): string | null {
    return this.isProductSocket(socket) && socket.data.productTaskId
      ? socket.data.productTaskId
      : null
  }
}
