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
