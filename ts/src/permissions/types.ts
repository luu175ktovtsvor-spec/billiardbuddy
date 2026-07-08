// 权限系统纯类型 leaf(不 import 本仓库任何模块,避免环)。
// 裁到我们用得上的:4 档(非 CC 5 档)、allow/ask/deny 三态、我们红线专属的 DecisionReason。

export type PermissionMode = 'ask' | 'auto_files' | 'full' | 'plan' | 'bypassPermissions'
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

/** 需审批动作的类别:file=本机文件(auto_files 档自动放行)· spend=花钱(full 档过计数闸)· outreach=对外触达 · destructive=不可逆。 */
export type ApprovalClass = 'file' | 'spend' | 'outreach' | 'destructive'

/** 每个决策附一条"为什么"——供日志/事件/调试,不影响行为。 */
export type DecisionReason =
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'forceConfirm' } // 旁路免疫:连 full 也拦
  | { type: 'requiresUserInteraction' } // 必须由用户交互确认,连 bypassPermissions 也拦
  | { type: 'fatal'; text: string } // 硬拒,永不执行
  | { type: 'sessionAllowedTool'; tool: string } // skill/command frontmatter 授权的会话内工具
  | { type: 'safePrefix' } // 工具自报的安全白名单 → 放行
  | { type: 'planSkip' } // plan 模式跳过会动手的工具

/** 审批卡上给老板看的大白话理由(什么/为什么/影响)。 */
export interface ApprovalReason {
  what: string
  why: string
  impact: string
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; reason?: DecisionReason }
  | { behavior: 'ask'; message: string; approvalClass?: ApprovalClass; approvalReason?: ApprovalReason; reason?: DecisionReason }
  | { behavior: 'deny'; message: string; reason: DecisionReason }
