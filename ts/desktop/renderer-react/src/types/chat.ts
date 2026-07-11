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
      /** 本会话的工作目录:审批放行的执行必须跑在原会话目录(漏带时后端从 session meta 自愈)。 */
      working_dir?: string
      /** 本会话已挂的领域包:审批放行的执行要带,否则拿不到包工具/命令(漏带时后端从 session meta 自愈)。 */
      enabled_packs?: string[]
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

/** 会话列表项(GET /sessions → { sessions: SessionSummary[] })。
 *  ⚠️ 后端 meta 的时间是 ISO 字符串,sessionStore.refresh 在入口统一转成 epoch ms(不然相对时间算出 NaN)。 */
export interface SessionSummary {
  id: string
  title?: string
  status?: string
  updatedAt: number
  createdAt?: number
  workspaceRoot?: string
  /** 前端本地态(置顶/归档);后端持久化就绪前只在本地生效。 */
  pinned?: boolean
  archived?: boolean
}

/** 项目 = 工作目录(GET /sessions/projects → { projects: ProjectSummary[] },后端按会话的 workspaceRoot 聚合)。
 *  对齐 cc(项目=cwd slug,transcript 按 projects/<slug>/ 分区)与 Codex(项目=文件夹,对话归属项目)。 */
export interface ProjectSummary {
  workspaceRoot: string
  sessionCount: number
  lastUpdatedAt: string
  lastSessionId: string
  lastTitle: string
  /** 默认工作目录:它的会话归「对话」组,不当项目显示(对齐 Codex 无项目任务)。 */
  isDefault: boolean
}
