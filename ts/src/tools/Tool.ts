import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { ApprovalClass, ApprovalReason, PermissionMode } from '../permissions/types'

export type JSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
  sandbox?: Sandbox
  /** 权限档,默认 'ask'。W4a 权限瀑布读它。 */
  permissionMode?: PermissionMode
  /** 会话 id,跨请求拒绝计数按它隔离(见 denialTracking)。 */
  conversationId?: string
  /** full 档下 spend 类动作已自动放行的次数(过 AUTO_SPEND_LIMIT 强制弹卡)。 */
  autoSpendCount?: number
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
  /** 静态:这工具总是要审批(发布/群发等)。 */
  requiresApproval?: boolean
  /** 审批类别,决定档位如何对待(见 ApprovalClass)。 */
  approvalClass?: ApprovalClass
  /** 旁路免疫:连 full(跳过确认)也强制弹卡。删数据这类真危险动作设它。 */
  forceConfirm?: boolean
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
