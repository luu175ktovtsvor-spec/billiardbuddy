// Agent WebSocket 传输编排。共享契约负责入站解析，具体回合、审批和持久化行为由依赖服务负责。

import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { parseClientMessage } from '../../shared/contracts/agent-websocket'
import type { ToolContext } from '../tools/Tool'
import type { SessionEventRecord, SessionStreamEvent } from './services/sessionService'
import { numberFrom, permissionModeFrom, stringOr } from './requestParams'
import { wsError, wsSend } from './sse'
import { workspaceFromBody } from './turnInput'

export interface AgentWsData {
  conversationId: string
  after: number
}

type AgentWebSocket = ServerWebSocket<AgentWsData>

interface AgentWebSocketDependencies {
  assetTopic: string
  turnConsumers: {
    onConnect(conversationId: string): void
    onDisconnect(conversationId: string): void
  }
  turns: {
    interrupt(conversationId: string): boolean
    isRunning(conversationId: string): boolean
  }
  sessions: {
    touch(conversationId: string, patch: { status: 'interrupted' }): Promise<unknown>
    appendEvent(conversationId: string, event: SessionStreamEvent): Promise<SessionEventRecord>
  }
  steerInboxes: Map<string, string[]>
  interruptRequesters: Map<string, () => void>
  replayEvents(ws: AgentWebSocket, conversationId: string, after: number): Promise<void>
  runTurn(ws: AgentWebSocket, body: Record<string, unknown>): Promise<void>
  runApprovedTool(body: Record<string, unknown>): Promise<Record<string, unknown> | null>
  resolvePendingApproval(
    conversationId: string,
    input: { behavior: 'allow'; tool: string; token?: string; remember?: boolean } | { behavior: 'deny'; tool: string; message?: string },
  ): boolean
  rejectTool(tool: string, args: unknown, context: ToolContext): void
}

export function createAgentWebSocketHandler(deps: AgentWebSocketDependencies): WebSocketHandler<AgentWsData> {
  return {
    open(ws) {
      deps.turnConsumers.onConnect(ws.data.conversationId)
      ws.subscribe(deps.assetTopic)
      wsSend(ws, { type: 'ready', conversationId: ws.data.conversationId })
      if (ws.data.after > 0) {
        void deps.replayEvents(ws, ws.data.conversationId, ws.data.after)
          .catch(error => wsError(ws, error instanceof Error ? error.message : String(error)))
      }
    },
    close(ws) {
      deps.turnConsumers.onDisconnect(ws.data.conversationId)
    },
    message(ws, message) {
      let body: Record<string, unknown>
      try {
        const parsed = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'))
        body = { ...parseClientMessage(parsed) }
      } catch {
        wsError(ws, 'invalid websocket message')
        return
      }

      const type = body.type
      if (type === 'ping') {
        wsSend(ws, { type: 'pong', ts: numberFrom(body.ts, 0) || undefined })
        return
      }
      if (type === 'run') {
        void deps.runTurn(ws, body)
        return
      }
      if (type === 'replay') {
        const conversationId = stringOr(body.conversationId, ws.data.conversationId)
        const after = numberFrom(body.after, 0)
        ws.data.conversationId = conversationId
        void deps.replayEvents(ws, conversationId, after)
          .catch(error => wsError(ws, error instanceof Error ? error.message : String(error)))
        return
      }
      if (type === 'interrupt') {
        const conversationId = stringOr(body.conversationId, ws.data.conversationId)
        const interrupted = deps.turns.interrupt(conversationId)
        void (async () => {
          if (interrupted) {
            await deps.sessions.touch(conversationId, { status: 'interrupted' })
            const record = await deps.sessions.appendEvent(conversationId, { type: 'context_note', text: '任务已请求中断' }).catch(() => null)
            if (record) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
          }
          wsSend(ws, { type: 'interrupt_result', conversationId, interrupted })
        })().catch(error => wsError(ws, error instanceof Error ? error.message : String(error)))
        return
      }
      if (type === 'steer') {
        const conversationId = stringOr(body.conversationId, ws.data.conversationId)
        const steerMessage = typeof body.message === 'string' ? body.message.trim() : ''
        if (!steerMessage) {
          wsError(ws, 'steer message required')
          return
        }
        void (async () => {
          if (!deps.turns.isRunning(conversationId)) {
            wsSend(ws, { type: 'steer_result', conversationId, queued: 0, running: false })
            return
          }
          const inbox = deps.steerInboxes.get(conversationId) ?? []
          inbox.push(steerMessage)
          deps.steerInboxes.set(conversationId, inbox)
          deps.interruptRequesters.get(conversationId)?.()
          const record = await deps.sessions.appendEvent(conversationId, { type: 'steering', content: steerMessage }).catch(() => null)
          if (record) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
          wsSend(ws, { type: 'steer_result', conversationId, queued: inbox.length, running: true })
        })().catch(error => wsError(ws, error instanceof Error ? error.message : String(error)))
        return
      }
      if (type === 'approve') {
        void (async () => {
          const conversationId = stringOr(body.conversation_id ?? body.conversationId, ws.data.conversationId)
          const tool = typeof body.tool === 'string' ? body.tool.trim() : ''
          const resumed = tool ? deps.resolvePendingApproval(conversationId, {
            behavior: 'allow',
            tool,
            token: typeof body.token === 'string' ? body.token : undefined,
            remember: body.remember_approval === true || body.rememberApproval === true,
          }) : false
          if (resumed) {
            wsSend(ws, { type: 'approve_result', ok: true, tool, resumed: true })
            return
          }
          const payload = await deps.runApprovedTool(body)
          if (!payload) {
            wsError(ws, 'tool required')
            return
          }
          wsSend(ws, { type: 'approve_result', ...payload })
        })().catch(error => wsError(ws, error instanceof Error ? error.message : String(error)))
        return
      }
      if (type === 'reject') {
        const toolName = typeof body.tool === 'string' ? body.tool.trim() : ''
        if (!toolName) {
          wsError(ws, 'tool required')
          return
        }
        const conversationId = stringOr(body.conversation_id ?? body.conversationId, ws.data.conversationId)
        const resumed = deps.resolvePendingApproval(conversationId, { behavior: 'deny', tool: toolName, message: '用户拒绝了本次工具调用。' })
        if (!resumed) deps.rejectTool(toolName, body.args ?? {}, {
          workspace: workspaceFromBody(body),
          conversationId: conversationId || undefined,
          permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
        })
        wsSend(ws, { type: 'reject_result', ok: true })
        return
      }
      wsError(ws, `unknown websocket message type: ${type}`)
    },
  }
}
