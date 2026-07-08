import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { AdditionalWorkingDirectory, ApprovalClass, ApprovalReason, PermissionMode, PermissionRule } from '../permissions/types'
import type { TodoItem } from '../types/todo'
import type { Model } from '../types/model'
import type { Message } from '../types/message'
import type { ToolRegistry } from './registry'
import type { ContentReplacementState } from '../context/toolResultStorage'
import type { DenialTrackingState } from '../permissions/denialTracking'
import type { HookRegistry } from '../hooks/hooks'

export interface FileReadSnapshot {
  path: string
  mtimeMs: number
  size: number
}

export interface ToolProgressEvent {
  type?: 'tool_progress'
  tool?: string
  id?: string
  stream?: 'stdout' | 'stderr' | string
  chunk: string
}

export type JSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export interface ToolContext {
  workspace: Workspace
  /** 当前会话模型出口,供 prompt/agent hooks、子代理等内核扩展执行非流式校验。 */
  model?: Model
  /** 当前会话工具注册表,供 agent hooks 启动受限 verifier agent。 */
  registry?: ToolRegistry
  signal?: AbortSignal
  sandbox?: Sandbox
  /** 权限档,默认 'default'。W4a 权限瀑布读它。 */
  permissionMode?: PermissionMode
  /** 当前 slash command / inline skill 通过 allowedTools 授权的会话内工具名。 */
  sessionAllowedTools?: Set<string>
  /** 当前 slash command / inline skill 通过 allowedTools 授权的参数级工具规则。 */
  sessionAllowedToolRules?: Array<{ tool: string; ruleContent: string }>
  /** CC-Haha 风格结构化权限规则,保留 source + allow/deny/ask,供设置/命令/会话共同进入同一瀑布。 */
  permissionRules?: PermissionRule[]
  /** 工作区外目录授权地基:本轮先承载 source/path,后续接完整 path validator 与 UI。 */
  additionalWorkingDirectories?: Map<string, AdditionalWorkingDirectory>
  /** 当前 slash command / inline skill 注册的会话内 hooks。 */
  sessionHooks?: HookRegistry
  /** 会话内 hooks 变化时通知宿主持久化。 */
  onSessionHooksChanged?: (hooks: HookRegistry | undefined) => void
  /** 会话 id,跨请求拒绝计数按它隔离(见 denialTracking)。 */
  conversationId?: string
  /** 当前工具调用前的模型消息快照,供 fork/subagent guard 等运行时逻辑判断父上下文。 */
  messages?: Message[]
  /** 当前主循环使用的 system prompt 快照,供 fork child 继承父提示词并保持缓存前缀。 */
  systemPrompt?: string
  /** 当前主循环最终渲染后的 system prompt,供 fork child byte-exact 继承。 */
  renderedSystemPrompt?: string
  /** 当前运行来源标记,用于 fork worker 在压缩后仍能识别自身身份。 */
  querySource?: string
  /** 子代理/后台 worker 本地拒绝与记住审批状态,避免污染父会话。 */
  localDenialTracking?: DenialTrackingState
  /** 当前任务清单(todo_write / task_progress 内联维护,单一真相源)。 */
  todos?: TodoItem[]
  /** 老板插话收件箱(FIFO,路由 push、循环在安全点 drain)。 */
  steerInbox?: string[]
  /** 距上次更新进度已连着调了几次工具(到 PROGRESS_REMIND_EVERY 提醒一次)。 */
  requestsSinceProgress?: number
  /** 读前置编辑保护:read_file 记录快照,edit_file 改前校验 mtime/size 防覆盖外部改动。 */
  fileReads?: Map<string, FileReadSnapshot>
  /** 本轮已向模型展示过的目录级项目指令 scope,用于 write_file 新建文件前避免绕过子目录 AGENTS.md。 */
  projectInstructionScopes?: Set<string>
  /** 流式工具进度:run_command/慢工具在执行中向 Agent loop 推增量 UI 事件。 */
  progressEmit?: (event: ToolProgressEvent) => void
  /** 当前会话的大工具结果落盘目录,供 read_stored_tool_result 安全回读。 */
  toolResultStoreDir?: string
  /** 大工具结果替换状态,供主循环/子代理/续跑保持一致的上下文裁剪决策。 */
  contentReplacementState?: ContentReplacementState
  /** ExitPlanMode 批准后登记的待验证计划,VerifyPlanExecution 用它防止“没验就收工”。 */
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
    toolCallsSinceApproval?: number
    lastStatus?: 'pass' | 'fail' | 'partial' | 'needs_evidence'
    lastReason?: string
  }
  /** EnterWorktree/ExitWorktree 会话态:创建隔离 git worktree 后临时切换当前工具工作区。 */
  worktreeSession?: {
    originalRoot: string
    worktreePath: string
    worktreeName: string
    worktreeBranch: string
    originalHeadCommit: string
    conversationId?: string
  }
  /** executeApproved 临时标记:某个顶层动作已经由用户确认,复合工具可据此执行同批内部步骤但仍保留 fatal/forceConfirm 红线。 */
  approvedToolExecution?: {
    name: string
    key: string
  }
}

/** 模型可见的工具描述(function-calling 线上格式)。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
}

/**
 * Tool——W2 的 name/description/schema/execute + isReadOnly,W4a 追加权限元数据(全可选)。
 * 缺省口径 = 本机可逆动作、直接放行(Delta A):不设任何权限字段的工具永远 allow。
 * 只有对外/花钱/不可逆工具才设 requiresApproval / forceConfirm / approvalClass。
 */
export interface Tool<Input = unknown> {
  name: string
  description: string
  inputSchema: JSONSchema
  isReadOnly: boolean
  /** 动态只读判定:同一个工具按入参可能是只读或会动手(run_command 是典型)。 */
  isReadOnlyFor?(input: Input, ctx: ToolContext): boolean
  /** 静态:这工具总是要审批(发布/群发等)。 */
  requiresApproval?: boolean
  /** 审批类别,决定档位如何对待(见 ApprovalClass)。 */
  approvalClass?: ApprovalClass
  /** 动态审批类别:按具体入参区分 file/outreach/destructive/spend。 */
  approvalClassFor?(input: Input, ctx: ToolContext): ApprovalClass | undefined
  /** 旁路免疫:连 bypassPermissions(跳过确认)也强制弹卡。删数据这类真危险动作设它。 */
  forceConfirm?: boolean
  /** 动态旁路免疫:同一个工具按入参区分预览/真正执行。 */
  forceConfirmFor?(input: Input, ctx: ToolContext): boolean
  /** 必须用户交互确认:连 bypassPermissions 也不能自动执行(如登录、支付、系统授权)。 */
  requiresUserInteraction?: boolean
  requiresUserInteractionFor?(input: Input, ctx: ToolContext): boolean
  /** 动态:按具体入参决定要不要审批(如"写到工作区外才要")。 */
  requiresApprovalFor?(input: Input, ctx: ToolContext): boolean
  /** 硬拒理由:非空 = 直接拒、永不执行(删根/提权等)。 */
  fatalReasonFor?(input: Input, ctx: ToolContext): string | null
  /** 安全白名单:命中则即便 requiresApproval 也放行(如只读子命令 `git status`)。 */
  safePrefixFor?(input: Input, ctx: ToolContext): boolean
  /** 审批卡预览(人话 diff),异步(可能要读文件算 diff)。 */
  previewFor?(input: Input, ctx: ToolContext): Promise<string | null>
  /** 审批卡理由(什么/为什么/影响)。 */
  approvalReasonFor?(input: Input, ctx: ToolContext): ApprovalReason
  execute(input: Input, ctx: ToolContext): Promise<string>
}
