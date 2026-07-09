// WS 消息信封(顶层 type),与后端 ts/src/server/index.ts 的 /agent/ws handler 逐字段对齐。
//  - 客户端 → 服务端 = ClientMessage(handler 的 message() 分支)
//  - 服务端 → 客户端 = ServerMessage(wsSend/wsError/handleWsRun 发出的)
import type { SessionStreamEvent } from './events'

/** 权限五档(对齐 cc / 后端 permissionModeFrom)。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

/** 客户端 → 服务端。 */
export type ClientMessage =
  | {
      type: 'run'
      message: string
      conversationId: string
      permissionMode?: PermissionMode
      enabled_packs?: string[]
      working_dir?: string
    }
  | { type: 'replay'; conversationId: string; after: number }
  | { type: 'ping'; ts?: number }
  | { type: 'interrupt'; conversationId: string }
  | { type: 'steer'; message: string; conversationId: string }
  | {
      type: 'approve'
      tool: string
      args: unknown
      token: string
      conversationId: string
      permissionMode?: PermissionMode
      remember_approval?: boolean
    }
  | { type: 'reject'; tool: string; args: unknown; conversationId: string }

/** 服务端 → 客户端。 */
export type ServerMessage =
  | { type: 'ready'; conversationId: string }
  | { type: 'error'; error: string }
  | { type: 'pong'; ts?: number }
  | { type: 'event'; seq: number; ts: number; event: SessionStreamEvent; replay?: boolean }
  | { type: 'approve_result'; [key: string]: unknown }
  | { type: 'reject_result'; ok: boolean }
  | { type: 'steer_result'; conversationId: string; queued: number; running: boolean }
  | { type: 'interrupt_result'; conversationId: string; interrupted: boolean }

/** 会话列表项(GET /sessions → { sessions: SessionSummary[] })。 */
export interface SessionSummary {
  id: string
  title?: string
  status?: string
  updatedAt: number
  createdAt?: number
  workspaceRoot?: string
}
