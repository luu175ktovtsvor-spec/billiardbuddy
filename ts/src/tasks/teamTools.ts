import type { Tool, ToolContext } from '../tools/Tool'
import { formatTeammateMessages, generateRequestId, TEAM_LEAD_NAME, TeamService } from './teamService'
import type { BackgroundAgentTargetResolution, TaskMeta, TaskService } from './taskService'
import { parsePeerAddress } from './peerAddress'
import { sendToUdsSocket } from './udsClient'
import type { UdsPeerRecord } from './udsPeerRegistry'
import type { BridgePeerRecord } from './bridgePeerRegistry'

type StructuredMessage =
  | { type: 'shutdown_request'; reason?: string }
  | { type: 'shutdown_response'; request_id?: string; requestId?: string; approve?: boolean | string; reason?: string }
  | { type: 'plan_approval_response'; request_id?: string; requestId?: string; approve?: boolean | string; feedback?: string }

interface SendMessageInput {
  to?: string
  summary?: string
  message?: string | StructuredMessage
}

interface TeamCreateInput {
  team_name?: string
  teamName?: string
  description?: string
  agent_type?: string
  agentType?: string
}

interface ListPeersInput {
  team_name?: string
  teamName?: string
  include_inbox?: boolean | string
  includeInbox?: boolean | string
}

export interface TeamToolsOptions {
  tasks?: TaskService
  udsPeers?: { list(): Promise<UdsPeerRecord[]> }
  bridgePeers?: {
    list(): Promise<BridgePeerRecord[]>
    get(sessionId: string): Promise<BridgePeerRecord | null>
  }
  sendBridgeMessage?: (sessionId: string, message: string, ctx: ToolContext) => Promise<{ ok: boolean; error?: string }>
  resumeBackgroundAgent?: (task: TaskMeta, message: string, ctx: ToolContext) => Promise<{ task: TaskMeta }>
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function rawStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function semanticBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on', 'approve', 'approved'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off', 'reject', 'rejected'].includes(text)) return false
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStructuredMessage(value: unknown): StructuredMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'shutdown_request') {
    return {
      type: 'shutdown_request',
      reason: rawStringValue(value.reason),
    }
  }
  if (value.type === 'shutdown_response') {
    return {
      type: 'shutdown_response',
      request_id: rawStringValue(value.request_id),
      requestId: rawStringValue(value.requestId),
      approve: typeof value.approve === 'boolean' || typeof value.approve === 'string' ? value.approve : undefined,
      reason: rawStringValue(value.reason),
    }
  }
  if (value.type === 'plan_approval_response') {
    return {
      type: 'plan_approval_response',
      request_id: rawStringValue(value.request_id),
      requestId: rawStringValue(value.requestId),
      approve: typeof value.approve === 'boolean' || typeof value.approve === 'string' ? value.approve : undefined,
      feedback: rawStringValue(value.feedback),
    }
  }
  return null
}

function normalizeSendInput(input: unknown): Required<Pick<SendMessageInput, 'to'>> & Omit<SendMessageInput, 'to'> {
  const args = recordInput(input)
  const message = typeof args.message === 'string' ? args.message : normalizeStructuredMessage(args.message)
  return {
    to: stringValue(args.to),
    summary: rawStringValue(args.summary),
    message: message ?? undefined,
  }
}

function requestIdFrom(message: { request_id?: string; requestId?: string }): string {
  return stringValue(message.request_id) || stringValue(message.requestId)
}

function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

function optionalXmlAttr(name: string, value: string | number | boolean | undefined): string {
  if (value === undefined || value === '') return ''
  return ` ${name}="${xmlAttr(String(value))}"`
}

function peerTarget(name: string): string {
  return name
}

function peerJson(peer: Awaited<ReturnType<TeamService['listPeers']>>['peers'][number]): Record<string, unknown> {
  return {
    name: peer.name,
    agent_id: peer.agentId,
    target: peerTarget(peer.name),
    is_lead: peer.isLead,
    active: peer.isActive,
    unread_messages: peer.unreadMessages,
    agent_type: peer.agentType,
    backend_type: peer.backendType,
    mode: peer.mode,
    session_id: peer.sessionId,
    tmux_pane_id: peer.tmuxPaneId,
    cwd: peer.cwd,
    worktree_path: peer.worktreePath,
    color: peer.color,
    joined_at: peer.joinedAt,
    subscriptions: peer.subscriptions,
  }
}

function udsPeerJson(peer: UdsPeerRecord): Record<string, unknown> {
  return {
    id: peer.id,
    target: peer.target,
    socket_path: peer.socketPath,
    conversation_id: peer.conversationId,
    workspace_root: peer.workspaceRoot,
    pid: peer.pid,
    explicit: peer.explicit,
    source: peer.source,
    registered_at: peer.registeredAt,
    updated_at: peer.updatedAt,
  }
}

function bridgePeerJson(peer: BridgePeerRecord): Record<string, unknown> {
  return {
    id: peer.id,
    session_id: peer.sessionId,
    target: peer.target,
    label: peer.label,
    workspace_root: peer.workspaceRoot,
    machine_name: peer.machineName,
    status: peer.status,
    inbound_enabled: peer.inboundEnabled,
    last_error: peer.lastError,
    registered_at: peer.registeredAt,
    updated_at: peer.updatedAt,
  }
}

function peerXmlLine(peer: Awaited<ReturnType<TeamService['listPeers']>>['peers'][number]): string {
  return [
    '<peer',
    optionalXmlAttr('name', peer.name),
    optionalXmlAttr('agent_id', peer.agentId),
    optionalXmlAttr('target', peerTarget(peer.name)),
    optionalXmlAttr('role', peer.isLead ? 'lead' : peer.agentType),
    optionalXmlAttr('agent_type', peer.agentType),
    optionalXmlAttr('backend_type', peer.backendType),
    optionalXmlAttr('active', peer.isActive),
    optionalXmlAttr('is_lead', peer.isLead),
    optionalXmlAttr('unread_messages', peer.unreadMessages),
    optionalXmlAttr('mode', peer.mode),
    optionalXmlAttr('session_id', peer.sessionId),
    optionalXmlAttr('tmux_pane_id', peer.tmuxPaneId),
    optionalXmlAttr('cwd', peer.cwd),
    optionalXmlAttr('worktree_path', peer.worktreePath),
    optionalXmlAttr('color', peer.color),
    optionalXmlAttr('joined_at', peer.joinedAt),
    peer.subscriptions.length > 0 ? ` subscriptions="${xmlAttr(peer.subscriptions.join(','))}"` : '',
    ' />',
  ].join('')
}

function udsPeerXmlLine(peer: UdsPeerRecord): string {
  return [
    '<peer',
    optionalXmlAttr('name', peer.target),
    optionalXmlAttr('agent_id', peer.id),
    optionalXmlAttr('target', peer.target),
    optionalXmlAttr('role', 'cross-session'),
    optionalXmlAttr('backend_type', 'uds'),
    optionalXmlAttr('active', true),
    optionalXmlAttr('is_lead', false),
    optionalXmlAttr('unread_messages', 0),
    optionalXmlAttr('session_id', peer.conversationId),
    optionalXmlAttr('cwd', peer.workspaceRoot),
    optionalXmlAttr('socket_path', peer.socketPath),
    optionalXmlAttr('pid', peer.pid),
    optionalXmlAttr('explicit', peer.explicit),
    optionalXmlAttr('source', peer.source),
    optionalXmlAttr('joined_at', peer.registeredAt),
    ' />',
  ].join('')
}

function bridgePeerXmlLine(peer: BridgePeerRecord): string {
  return [
    '<peer',
    optionalXmlAttr('name', peer.label || peer.target),
    optionalXmlAttr('agent_id', peer.id),
    optionalXmlAttr('target', peer.target),
    optionalXmlAttr('role', 'remote-control'),
    optionalXmlAttr('backend_type', 'bridge'),
    optionalXmlAttr('active', peer.status === 'connected' && peer.inboundEnabled),
    optionalXmlAttr('is_lead', false),
    optionalXmlAttr('unread_messages', 0),
    optionalXmlAttr('session_id', peer.sessionId),
    optionalXmlAttr('cwd', peer.workspaceRoot),
    optionalXmlAttr('machine_name', peer.machineName),
    optionalXmlAttr('status', peer.status),
    optionalXmlAttr('inbound_enabled', peer.inboundEnabled),
    optionalXmlAttr('last_error', peer.lastError),
    optionalXmlAttr('joined_at', peer.registeredAt),
    ' />',
  ].join('')
}

function peerLegacyLine(peer: Awaited<ReturnType<TeamService['listPeers']>>['peers'][number]): string {
  return [
    `- ${peer.name} (${peer.agentId})`,
    `active=${peer.isActive}`,
    `unread=${peer.unreadMessages}`,
    peer.agentType ? `role=${peer.agentType}` : undefined,
    peer.backendType ? `backend=${peer.backendType}` : undefined,
    peer.sessionId ? `session=${peer.sessionId}` : undefined,
    peer.worktreePath ? `worktree=${peer.worktreePath}` : undefined,
    `target=${peerTarget(peer.name)}`,
  ].filter(Boolean).join(' ')
}

function udsPeerLegacyLine(peer: UdsPeerRecord): string {
  return [
    `- ${peer.target} (${peer.id})`,
    'active=true',
    'backend=uds',
    peer.conversationId ? `session=${peer.conversationId}` : undefined,
    peer.workspaceRoot ? `cwd=${peer.workspaceRoot}` : undefined,
    `socket=${peer.socketPath}`,
    `target=${peer.target}`,
  ].filter(Boolean).join(' ')
}

function bridgePeerLegacyLine(peer: BridgePeerRecord): string {
  return [
    `- ${peer.label || peer.target} (${peer.id})`,
    `active=${peer.status === 'connected' && peer.inboundEnabled}`,
    'backend=bridge',
    `session=${peer.sessionId}`,
    peer.workspaceRoot ? `cwd=${peer.workspaceRoot}` : undefined,
    peer.machineName ? `machine=${peer.machineName}` : undefined,
    `status=${peer.status}`,
    `target=${peer.target}`,
  ].filter(Boolean).join(' ')
}

function peersJsonBlock(value: unknown): string {
  return `<peers_json>\n${xmlText(jsonOutput(value))}\n</peers_json>`
}

function backgroundAgentMatchSummary(task: TaskMeta): Record<string, unknown> {
  return {
    task_id: task.id,
    agent_id: typeof task.params?.agent_id === 'string' ? task.params.agent_id : undefined,
    status: task.status,
    title: task.title,
    agent: typeof task.params?.agent === 'string' ? task.params.agent : undefined,
    name: typeof task.params?.name === 'string' ? task.params.name : undefined,
  }
}

function ambiguousBackgroundAgentOutput(to: string, resolution: BackgroundAgentTargetResolution, statusLabel: string): string {
  return jsonOutput({
    success: false,
    message: resolution.reason || `Multiple ${statusLabel} background agents match "${to}". Use a task id or custom agent name.`,
    ambiguous: true,
    matches: (resolution.matches ?? []).map(backgroundAgentMatchSummary),
  })
}

async function activeTeamName(teams: TeamService): Promise<string> {
  return (await teams.getActiveTeam())?.teamName ?? 'default'
}

async function sendPlainMessage(teams: TeamService, input: Required<Pick<SendMessageInput, 'to'>> & Omit<SendMessageInput, 'to'>): Promise<string> {
  if (typeof input.message !== 'string') throw new Error('SendMessage plain message requires string message')
  if (!input.summary?.trim()) throw new Error('summary is required when message is a string')
  const teamName = await activeTeamName(teams)
  await teams.writeToMailbox(input.to, {
    from: TEAM_LEAD_NAME,
    text: input.message,
    summary: input.summary.trim(),
    timestamp: new Date().toISOString(),
  }, teamName)
  return jsonOutput({
    success: true,
    message: `Message sent to ${input.to}'s inbox`,
    routing: {
      sender: TEAM_LEAD_NAME,
      target: `@${input.to}`,
      summary: input.summary.trim(),
      content: input.message,
    },
  })
}

async function sendUdsPlainMessage(to: string, socketPath: string, message: string, summary?: string): Promise<string> {
  await sendToUdsSocket(socketPath, message)
  const preview = summary?.trim() || message.slice(0, 50)
  return jsonOutput({
    success: true,
    message: `"${preview}" -> ${to}`,
    routing: {
      sender: TEAM_LEAD_NAME,
      target: to,
      summary: summary?.trim() || undefined,
      content: message,
    },
  })
}

async function sendBridgePlainMessage(options: TeamToolsOptions, to: string, sessionId: string, message: string, summary: string | undefined, ctx: ToolContext): Promise<string> {
  const peer = await options.bridgePeers?.get(sessionId).catch(() => null) ?? null
  if (!peer) {
    return jsonOutput({
      success: false,
      message: `Remote Control is not connected - cannot send to ${to}. Reconnect with /remote-control first.`,
      routing: {
        sender: TEAM_LEAD_NAME,
        target: to,
        summary: summary?.trim() || undefined,
        content: message,
      },
    })
  }
  if (peer.status !== 'connected' || !peer.inboundEnabled) {
    return jsonOutput({
      success: false,
      message: `Remote Control peer ${to} is ${peer.status}${peer.inboundEnabled ? '' : ' (inbound disabled)'}.`,
      routing: {
        sender: TEAM_LEAD_NAME,
        target: to,
        summary: summary?.trim() || undefined,
        content: message,
      },
      peer: bridgePeerJson(peer),
    })
  }
  if (!options.sendBridgeMessage) {
    return jsonOutput({
      success: false,
      message: `Remote Control transport is not connected - cannot deliver to ${to}.`,
      routing: {
        sender: TEAM_LEAD_NAME,
        target: to,
        summary: summary?.trim() || undefined,
        content: message,
      },
      peer: bridgePeerJson(peer),
    })
  }
  const result = await options.sendBridgeMessage(sessionId, message, ctx)
  const preview = summary?.trim() || message.slice(0, 50)
  return jsonOutput({
    success: result.ok,
    message: result.ok ? `"${preview}" -> ${to}` : `Failed to send to ${to}: ${result.error ?? 'unknown'}`,
    routing: {
      sender: TEAM_LEAD_NAME,
      target: to,
      summary: summary?.trim() || undefined,
      content: message,
    },
    peer: bridgePeerJson(peer),
  })
}

async function trySendToRunningBackgroundAgent(options: TeamToolsOptions, to: string, message: string, ctx: ToolContext): Promise<string | null> {
  if (!options.tasks) return null
  const resolution = await options.tasks.resolveBackgroundAgentTarget(to, {
    conversationId: ctx.conversationId,
    statuses: ['running'],
  })
  if (resolution.ambiguous) return ambiguousBackgroundAgentOutput(to, resolution, 'running')
  const task = resolution.task
  if (!task) return null
  const queued = await options.tasks.queueSteerMessage(task.id, message)
  if (!queued) return null
  return jsonOutput({
    success: true,
    message: `Message queued for delivery to ${to} at its next tool round.`,
    task_id: task.id,
    agent_id: typeof task.params?.agent_id === 'string' ? task.params.agent_id : undefined,
    routing: {
      sender: TEAM_LEAD_NAME,
      target: `@${to}`,
      content: message,
    },
  })
}

async function tryResumeStoppedBackgroundAgent(options: TeamToolsOptions, to: string, message: string, ctx: ToolContext): Promise<string | null> {
  if (!options.tasks || !options.resumeBackgroundAgent) return null
  const resolution = await options.tasks.resolveBackgroundAgentTarget(to, {
    conversationId: ctx.conversationId,
    statuses: ['completed', 'failed', 'cancelled'],
  })
  if (resolution.ambiguous) return ambiguousBackgroundAgentOutput(to, resolution, 'stopped')
  const previous = resolution.task
  if (!previous) return null
  try {
    const resumed = await options.resumeBackgroundAgent(previous, message, ctx)
    return jsonOutput({
      success: true,
      message: `Agent "${to}" was stopped (${previous.status}); resumed it in the background with your message.`,
      task_id: resumed.task.id,
      agent_id: typeof resumed.task.params?.agent_id === 'string' ? resumed.task.params.agent_id : undefined,
      resumed_from: previous.id,
      routing: {
        sender: TEAM_LEAD_NAME,
        target: `@${to}`,
        content: message,
      },
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return jsonOutput({
      success: false,
      message: `Agent "${to}" is stopped (${previous.status}) and could not be resumed: ${detail}`,
      resumed_from: previous.id,
    })
  }
}

async function broadcastPlainMessage(teams: TeamService, input: Required<Pick<SendMessageInput, 'to'>> & Omit<SendMessageInput, 'to'>): Promise<string> {
  if (typeof input.message !== 'string') throw new Error('SendMessage broadcast requires string message')
  if (!input.summary?.trim()) throw new Error('summary is required when message is a string')
  const active = await teams.getActiveTeam()
  if (!active) throw new Error('Not in a team context. Create a team with TeamCreate first.')
  const team = await teams.readTeam(active.teamName)
  if (!team) throw new Error(`Team "${active.teamName}" does not exist`)
  const recipients = team.members
    .map(member => member.name)
    .filter(name => name.toLowerCase() !== TEAM_LEAD_NAME.toLowerCase())
  for (const recipient of recipients) {
    await teams.writeToMailbox(recipient, {
      from: TEAM_LEAD_NAME,
      text: input.message,
      summary: input.summary.trim(),
      timestamp: new Date().toISOString(),
    }, active.teamName)
  }
  return jsonOutput({
    success: true,
    message: recipients.length === 0
      ? 'No teammates to broadcast to (you are the only team member)'
      : `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
    recipients,
    routing: recipients.length > 0
      ? {
          sender: TEAM_LEAD_NAME,
          target: '@team',
          summary: input.summary.trim(),
          content: input.message,
        }
      : undefined,
  })
}

async function sendStructuredMessage(teams: TeamService, to: string, message: StructuredMessage, ctx: ToolContext): Promise<string> {
  if (to === '*') throw new Error('structured messages cannot be broadcast')
  const active = await teams.getActiveTeam()
  const teamName = active?.teamName ?? 'default'
  if (message.type === 'shutdown_request') {
    const requestId = generateRequestId('shutdown', to)
    const shutdownMessage = {
      type: 'shutdown_request',
      requestId,
      from: TEAM_LEAD_NAME,
      reason: message.reason,
      timestamp: new Date().toISOString(),
    }
    await teams.writeToMailbox(to, {
      from: TEAM_LEAD_NAME,
      text: JSON.stringify(shutdownMessage),
      timestamp: new Date().toISOString(),
    }, teamName)
    return jsonOutput({
      success: true,
      message: `Shutdown request sent to ${to}. Request ID: ${requestId}`,
      request_id: requestId,
      target: to,
    })
  }
  if (message.type === 'shutdown_response') {
    if (to !== TEAM_LEAD_NAME) throw new Error(`shutdown_response must be sent to "${TEAM_LEAD_NAME}"`)
    const requestId = requestIdFrom(message)
    if (!requestId) throw new Error('request_id is required for shutdown_response')
    const approve = semanticBoolean(message.approve, false)
    if (!approve && !message.reason?.trim()) throw new Error('reason is required when rejecting a shutdown request')
    const response = approve
      ? {
          type: 'shutdown_approved',
          requestId,
          from: TEAM_LEAD_NAME,
          timestamp: new Date().toISOString(),
        }
      : {
          type: 'shutdown_rejected',
          requestId,
          from: TEAM_LEAD_NAME,
          reason: message.reason!.trim(),
          timestamp: new Date().toISOString(),
        }
    await teams.writeToMailbox(TEAM_LEAD_NAME, {
      from: TEAM_LEAD_NAME,
      text: JSON.stringify(response),
      timestamp: new Date().toISOString(),
    }, teamName)
    return jsonOutput({
      success: true,
      message: approve
        ? 'Shutdown approved. Sent confirmation to team-lead.'
        : `Shutdown rejected. Reason: "${message.reason!.trim()}". Continuing to work.`,
      request_id: requestId,
    })
  }

  const requestId = requestIdFrom(message)
  if (!requestId) throw new Error('request_id is required for plan_approval_response')
  const approve = semanticBoolean(message.approve, false)
  const mode = ctx.permissionMode === 'plan' ? 'default' : ctx.permissionMode
  const response = {
    type: 'plan_approval_response',
    requestId,
    approved: approve,
    feedback: approve ? undefined : message.feedback ?? 'Plan needs revision',
    timestamp: new Date().toISOString(),
    permissionMode: approve ? mode : undefined,
  }
  await teams.writeToMailbox(to, {
    from: TEAM_LEAD_NAME,
    text: JSON.stringify(response),
    timestamp: new Date().toISOString(),
  }, teamName)
  return jsonOutput({
    success: true,
    message: approve
      ? `Plan approved for ${to}. They will receive the approval and can proceed with implementation.`
      : `Plan rejected for ${to} with feedback: "${response.feedback}"`,
    request_id: requestId,
  })
}

export function createTeamTools(teams: TeamService, options: TeamToolsOptions = {}): Tool[] {
  const teamCreate: Tool<TeamCreateInput> = {
    name: 'TeamCreate',
    description: 'Create a CC-Haha-compatible local team for coordinating multiple coding agents. Input: { team_name, description?, agent_type? }.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: { type: 'string', description: 'Name for the new team to create.' },
        description: { type: 'string', description: 'Team description or purpose.' },
        agent_type: { type: 'string', description: 'Type or role of the team lead.' },
      },
      required: ['team_name'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const args = recordInput(input)
      const teamName = stringValue(args.team_name) || stringValue(args.teamName)
      if (!teamName) throw new Error('team_name is required for TeamCreate')
      const active = await teams.createTeam({
        teamName,
        description: stringValue(args.description) || undefined,
        agentType: stringValue(args.agent_type) || stringValue(args.agentType) || undefined,
        cwd: ctx.workspace.root,
        conversationId: ctx.conversationId,
      })
      return jsonOutput({
        team_name: active.teamName,
        team_file_path: active.teamFilePath,
        lead_agent_id: active.leadAgentId,
      })
    },
  }

  const teamDelete: Tool = {
    name: 'TeamDelete',
    description: 'Disband the active local team and clean up CC-Haha-compatible team directories. Input: {}.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'destructive',
    forceConfirm: true,
    approvalReasonFor() {
      return {
        what: '删除当前 team 状态目录',
        why: 'TeamDelete 会清理当前 active team 的 config 和 inbox 文件。',
        impact: '未读消息和 team 元数据会被删除;有活跃非 leader 成员时会拒绝执行。',
      }
    },
    async execute() {
      return jsonOutput(await teams.deleteActiveTeam())
    },
  }

  const sendMessage: Tool<SendMessageInput> = {
    name: 'SendMessage',
    description: [
      'Send a message to another local team agent. CC-Haha-compatible SendMessage.',
      'Input: { to, summary?, message }. Use to:"*" for broadcast. Plain string messages require summary.',
      'Also supports plain text to uds:/path/to.sock local peers and bridge:session_id Remote Control peers. Cross-session messages do not require summary.',
      'Structured messages supported: shutdown_request, shutdown_response, plan_approval_response.',
      'bridge: targets require explicit user approval and a connected Remote Control transport.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient teammate name, "*" for broadcast, uds:/path/to.sock for a local peer, or bridge:session_id for a Remote Control peer.' },
        summary: { type: 'string', description: '5-10 word preview, required when message is a string.' },
        message: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['shutdown_request', 'shutdown_response', 'plan_approval_response'] },
                request_id: { type: 'string' },
                approve: { type: ['boolean', 'string'] },
                reason: { type: 'string' },
                feedback: { type: 'string' },
              },
              required: ['type'],
            },
          ],
        },
      },
      required: ['to', 'message'],
    },
    isReadOnly: false,
    requiresApprovalFor(input) {
      const to = stringValue(recordInput(input).to)
      return parsePeerAddress(to).scheme === 'bridge'
    },
    approvalClassFor(input) {
      const to = stringValue(recordInput(input).to)
      return parsePeerAddress(to).scheme === 'bridge' ? 'outreach' : undefined
    },
    forceConfirmFor(input) {
      const to = stringValue(recordInput(input).to)
      return parsePeerAddress(to).scheme === 'bridge'
    },
    approvalReasonFor(input) {
      const args = recordInput(input)
      const to = stringValue(args.to)
      return {
        what: `向 Remote Control 会话 ${to || '(未指定)'} 发送消息`,
        why: 'bridge 目标会把内容作为用户提示发送到可能位于其他机器的远端会话。',
        impact: '对端模型会读取并处理这段文本;确认前不会发送。',
      }
    },
    async execute(input, ctx) {
      const normalized = normalizeSendInput(input)
      if (!normalized.to) throw new Error('to must not be empty')
      const address = parsePeerAddress(normalized.to)
      if (address.target.trim().length === 0) throw new Error('address target must not be empty')
      if (address.scheme === 'other' && normalized.to.includes('@')) throw new Error('to must be a bare teammate name or "*" - there is only one team per session')
      if (normalized.message === undefined) throw new Error('message is required')
      if (typeof normalized.message === 'string') {
        if (address.scheme === 'bridge') return sendBridgePlainMessage(options, normalized.to, address.target, normalized.message, normalized.summary, ctx)
        if (address.scheme === 'uds') return sendUdsPlainMessage(normalized.to, address.target, normalized.message, normalized.summary)
        if (normalized.to === '*') return broadcastPlainMessage(teams, normalized)
        const routed = await trySendToRunningBackgroundAgent(options, normalized.to, normalized.message, ctx)
        if (routed) return routed
        const resumed = await tryResumeStoppedBackgroundAgent(options, normalized.to, normalized.message, ctx)
        if (resumed) return resumed
        return sendPlainMessage(teams, normalized)
      }
      if (address.scheme !== 'other') throw new Error('structured messages cannot be sent cross-session - only plain text')
      return sendStructuredMessage(teams, normalized.to, normalized.message, ctx)
    },
  }

  const listPeers: Tool<ListPeersInput> = {
    name: 'ListPeers',
    description: 'List local team members, UDS peers, Remote Control bridge peers, SendMessage targets, unread mailbox counts, and peer metadata. Returns <peers> plus a parseable <peers_json> block. Input: { team_name?, include_inbox? }; camel-case aliases are accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        team_name: { type: 'string', description: 'Optional team name. Defaults to the active team.' },
        teamName: { type: 'string', description: 'Camel-case alias for team_name.' },
        include_inbox: { type: ['boolean', 'string'], description: 'Include unread message previews.' },
        includeInbox: { type: ['boolean', 'string'], description: 'Camel-case alias for include_inbox.' },
      },
    },
    isReadOnly: true,
    async execute(input) {
      const args = recordInput(input)
      const requestedTeamName = stringValue(args.team_name) || stringValue(args.teamName) || undefined
      const includeInbox = semanticBoolean(args.include_inbox ?? args.includeInbox, false)
      const teamInfo = await teams.listPeers(requestedTeamName)
      const { teamName, peers } = teamInfo
      const udsPeers = await options.udsPeers?.list().catch(() => []) ?? []
      const bridgePeers = await options.bridgePeers?.list().catch(() => []) ?? []
      const inboxBlocks: string[] = []
      if (includeInbox && teamName) {
        for (const peer of peers) {
          const unread = await teams.readUnreadMessages(peer.name, teamName)
          if (unread.length > 0) {
            inboxBlocks.push([
              `<inbox peer="${xmlAttr(peer.name)}" unread_messages="${unread.length}">`,
              formatTeammateMessages(unread),
              '</inbox>',
            ].join('\n'))
          }
        }
      }
      const data = {
        team_name: teamName,
        team_file_path: teamInfo.teamFilePath,
        lead_agent_id: teamInfo.leadAgentId,
        lead_session_id: teamInfo.leadSessionId,
        description: teamInfo.description,
        created_at: teamInfo.createdAt,
        active_team: teamInfo.isActiveTeam,
        peer_count: peers.length + udsPeers.length + bridgePeers.length,
        local_peer_count: peers.length,
        uds_peer_count: udsPeers.length,
        bridge_peer_count: bridgePeers.length,
        peers: peers.map(peerJson),
        uds_peers: udsPeers.map(udsPeerJson),
        bridge_peers: bridgePeers.map(bridgePeerJson),
        send_message: {
          local_targets: peers.map(peer => peerTarget(peer.name)),
          uds_targets: udsPeers.map(peer => peer.target),
          bridge_targets: bridgePeers.map(peer => peer.target),
          all_targets: [...peers.map(peer => peerTarget(peer.name)), ...udsPeers.map(peer => peer.target), ...bridgePeers.map(peer => peer.target)],
          broadcast_target: '*',
          cross_session_targets_enabled: true,
          uds_targets_enabled: true,
          bridge_targets_enabled: bridgePeers.some(peer => peer.status === 'connected' && peer.inboundEnabled),
        },
      }
      return [
        [
          `<peers team="${xmlAttr(teamName ?? '')}" count="${peers.length + udsPeers.length + bridgePeers.length}"`,
          optionalXmlAttr('active_team', teamInfo.isActiveTeam),
          optionalXmlAttr('lead_agent_id', teamInfo.leadAgentId),
          optionalXmlAttr('lead_session_id', teamInfo.leadSessionId),
          optionalXmlAttr('team_file_path', teamInfo.teamFilePath),
          optionalXmlAttr('local_peer_count', peers.length),
          optionalXmlAttr('uds_peer_count', udsPeers.length),
          optionalXmlAttr('bridge_peer_count', bridgePeers.length),
          '>',
        ].join(''),
        ...peers.map(peerXmlLine),
        ...udsPeers.map(udsPeerXmlLine),
        ...bridgePeers.map(bridgePeerXmlLine),
        ...peers.map(peerLegacyLine),
        ...udsPeers.map(udsPeerLegacyLine),
        ...bridgePeers.map(bridgePeerLegacyLine),
        '</peers>',
        peersJsonBlock(data),
        ...inboxBlocks.filter(Boolean),
      ].join('\n')
    },
  }

  return [teamCreate, teamDelete, sendMessage, listPeers]
}
