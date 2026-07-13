// SSE/WS 出站编帧:会话事件流的 wire 格式、WS 安全发送与降级事件记录。

import type { SessionEventRecord, SessionStreamEvent } from './services/sessionService'
import type { ServerMessage as AgentServerMessage } from '../../shared/contracts/agent-websocket'

export function sseLine(ev: SessionStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

export function sseReplayLine(seq: number, ev: SessionStreamEvent): string {
  return `id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

export function legacySseLine(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function wsSend(ws: { send(data: string): unknown }, data: AgentServerMessage): void {
  try {
    ws.send(JSON.stringify(data))
  } catch {
    // WebSocket 可能已经断开;turn 继续跑并落 event log,下次连接 replay。
  }
}

export function wsError(ws: { send(data: string): unknown }, message: string): void {
  wsSend(ws, { type: 'error', error: message })
}

export function fallbackEventRecord(event: SessionStreamEvent): SessionEventRecord {
  return { seq: 0, ts: new Date().toISOString(), event }
}
