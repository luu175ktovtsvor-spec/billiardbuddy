import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import {
  applyNotificationHooks,
  applyPostCompactHooks,
  applyPostToolUseFailureHooks,
  applyPostToolUseHooks,
  applyPreCompactHooks,
  applyPreToolUseHooks,
  applySessionEndHooks,
  applySessionStartHooks,
  applyStopHooks,
  applySubagentStartHooks,
  applyUserPromptSubmitHooks,
  configureHookTrust,
  hookAllowBypassesAsk,
  matchesToolMatcher,
  mergeHookRegistries,
  parseHookDecisionJSON,
  resetHookTrust,
  resolveHookTrustPolicy,
  runHookEvent,
  shouldRunHookRule,
  type HookPayload,
  type HookRegistry,
  type HookRule,
} from './hooks'

const ctx = () => ({ workspace: new Workspace(mkdtempSync(join(tmpdir(), 'hooks-'))) })

// 每个用例前后都复位信任门:后复位避免本文件用例互相泄漏;前复位防其它测试文件(如 index.test.ts 的
// startServer 会 configureHookTrust)在同进程先跑时把进程级 override 泄漏进来、污染读默认策略的用例。
beforeEach(() => resetHookTrust())
afterEach(() => resetHookTrust())

test('parseHookDecisionJSON:解析 allow/deny/modify/context,非法返回 null', () => {
  expect(parseHookDecisionJSON('{"action":"allow"}')).toEqual({ action: 'allow', message: undefined })
  expect(parseHookDecisionJSON('{"action":"deny","message":"no"}')).toEqual({ action: 'deny', message: 'no' })
  expect(parseHookDecisionJSON('{"action":"modify","updatedInput":{"x":1}}')).toEqual({ action: 'modify', updatedInput: { x: 1 }, message: undefined })
  expect(parseHookDecisionJSON('{"action":"context","additionalContext":"note"}')).toEqual({ action: 'context', additionalContext: 'note' })
  expect(parseHookDecisionJSON('bad')).toBeNull()
})

test('parseHookDecisionJSON:解析 cc hookSpecificOutput.permissionDecision(allow/ask/deny)+ decision:block + 扁平 ask', () => {
  const hso = (d: string, r?: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d, ...(r ? { permissionDecisionReason: r } : {}) } })
  expect(parseHookDecisionJSON(hso('allow', 'ok'))).toEqual({ action: 'allow', message: 'ok' })
  expect(parseHookDecisionJSON(hso('ask', '需确认'))).toEqual({ action: 'ask', message: '需确认' })
  expect(parseHookDecisionJSON(hso('deny', '不行'))).toEqual({ action: 'deny', message: '不行' })
  // cc 旧格式 decision:'block' → deny
  expect(parseHookDecisionJSON('{"decision":"block","reason":"stop"}')).toEqual({ action: 'deny', message: 'stop' })
  // 本项目扁平 ask
  expect(parseHookDecisionJSON('{"action":"ask","message":"m"}')).toEqual({ action: 'ask', message: 'm' })
})

test('matchesToolMatcher:* / 精确 / 管道交替 / 正则前缀 / 锚定不误配子串', () => {
  expect(matchesToolMatcher('*', 'anything')).toBe(true)
  expect(matchesToolMatcher(undefined, 'anything')).toBe(true)
  expect(matchesToolMatcher('write_file', 'write_file')).toBe(true)
  expect(matchesToolMatcher('write_file', 'read_file')).toBe(false)
  // 管道交替(cc Edit|Write)
  expect(matchesToolMatcher('edit_file|write_file', 'write_file')).toBe(true)
  expect(matchesToolMatcher('edit_file|write_file', 'read_file')).toBe(false)
  // 正则前缀(cc mcp__.*)
  expect(matchesToolMatcher('mcp__.*', 'mcp__server__tool')).toBe(true)
  expect(matchesToolMatcher('mcp__.*', 'read_file')).toBe(false)
  // 锚定:Edit 不误配 MultiEdit
  expect(matchesToolMatcher('edit', 'multi_edit')).toBe(false)
})

test('applyPreToolUseHooks:hook 返回 ask → askRequested + askMessage(强制审批信号)', async () => {
  const c = ctx()
  const result = await applyPreToolUseHooks({
    rules: [{ event: 'PreToolUse', matcher: 'run_command', handler: () => ({ action: 'ask', message: '这条命令要确认' }) }],
  }, 'run_command', { command: 'ls' }, c)
  expect(result.askRequested).toBe(true)
  expect(result.askMessage).toBe('这条命令要确认')
  expect(result.deniedMessage).toBeUndefined()
})

// —— P0 回归:PreToolUse hook 的 allow 决策不再被静默丢弃(对齐 cc resolveHookPermissionDecision) ——
test('applyPreToolUseHooks:单 hook 返回 allow → allowRequested 为真(此前被静默丢弃)', async () => {
  const c = ctx()
  const result = await applyPreToolUseHooks({
    rules: [{ event: 'PreToolUse', matcher: 'run_command', handler: () => ({ action: 'allow', message: '自动放行' }) }],
  }, 'run_command', { command: 'ls' }, c)
  expect(result.allowRequested).toBe(true)
  expect(result.askRequested).toBeUndefined()
  expect(result.deniedMessage).toBeUndefined()
})

test('applyPreToolUseHooks:一个 hook allow + 一个 hook deny → deny 胜(deny>ask>allow 聚合优先级)', async () => {
  const c = ctx()
  const allowThenDeny = await applyPreToolUseHooks({
    rules: [
      { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'allow' }) },
      { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'deny', message: '拒绝' }) },
    ],
  }, 'run_command', { command: 'ls' }, c)
  expect(allowThenDeny.deniedMessage).toBe('拒绝')

  // 顺序反过来(deny 先出现)结果一致,证明不依赖 hook 注册顺序
  const denyThenAllow = await applyPreToolUseHooks({
    rules: [
      { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'deny', message: '拒绝' }) },
      { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'allow' }) },
    ],
  }, 'run_command', { command: 'ls' }, c)
  expect(denyThenAllow.deniedMessage).toBe('拒绝')
})

test('applyPreToolUseHooks:一个 hook allow + 一个 hook ask → ask 胜(allow 不生效)', async () => {
  const c = ctx()
  const result = await applyPreToolUseHooks({
    rules: [
      { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'allow' }) },
      { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'ask', message: '要确认' }) },
    ],
  }, 'run_command', { command: 'ls' }, c)
  expect(result.askRequested).toBe(true)
  expect(result.allowRequested).toBe(true) // allow 决策仍被记录,但下游消费按 ask 优先
  expect(result.deniedMessage).toBeUndefined()
})

test('hookAllowBypassesAsk:hook allow 只跳过"默认模式该问"的弹窗,不越过显式规则/强制交互闸/deny>ask 优先级', () => {
  // 无 hook allow → 不豁免
  expect(hookAllowBypassesAsk({}, { behavior: 'ask', reason: { type: 'mode', mode: 'default' } })).toBe(false)
  // decision 本就不是 ask(如 deny/allow)→ 不适用
  expect(hookAllowBypassesAsk({ allowRequested: true }, { behavior: 'deny' })).toBe(false)
  expect(hookAllowBypassesAsk({ allowRequested: true }, { behavior: 'allow' })).toBe(false)
  // 唯一豁免场景:hook allow 且 resolvePermission 只是因为默认权限档位才要问(reason.type==='mode')
  expect(hookAllowBypassesAsk({ allowRequested: true }, { behavior: 'ask', reason: { type: 'mode', mode: 'default' } })).toBe(true)
  // 显式 ask 规则:不豁免(hook allow 不能盖过用户/工作区配置的显式 ask 规则)
  expect(hookAllowBypassesAsk({ allowRequested: true }, {
    behavior: 'ask',
    reason: { type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'ask', ruleValue: { toolName: 'run_command' } } },
  })).toBe(false)
  // 工具自身强制交互闸(forceConfirm/requiresUserInteraction):不豁免,产品红线连 bypassPermissions 都拦
  expect(hookAllowBypassesAsk({ allowRequested: true }, { behavior: 'ask', reason: { type: 'forceConfirm' } })).toBe(false)
  expect(hookAllowBypassesAsk({ allowRequested: true }, { behavior: 'ask', reason: { type: 'requiresUserInteraction' } })).toBe(false)
  // acceptEdits 安全检查(safetyCheck):不豁免
  expect(hookAllowBypassesAsk({ allowRequested: true }, { behavior: 'ask', reason: { type: 'safetyCheck', reason: '敏感路径', classifierApprovable: false } })).toBe(false)
  // deny>ask>allow:同时有 hook ask 时,即便也有 hook allow,也不豁免(ask 赢)
  expect(hookAllowBypassesAsk({ allowRequested: true, askRequested: true }, { behavior: 'ask', reason: { type: 'mode', mode: 'default' } })).toBe(false)
})

test('runHookEvent:按事件和 matcher 执行,hook 抛错 fail-closed deny', async () => {
  const c = ctx()
  try {
    const decisions = await runHookEvent({
      rules: [
        { event: 'PreToolUse', matcher: 'read_file', handler: () => ({ action: 'allow' }) },
        { event: 'PreToolUse', matcher: 'write_file', handler: () => ({ action: 'deny', message: 'blocked' }) },
        { event: 'PostToolUse', handler: () => ({ action: 'context', additionalContext: 'skip' }) },
        { event: 'PreToolUse', matcher: 'read_file', handler: () => { throw new Error('boom') } },
      ],
    }, { event: 'PreToolUse', toolName: 'read_file', input: {} }, c)
    expect(decisions).toEqual([
      { action: 'allow', message: undefined },
      { action: 'deny', message: 'hook PreToolUse 执行失败:boom' },
    ])
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyPreToolUseHooks:modify 之后可追加 context;deny 立即停止', async () => {
  const c = ctx()
  try {
    const modified = await applyPreToolUseHooks({
      rules: [
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'modify', updatedInput: { path: 'b.txt' } }) },
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'context', additionalContext: '已改参' }) },
      ],
    }, 'read_file', { path: 'a.txt' }, c)
    expect(modified).toEqual({ input: { path: 'b.txt' }, additionalContext: ['已改参'] })

    const denied = await applyPreToolUseHooks({
      rules: [
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'deny', message: 'nope' }) },
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'modify', updatedInput: {} }) },
      ],
    }, 'read_file', { path: 'a.txt' }, c)
    expect(denied).toEqual({ input: { path: 'a.txt' }, deniedMessage: 'nope', additionalContext: [] })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applySessionStartHooks:context 注入,deny 退化为警告上下文', async () => {
  const c = ctx()
  try {
    const result = await applySessionStartHooks({
      rules: [
        { event: 'SessionStart', handler: payload => ({ action: 'context', additionalContext: `session:${payload.sessionId}` }) },
        { event: 'SessionStart', handler: () => ({ action: 'deny', message: 'bad startup hook' }) },
      ],
    }, { ...c, conversationId: 's1' })
    expect(result).toEqual({
      additionalContext: ['session:s1', '[SessionStart hook 警告] bad startup hook'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyUserPromptSubmitHooks:modify/context/deny', async () => {
  const c = ctx()
  try {
    const modified = await applyUserPromptSubmitHooks({
      rules: [
        { event: 'UserPromptSubmit', handler: payload => ({ action: 'modify', updatedInput: `${payload.userPrompt} + hook` }) },
        { event: 'UserPromptSubmit', handler: () => ({ action: 'context', additionalContext: '用户输入补充上下文' }) },
      ],
    }, '原始输入', c)
    expect(modified).toEqual({
      userPrompt: '原始输入 + hook',
      additionalContext: ['用户输入补充上下文'],
    })

    const denied = await applyUserPromptSubmitHooks({
      rules: [
        { event: 'UserPromptSubmit', handler: () => ({ action: 'deny', message: 'blocked prompt' }) },
        { event: 'UserPromptSubmit', handler: () => ({ action: 'modify', updatedInput: 'never' }) },
      ],
    }, '原始输入', c)
    expect(denied).toEqual({ userPrompt: '原始输入', deniedMessage: 'blocked prompt', additionalContext: [] })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyPostToolUseHooks:context 注入,deny 退化为警告上下文', async () => {
  const c = ctx()
  try {
    const result = await applyPostToolUseHooks({
      rules: [
        { event: 'PostToolUse', matcher: 'read_file', handler: payload => ({ action: 'context', additionalContext: `out:${payload.output}` }) },
        { event: 'PostToolUse', matcher: 'read_file', handler: () => ({ action: 'deny', message: 'post failed closed' }) },
      ],
    }, 'read_file', { path: 'a.txt' }, 'payload', c)
    expect(result).toEqual({
      additionalContext: ['out:payload', '[PostToolUse hook 警告] post failed closed'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyStopHooks:final output 可用于生成收尾上下文', async () => {
  const c = ctx()
  try {
    const result = await applyStopHooks({
      rules: [
        { event: 'Stop', handler: payload => ({ action: 'context', additionalContext: `final:${payload.output}` }) },
        { event: 'Stop', handler: () => ({ action: 'deny', message: 'stop warning' }) },
      ],
    }, '完成', c)
    expect(result).toEqual({
      additionalContext: ['final:完成'],
      blockingFeedback: ['Stop hook feedback:\nstop warning'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('SubagentStart/SubagentStop:按 agentType matcher 派发并携带 agent id', async () => {
  const c = ctx()
  try {
    const registry: HookRegistry = {
      rules: [
        { event: 'SubagentStart' as const, matcher: 'researcher', handler: payload => ({ action: 'context' as const, additionalContext: `start:${payload.agentId}:${payload.agentType}` }) },
        { event: 'SubagentStart' as const, matcher: 'writer', handler: () => ({ action: 'context' as const, additionalContext: 'skip' }) },
        { event: 'SubagentStop' as const, matcher: 'researcher', handler: payload => ({ action: 'context' as const, additionalContext: `stop:${payload.agentId}:${payload.output}` }) },
        { event: 'SubagentStop' as const, matcher: 'researcher', handler: () => ({ action: 'deny' as const, message: 'stop warn' }) },
      ],
    }
    const started = await applySubagentStartHooks(registry, 'agent-1', 'researcher', { ...c, conversationId: 'agent-1' })
    expect(started.additionalContext).toEqual(['start:agent-1:researcher'])
    const stopped = await applyStopHooks(registry, '完成', { ...c, conversationId: 'agent-1' }, { agentId: 'agent-1', agentType: 'researcher' })
    expect(stopped).toEqual({
      additionalContext: ['stop:agent-1:完成'],
      blockingFeedback: ['SubagentStop hook feedback:\nstop warn'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('mergeHookRegistries:保留顺序合并规则', () => {
  const merged = mergeHookRegistries(
    { rules: [{ event: 'SessionStart', handler: () => ({ action: 'context', additionalContext: 'a' }) }] },
    undefined,
    { rules: [{ event: 'Stop', handler: () => ({ action: 'context', additionalContext: 'b' }) }] },
  )
  expect(merged?.rules.map(rule => rule.event)).toEqual(['SessionStart', 'Stop'])
})

// —— 信任门:对齐 cc-haha hooks 执行前的三道闸(disableAllHooks / allowManagedHooksOnly / workspace trust)——
// 参考 cc-haha:src/utils/hooks.ts 的 shouldDisableAllHooksIncludingManaged / shouldAllowManagedHooksOnly /
// shouldSkipHookDueToTrust(config.ts checkHasTrustDialogAccepted),以及 src/utils/hooks/hooksConfigSnapshot.ts。

// managed(内置:域包/目标/技能)源无 source 标记;local = 从工作区 .claude/settings 文件加载的任意命令 hook。
function gateRegistry(track: (who: string) => void): HookRegistry {
  return {
    rules: [
      { event: 'PreToolUse', handler: () => { track('managed'); return { action: 'allow', message: 'managed-ran' } } },
      { event: 'PreToolUse', source: 'local', handler: () => { track('local'); return { action: 'deny', message: 'local-ran' } } },
    ],
  }
}

const gatePayload = { event: 'PreToolUse' as const, toolName: 'run_command', input: { command: 'ls' } }

test('信任门 shouldRunHookRule:disableAllHooks 挡下所有源(含 managed)', () => {
  const managed: HookRule = { event: 'PreToolUse', handler: () => null }
  const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
  const policy = { disableAllHooks: true, allowManagedHooksOnly: false, interactive: false, isWorkspaceTrusted: () => true }
  expect(shouldRunHookRule(managed, '/ws', policy)).toBe(false)
  expect(shouldRunHookRule(local, '/ws', policy)).toBe(false)
})

test('信任门 shouldRunHookRule:allowManagedHooksOnly 只挡 local,managed 放行', () => {
  const managed: HookRule = { event: 'PreToolUse', handler: () => null }
  const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
  const policy = { disableAllHooks: false, allowManagedHooksOnly: true, interactive: false, isWorkspaceTrusted: () => true }
  expect(shouldRunHookRule(managed, '/ws', policy)).toBe(true)
  expect(shouldRunHookRule(local, '/ws', policy)).toBe(false)
})

test('信任门 shouldRunHookRule:交互模式未受信只挡 local,managed 放行;受信则 local 放行', () => {
  const managed: HookRule = { event: 'PreToolUse', handler: () => null }
  const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
  const untrusted = { disableAllHooks: false, allowManagedHooksOnly: false, interactive: true, isWorkspaceTrusted: () => false }
  expect(shouldRunHookRule(managed, '/ws', untrusted)).toBe(true)
  expect(shouldRunHookRule(local, '/ws', untrusted)).toBe(false)
  const trusted = { ...untrusted, isWorkspaceTrusted: () => true }
  expect(shouldRunHookRule(local, '/ws', trusted)).toBe(true)
})

test('信任门 shouldRunHookRule:非交互(SDK)trust 隐式成立,local 放行', () => {
  const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
  const policy = { disableAllHooks: false, allowManagedHooksOnly: false, interactive: false, isWorkspaceTrusted: () => false }
  // 非交互时不校验 trust(对齐 cc shouldSkipHookDueToTrust 的 non-interactive 分支)
  expect(shouldRunHookRule(local, '/ws', policy)).toBe(true)
})

test('runHookEvent:disableAllHooks 时任何 hook 都不执行(含 managed)', async () => {
  const c = ctx()
  configureHookTrust({ disableAllHooks: true })
  const ran: string[] = []
  const decisions = await runHookEvent(gateRegistry(w => ran.push(w)), gatePayload, c)
  expect(ran).toEqual([])
  expect(decisions).toEqual([])
})

test('runHookEvent:allowManagedHooksOnly 时 local hook 不跑,managed 照跑', async () => {
  const c = ctx()
  configureHookTrust({ allowManagedHooksOnly: true })
  const ran: string[] = []
  const decisions = await runHookEvent(gateRegistry(w => ran.push(w)), gatePayload, c)
  expect(ran).toEqual(['managed'])
  expect(decisions).toEqual([{ action: 'allow', message: 'managed-ran' }])
})

test('runHookEvent:交互模式 workspace 未受信 → local 不跑,managed 照跑', async () => {
  const c = ctx()
  configureHookTrust({ interactive: true, isWorkspaceTrusted: () => false })
  const ran: string[] = []
  const decisions = await runHookEvent(gateRegistry(w => ran.push(w)), gatePayload, c)
  expect(ran).toEqual(['managed'])
  expect(decisions).toEqual([{ action: 'allow', message: 'managed-ran' }])
})

test('runHookEvent:交互模式 workspace 受信 → local 与 managed 都跑(正常路径)', async () => {
  const c = ctx()
  configureHookTrust({ interactive: true, isWorkspaceTrusted: () => true })
  const ran: string[] = []
  const decisions = await runHookEvent(gateRegistry(w => ran.push(w)), gatePayload, c)
  expect(ran).toEqual(['managed', 'local'])
  expect(decisions).toEqual([
    { action: 'allow', message: 'managed-ran' },
    { action: 'deny', message: 'local-ran' },
  ])
})

test('runHookEvent:默认(未配置=交互 true 但 isWorkspaceTrusted 缺省 alwaysTrusted)→ local 与 managed 都跑', async () => {
  // 无宿主接线时 isWorkspaceTrusted 缺省 alwaysTrusted,故 local hook 仍放行(等价 SDK 隐式信任,不破坏无宿主/测试路径)。
  const c = ctx()
  const ran: string[] = []
  const decisions = await runHookEvent(gateRegistry(w => ran.push(w)), gatePayload, c)
  expect(ran).toEqual(['managed', 'local'])
  expect(decisions.length).toBe(2)
})

test('resolveHookTrustPolicy:安全默认 interactive=true(纵深防御),isWorkspaceTrusted 缺省放行', () => {
  const policy = resolveHookTrustPolicy()
  expect(policy.interactive).toBe(true)
  expect(policy.disableAllHooks).toBe(false)
  expect(policy.allowManagedHooksOnly).toBe(false)
  // 缺省 isWorkspaceTrusted = alwaysTrusted:无宿主接线时不误挡任何 local hook
  expect(policy.isWorkspaceTrusted('/any/workspace')).toBe(true)
})

// —— 插件 hook 源(plugin):app 级可信、不过 workspace trust 闸,但受 disableAll / managedOnly 约束 ——
test('信任门 shouldRunHookRule:plugin 源交互未受信仍放行(不在被打开工作区、非 RCE 攻击面),与 local 分道', () => {
  const plugin: HookRule = { event: 'PreToolUse', source: 'plugin', handler: () => null }
  const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
  const untrusted = { disableAllHooks: false, allowManagedHooksOnly: false, interactive: true, isWorkspaceTrusted: () => false }
  expect(shouldRunHookRule(plugin, '/ws', untrusted)).toBe(true)
  expect(shouldRunHookRule(local, '/ws', untrusted)).toBe(false)
})

test('信任门 shouldRunHookRule:plugin 源被 disableAllHooks 与 allowManagedHooksOnly 挡下', () => {
  const plugin: HookRule = { event: 'PreToolUse', source: 'plugin', handler: () => null }
  const disableAll = { disableAllHooks: true, allowManagedHooksOnly: false, interactive: false, isWorkspaceTrusted: () => true }
  const managedOnly = { disableAllHooks: false, allowManagedHooksOnly: true, interactive: false, isWorkspaceTrusted: () => true }
  expect(shouldRunHookRule(plugin, '/ws', disableAll)).toBe(false)
  expect(shouldRunHookRule(plugin, '/ws', managedOnly)).toBe(false)
})

// —— 用户级全局 hook 源(user,~/.billiardbuddy/settings.json):非工作区攻击面,与 plugin 同档,
// 不过 workspace trust 闸,但受 disableAll / managedOnly 约束(对齐 loadUserHookRegistry 的 source 标记)——
test('信任门 shouldRunHookRule:user 源交互未受信仍放行(不来自被打开的工作区),与 local 分道', () => {
  const user: HookRule = { event: 'PreToolUse', source: 'user', handler: () => null }
  const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
  const untrusted = { disableAllHooks: false, allowManagedHooksOnly: false, interactive: true, isWorkspaceTrusted: () => false }
  expect(shouldRunHookRule(user, '/ws', untrusted)).toBe(true)
  expect(shouldRunHookRule(local, '/ws', untrusted)).toBe(false)
})

test('信任门 shouldRunHookRule:user 源被 disableAllHooks 与 allowManagedHooksOnly 挡下', () => {
  const user: HookRule = { event: 'PreToolUse', source: 'user', handler: () => null }
  const disableAll = { disableAllHooks: true, allowManagedHooksOnly: false, interactive: false, isWorkspaceTrusted: () => true }
  const managedOnly = { disableAllHooks: false, allowManagedHooksOnly: true, interactive: false, isWorkspaceTrusted: () => true }
  expect(shouldRunHookRule(user, '/ws', disableAll)).toBe(false)
  expect(shouldRunHookRule(user, '/ws', managedOnly)).toBe(false)
})

// —— 新增生命周期事件派发器:PreCompact / PostCompact / SessionEnd / Notification / PostToolUseFailure ——
test('applyPreCompactHooks / applyPostCompactHooks:按 trigger 派发,收集 additionalContext', async () => {
  const c = ctx()
  const seen: Array<{ event: string; trigger?: string; summary?: string; custom?: string | null }> = []
  const registry: HookRegistry = {
    rules: [
      { event: 'PreCompact', handler: p => { seen.push({ event: p.event, trigger: p.compactTrigger, custom: p.compactCustomInstructions }); return { action: 'context', additionalContext: 'pre-note' } } },
      { event: 'PostCompact', handler: p => { seen.push({ event: p.event, trigger: p.compactTrigger, summary: p.compactSummary }); return { action: 'context', additionalContext: 'post-note' } } },
    ],
  }
  const pre = await applyPreCompactHooks(registry, 'manual', c)
  const post = await applyPostCompactHooks(registry, 'auto', '这是摘要', c)
  expect(pre.additionalContext).toEqual(['pre-note'])
  expect(post.additionalContext).toEqual(['post-note'])
  expect(seen).toEqual([
    { event: 'PreCompact', trigger: 'manual', custom: null },
    { event: 'PostCompact', trigger: 'auto', summary: '这是摘要' },
  ])
})

test('applySessionEndHooks / applyNotificationHooks:载荷字段透传,派发就绪', async () => {
  const c = ctx()
  const seen: HookPayload[] = []
  const registry: HookRegistry = {
    rules: [
      { event: 'SessionEnd', handler: p => { seen.push(p); return { action: 'context', additionalContext: 'ended' } } },
      { event: 'Notification', handler: p => { seen.push(p); return null } },
    ],
  }
  const end = await applySessionEndHooks(registry, 'clear', c)
  await applyNotificationHooks(registry, { message: '需要确认权限', notificationType: 'permission' }, c)
  expect(end.additionalContext).toEqual(['ended'])
  expect(seen[0]).toMatchObject({ event: 'SessionEnd', sessionEndReason: 'clear' })
  expect(seen[1]).toMatchObject({ event: 'Notification', notificationMessage: '需要确认权限', notificationType: 'permission' })
})

test('applyPostToolUseFailureHooks:工具报错时派发,带 tool_name/error/tool_use_id', async () => {
  const c = ctx()
  const seen: HookPayload[] = []
  const registry: HookRegistry = {
    rules: [{ event: 'PostToolUseFailure', matcher: 'run_command', handler: p => { seen.push(p); return { action: 'context', additionalContext: '失败已记录' } } }],
  }
  const res = await applyPostToolUseFailureHooks(registry, 'run_command', { command: 'boom' }, 'exit 1', c, 'call-9')
  expect(res.additionalContext).toEqual(['失败已记录'])
  expect(seen[0]).toMatchObject({ event: 'PostToolUseFailure', toolName: 'run_command', errorMessage: 'exit 1', toolUseId: 'call-9' })
})

test('resolveHookTrustPolicy:env CLAUDE_CODE_HOOKS_TRUST_IMPLICIT → 转非交互(隐式信任),local 不再受 trust 门约束', () => {
  const prev = process.env.CLAUDE_CODE_HOOKS_TRUST_IMPLICIT
  try {
    process.env.CLAUDE_CODE_HOOKS_TRUST_IMPLICIT = '1'
    expect(resolveHookTrustPolicy().interactive).toBe(false)
    // 非交互 + 未受信:local 仍放行(对齐 cc getIsNonInteractiveSession 分支)
    const local: HookRule = { event: 'PreToolUse', source: 'local', handler: () => null }
    expect(shouldRunHookRule(local, '/ws', { ...resolveHookTrustPolicy(), isWorkspaceTrusted: () => false })).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_HOOKS_TRUST_IMPLICIT
    else process.env.CLAUDE_CODE_HOOKS_TRUST_IMPLICIT = prev
  }
})

test('applyPreToolUseHooks:交互未受信时 local deny hook 被跳过(不误拦工具)', async () => {
  const c = ctx()
  configureHookTrust({ interactive: true, isWorkspaceTrusted: () => false })
  const result = await applyPreToolUseHooks({
    rules: [{ event: 'PreToolUse', source: 'local', matcher: 'run_command', handler: () => ({ action: 'deny', message: 'untrusted hook says no' }) }],
  }, 'run_command', { command: 'ls' }, c)
  expect(result.deniedMessage).toBeUndefined()
})

test('resolveHookTrustPolicy:env CLAUDE_CODE_DISABLE_ALL_HOOKS / CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY 生效', () => {
  const prevDisable = process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS
  const prevManaged = process.env.CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY
  try {
    process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS = '1'
    process.env.CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY = 'true'
    const policy = resolveHookTrustPolicy()
    expect(policy.disableAllHooks).toBe(true)
    expect(policy.allowManagedHooksOnly).toBe(true)
  } finally {
    if (prevDisable === undefined) delete process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS
    else process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS = prevDisable
    if (prevManaged === undefined) delete process.env.CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY
    else process.env.CLAUDE_CODE_ALLOW_MANAGED_HOOKS_ONLY = prevManaged
  }
})

test('configureHookTrust:override 优先于 env;resetHookTrust 复位', () => {
  const prev = process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS
  try {
    process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS = '1'
    configureHookTrust({ disableAllHooks: false })
    expect(resolveHookTrustPolicy().disableAllHooks).toBe(false)
    resetHookTrust()
    expect(resolveHookTrustPolicy().disableAllHooks).toBe(true)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS
    else process.env.CLAUDE_CODE_DISABLE_ALL_HOOKS = prev
  }
})

// ─── 27 事件全集:新 14 事件的解析/派发/匹配键(对齐 cc coreTypes.ts:25-53 + utils/hooks.ts 各 fire 点)───

test('parseHookDecisionJSON:cc PermissionRequest decision(allow/deny/updatedInput)', () => {
  const pr = (decision: unknown) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
  expect(parseHookDecisionJSON(pr({ behavior: 'deny', message: '不给' }))).toEqual({ action: 'deny', message: '不给' })
  expect(parseHookDecisionJSON(pr({ behavior: 'deny' }))).toEqual({ action: 'deny', message: 'PermissionRequest hook 拒绝' })
  expect(parseHookDecisionJSON(pr({ behavior: 'allow' }))).toEqual({ action: 'allow' })
  expect(parseHookDecisionJSON(pr({ behavior: 'allow', updatedInput: { cmd: 'ls' } }))).toEqual({ action: 'modify', updatedInput: { cmd: 'ls' } })
})

test('parseHookDecisionJSON:cc PermissionDenied retry:true → allow(retryRequested 语义)', () => {
  expect(parseHookDecisionJSON(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: true } })))
    .toEqual({ action: 'allow' })
  // retry:false / 缺 retry → 不产生决策(退 context 兜底在 parseCommandHookStdout 层,这里 null)
  expect(parseHookDecisionJSON(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionDenied', retry: false } })))
    .toBeNull()
})

test('parseHookDecisionJSON:cc Elicitation/ElicitationResult action+content → elicitation 决策', () => {
  expect(parseHookDecisionJSON(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: { name: 'x' } } })))
    .toEqual({ action: 'elicitation', elicitationAction: 'accept', content: { name: 'x' } })
  expect(parseHookDecisionJSON(JSON.stringify({ hookSpecificOutput: { hookEventName: 'ElicitationResult', action: 'decline' } })))
    .toEqual({ action: 'elicitation', elicitationAction: 'decline', content: undefined })
  // 非法 action → null
  expect(parseHookDecisionJSON(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'nope' } })))
    .toBeNull()
})

test('applyPermissionRequestHooks:deny 短路 > allow;modify=allow+改参;matcher 按工具名', async () => {
  const { applyPermissionRequestHooks } = await import('./hooks')
  const c = ctx() as never
  // deny 短路
  const denyReg: HookRegistry = { rules: [{ event: 'PermissionRequest', handler: () => ({ action: 'deny', message: '免弹拒绝' }) }] }
  const denied = await applyPermissionRequestHooks(denyReg, 'run_command', { command: 'rm x' }, c)
  expect(denied.behavior).toBe('deny')
  expect(denied.message).toBe('免弹拒绝')
  // allow
  const allowReg: HookRegistry = { rules: [{ event: 'PermissionRequest', matcher: 'run_command', handler: () => ({ action: 'allow' }) }] }
  const allowed = await applyPermissionRequestHooks(allowReg, 'run_command', {}, c)
  expect(allowed.behavior).toBe('allow')
  // modify → allow + updatedInput
  const modReg: HookRegistry = { rules: [{ event: 'PermissionRequest', handler: () => ({ action: 'modify', updatedInput: { command: 'ls' } }) }] }
  const modified = await applyPermissionRequestHooks(modReg, 'run_command', { command: 'rm x' }, c)
  expect(modified.behavior).toBe('allow')
  expect(modified.updatedInput).toEqual({ command: 'ls' })
  // matcher 不中 → 无裁决
  const missReg: HookRegistry = { rules: [{ event: 'PermissionRequest', matcher: 'write_file', handler: () => ({ action: 'allow' }) }] }
  const missed = await applyPermissionRequestHooks(missReg, 'run_command', {}, c)
  expect(missed.behavior).toBeUndefined()
})

test('applyPermissionDeniedHooks:allow → retryRequested;context 收集', async () => {
  const { applyPermissionDeniedHooks } = await import('./hooks')
  const c = ctx() as never
  const reg: HookRegistry = { rules: [
    { event: 'PermissionDenied', handler: () => ({ action: 'allow' }) },
    { event: 'PermissionDenied', handler: () => ({ action: 'context', additionalContext: '记一笔' }) },
  ] }
  const out = await applyPermissionDeniedHooks(reg, 'run_command', {}, '规则拒绝', c)
  expect(out.retryRequested).toBe(true)
  expect(out.additionalContext).toEqual(['记一笔'])
})

test('applyTaskLifecycleHooks:deny 阻止任务创建/完成(deniedMessage)', async () => {
  const { applyTaskLifecycleHooks } = await import('./hooks')
  const c = ctx() as never
  const reg: HookRegistry = { rules: [{ event: 'TaskCreated', handler: () => ({ action: 'deny', message: '任务名不合规' }) }] }
  const blocked = await applyTaskLifecycleHooks(reg, 'TaskCreated', { taskId: 't1', taskSubject: 'x' }, c)
  expect(blocked.deniedMessage).toBe('任务名不合规')
  const pass = await applyTaskLifecycleHooks(reg, 'TaskCompleted', { taskId: 't1', taskSubject: 'x' }, c)
  expect(pass.deniedMessage).toBeUndefined()
})

test('applyElicitationHooks:elicitation 代答 accept 带 content;decline 同时置 deniedMessage', async () => {
  const { applyElicitationHooks } = await import('./hooks')
  const c = ctx() as never
  const acceptReg: HookRegistry = { rules: [{ event: 'Elicitation', matcher: 'srv', handler: () => ({ action: 'elicitation', elicitationAction: 'accept', content: { ok: 1 } }) }] }
  const accepted = await applyElicitationHooks(acceptReg, { serverName: 'srv', message: '要个名字' }, c)
  expect(accepted.response).toEqual({ action: 'accept', content: { ok: 1 } })
  expect(accepted.deniedMessage).toBeUndefined()
  const declineReg: HookRegistry = { rules: [{ event: 'Elicitation', handler: () => ({ action: 'elicitation', elicitationAction: 'decline' }) }] }
  const declined = await applyElicitationHooks(declineReg, { serverName: 'srv', message: 'q' }, c)
  expect(declined.response?.action).toBe('decline')
  expect(declined.deniedMessage).toBe('Elicitation denied by hook')
  // matcher 按 serverName:不中则无代答
  const missed = await applyElicitationHooks(acceptReg, { serverName: 'other', message: 'q' }, c)
  expect(missed.response).toBeUndefined()
})

test('applyWorktreeCreateHooks:provider 语义 — context 文本=路径;配置了但无产出=失败;没配置=双空', async () => {
  const { applyWorktreeCreateHooks } = await import('./hooks')
  const c = ctx() as never
  const provider: HookRegistry = { rules: [{ event: 'WorktreeCreate', handler: () => ({ action: 'context', additionalContext: '/tmp/wt-abc\n' }) }] }
  const ok = await applyWorktreeCreateHooks(provider, 'feature-x', c)
  expect(ok.worktreePath).toBe('/tmp/wt-abc')
  expect(ok.deniedMessage).toBeUndefined()
  const silent: HookRegistry = { rules: [{ event: 'WorktreeCreate', handler: () => null }] }
  const failed = await applyWorktreeCreateHooks(silent, 'feature-x', c)
  expect(failed.worktreePath).toBeUndefined()
  expect(failed.deniedMessage).toContain('WorktreeCreate hook failed')
  const none = await applyWorktreeCreateHooks({ rules: [] }, 'feature-x', c)
  expect(none.worktreePath).toBeUndefined()
  expect(none.deniedMessage).toBeUndefined()
})

test('非工具事件 matcher 键对齐 cc matchQuery:Notification 按类型/ConfigChange 按源/Setup 按 trigger', async () => {
  const { applyConfigChangeHooks, applySetupHooks } = await import('./hooks')
  const c = ctx() as never
  // Notification 按 notification_type 匹配(cc matchQuery=notificationType)
  const noteReg: HookRegistry = { rules: [{ event: 'Notification', matcher: 'permission_needed', handler: () => ({ action: 'context', additionalContext: '中' }) }] }
  const hit = await applyNotificationHooks(noteReg, { message: 'm', notificationType: 'permission_needed' }, c)
  expect(hit.additionalContext).toEqual(['中'])
  const miss = await applyNotificationHooks(noteReg, { message: 'm', notificationType: 'idle' }, c)
  expect(miss.additionalContext).toEqual([])
  // ConfigChange 按 source 匹配(cc matchQuery=source)
  const cfgReg: HookRegistry = { rules: [{ event: 'ConfigChange', matcher: 'skills', handler: () => ({ action: 'context', additionalContext: '技能变了' }) }] }
  expect((await applyConfigChangeHooks(cfgReg, 'skills', '/p/skill.md', c)).additionalContext).toEqual(['技能变了'])
  expect((await applyConfigChangeHooks(cfgReg, 'local_settings', undefined, c)).additionalContext).toEqual([])
  // Setup 按 trigger 匹配(cc matchQuery=trigger)
  const setupReg: HookRegistry = { rules: [{ event: 'Setup', matcher: 'init', handler: () => ({ action: 'context', additionalContext: '首启' }) }] }
  expect((await applySetupHooks(setupReg, 'init', c)).additionalContext).toEqual(['首启'])
  expect((await applySetupHooks(setupReg, 'maintenance', c)).additionalContext).toEqual([])
})
