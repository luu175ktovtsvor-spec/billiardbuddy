// WS 信封的权威 Schema 与类型位于 ts/shared/contracts，renderer 不再手写镜像。
export {
  clientMessageSchema,
  parseServerMessage,
  permissionModeSchema,
  serverMessageSchema,
} from '../../../../shared/contracts/agent-websocket'
export type {
  ClientMessage,
  PermissionMode,
  ServerMessage,
} from '../../../../shared/contracts/agent-websocket'

/** 会话列表项(GET /sessions → { sessions: SessionSummary[] })。
 *  ⚠️ 后端 meta 的时间是 ISO 字符串,sessionStore.refresh 在入口统一转成 epoch ms(不然相对时间算出 NaN)。 */
export interface SessionSummary {
  id: string
  title?: string
  status?: string
  updatedAt: number
  createdAt?: number
  workspaceRoot?: string
  /** 会话挂载的领域包(如 ['billiards']);打开老会话时前端 adopt 兜底恢复,跨重启记住每个窗口开没开台球。 */
  enabledPacks?: string[]
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
