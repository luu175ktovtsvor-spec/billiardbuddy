// 权限系统纯类型 leaf(不 import 本仓库任何模块,避免环)。
// 对齐 CC 外部五档，同时保留旧值兼容读取:ask/default、auto_files/acceptEdits、full/bypassPermissions。

export type CanonicalPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'
export type LegacyPermissionMode = 'ask' | 'auto_files' | 'full'
export type PermissionMode = CanonicalPermissionMode | LegacyPermissionMode
export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session'

export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

export interface PermissionRule {
  source: PermissionRuleSource
  ruleBehavior: PermissionBehavior
  ruleValue: PermissionRuleValue
}

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg'

export type PermissionUpdate =
  | {
      type: 'addRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'replaceRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'removeRules'
      destination: PermissionUpdateDestination
      rules: PermissionRuleValue[]
      behavior: PermissionBehavior
    }
  | {
      type: 'setMode'
      destination: PermissionUpdateDestination
      mode: CanonicalPermissionMode
    }
  | {
      type: 'addDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: PermissionUpdateDestination
      directories: string[]
    }

export interface AdditionalWorkingDirectory {
  path: string
  source: PermissionRuleSource
}

/** 需审批动作的类别:file=本机可逆文件动作(acceptEdits 放行,default 询问)· spend=成本/外部资源 · outreach=对外触达 · destructive=不可逆。 */
export type ApprovalClass = 'file' | 'spend' | 'outreach' | 'destructive'

/** 每个决策附一条"为什么"——供日志/事件/调试,不影响行为。 */
export type DecisionReason =
  | { type: 'mode'; mode: CanonicalPermissionMode }
  | { type: 'rule'; rule: PermissionRule }
  | { type: 'forceConfirm' } // 旁路免疫:连 bypassPermissions 也拦
  | { type: 'requiresUserInteraction' } // 必须由用户交互确认,连 bypassPermissions 也拦
  | { type: 'fatal'; text: string } // 硬拒,永不执行
  | { type: 'sessionAllowedTool'; tool: string } // skill/command frontmatter 授权的会话内工具
  | { type: 'safePrefix' } // 工具自报的安全白名单 → 放行
  | { type: 'safetyCheck'; reason: string; classifierApprovable: boolean } // acceptEdits 敏感路径拦截:不走自动放行、退回询问
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

export type PermissionResult =
  | PermissionDecision
  | { behavior: 'passthrough'; message: string; reason?: DecisionReason; suggestions?: PermissionUpdate[]; blockedPath?: string }
