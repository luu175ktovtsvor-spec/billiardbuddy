import { describe, expect, test } from 'bun:test'
import type { Tool, ToolContext } from '../tools/Tool'
import { Workspace } from '../workspace/workspace'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePermission } from './resolve'

function ws() {
  return new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w4a-'))))
}
function ctx(mode: ToolContext['permissionMode'], extra: Partial<ToolContext> = {}): ToolContext {
  return { workspace: ws(), permissionMode: mode, ...extra }
}
/** 造一个工具,只填测试关心的权限字段,其余给桩。 */
function tool(over: Partial<Tool>): Tool {
  return {
    name: over.name ?? 't',
    description: '',
    inputSchema: { type: 'object' },
    isReadOnly: over.isReadOnly ?? false,
    async execute() {
      return 'ran'
    },
    ...over,
  }
}

describe('resolvePermission 瀑布', () => {
  test('fatal → deny(永不执行)', () => {
    const d = resolvePermission(tool({ fatalReasonFor: () => '要删根目录' }), {}, ctx('full'))
    expect(d.behavior).toBe('deny')
    expect(d.behavior === 'deny' && d.reason.type).toBe('fatal')
  })

  test('plan 模式 + 非只读 → deny(planSkip)', () => {
    const d = resolvePermission(tool({ isReadOnly: false }), {}, ctx('plan'))
    expect(d.behavior).toBe('deny')
    expect(d.behavior === 'deny' && d.reason.type).toBe('planSkip')
  })

  test('plan 模式 + 只读工具 → allow(可探索)', () => {
    const d = resolvePermission(tool({ isReadOnly: true }), {}, ctx('plan'))
    expect(d.behavior).toBe('allow')
  })

  test('Delta A:本机可逆动作(无 requiresApproval)在任何档都直接 allow', () => {
    for (const m of ['ask', 'auto_files', 'full'] as const) {
      expect(resolvePermission(tool({}), {}, ctx(m)).behavior).toBe('allow')
    }
  })

  test('Delta B:forceConfirm 连 full(跳过确认)也弹卡', () => {
    const d = resolvePermission(tool({ requiresApproval: true, forceConfirm: true, approvalClass: 'destructive' }), {}, ctx('full'))
    expect(d.behavior).toBe('ask')
    expect(d.behavior === 'ask' && d.reason?.type).toBe('forceConfirm')
  })

  test('forceConfirmFor 可按入参动态强制确认', () => {
    const t = tool({
      requiresApprovalFor: input => !!(input as { restore?: boolean }).restore,
      forceConfirmFor: input => !!(input as { restore?: boolean }).restore,
      approvalClassFor: input => (input as { restore?: boolean }).restore ? 'destructive' : undefined,
    })
    expect(resolvePermission(t, { restore: false }, ctx('full')).behavior).toBe('allow')
    const d = resolvePermission(t, { restore: true }, ctx('full'))
    expect(d).toMatchObject({ behavior: 'ask', approvalClass: 'destructive', reason: { type: 'forceConfirm' } })
  })

  test('bypassPermissions:跳过普通审批,但不跳过 fatal/forceConfirm/必须用户交互', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('bypassPermissions')).behavior).toBe('allow')

    const fatal = resolvePermission(tool({ fatalReasonFor: () => '禁止' }), {}, ctx('bypassPermissions'))
    expect(fatal.behavior).toBe('deny')

    const forced = resolvePermission(
      tool({ requiresApproval: true, forceConfirm: true, approvalClass: 'destructive' }),
      {},
      ctx('bypassPermissions'),
    )
    expect(forced.behavior).toBe('ask')
    expect(forced.behavior === 'ask' && forced.reason?.type).toBe('forceConfirm')

    const interactive = resolvePermission(
      tool({ requiresApproval: true, requiresUserInteraction: true, approvalClass: 'outreach' }),
      {},
      ctx('bypassPermissions'),
    )
    expect(interactive.behavior).toBe('ask')
    expect(interactive.behavior === 'ask' && interactive.reason?.type).toBe('requiresUserInteraction')
  })

  test('ask 档:requiresApproval 工具 → ask', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('ask')).behavior).toBe('ask')
  })

  test('auto_files 档:file 类放行、非 file 类仍 ask', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'file' }), {}, ctx('auto_files')).behavior).toBe('allow')
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('auto_files')).behavior).toBe('ask')
  })

  test('full 档:spend 类未过闸放行、过闸弹卡', () => {
    const t = tool({ requiresApproval: true, approvalClass: 'spend' })
    expect(resolvePermission(t, {}, ctx('full', { autoSpendCount: 0 })).behavior).toBe('allow')
    expect(resolvePermission(t, {}, ctx('full', { autoSpendCount: 3 })).behavior).toBe('ask')
  })

  test('safePrefixFor 命中 → allow(即便 requiresApproval)', () => {
    const d = resolvePermission(tool({ requiresApproval: true, safePrefixFor: () => true }), {}, ctx('ask'))
    expect(d.behavior).toBe('allow')
    expect(d.behavior === 'allow' && d.reason?.type).toBe('safePrefix')
  })

  test('sessionAllowedTools 放行普通审批,但不越过 plan/fatal/forceConfirm/用户交互', () => {
    const allowedCtx = ctx('ask', { sessionAllowedTools: new Set(['run_command']) })
    const allowed = resolvePermission(tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' }), {}, allowedCtx)
    expect(allowed).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })

    expect(resolvePermission(tool({ name: 'run_command', requiresApproval: true }), {}, ctx('plan', { sessionAllowedTools: new Set(['run_command']) })).behavior).toBe('deny')
    expect(resolvePermission(tool({ name: 'run_command', fatalReasonFor: () => '禁止' }), {}, allowedCtx).behavior).toBe('deny')
    expect(resolvePermission(tool({ name: 'run_command', requiresApproval: true, forceConfirm: true }), {}, allowedCtx).behavior).toBe('ask')
    expect(resolvePermission(tool({ name: 'run_command', requiresApproval: true, requiresUserInteraction: true }), {}, allowedCtx).behavior).toBe('ask')

    const ruleCtx = ctx('ask', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git:*' }] })
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })
    expect(resolvePermission(run, { command: 'git status --short' }, ruleCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'printf ok > file.txt' }, ruleCtx).behavior).toBe('ask')
  })

  test('sessionAllowedToolRules 支持 shell exact/wildcard 规则', () => {
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })
    const wildcardCtx = ctx('ask', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git status *' }] })
    expect(resolvePermission(run, { command: 'git status --short' }, wildcardCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'git status' }, wildcardCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'git log --oneline' }, wildcardCtx).behavior).toBe('ask')

    const exactCtx = ctx('ask', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git status' }] })
    expect(resolvePermission(run, { command: 'git status' }, exactCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'git status --short' }, exactCtx).behavior).toBe('ask')
  })

  test('sessionAllowedToolRules normalize safe bash wrappers and reject partial compound matches', () => {
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })
    const npmCtx = ctx('ask', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'npm run *' }] })
    expect(resolvePermission(run, { command: 'NODE_ENV=test npm run build' }, npmCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'timeout 10 npm run build' }, npmCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'PATH=/tmp npm run build' }, npmCtx).behavior).toBe('ask')
    expect(resolvePermission(run, { command: 'timeout -k$(id) 10 npm run build' }, npmCtx).behavior).toBe('ask')

    const gitOnlyCtx = ctx('ask', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git:*' }] })
    expect(resolvePermission(run, { command: 'git status && printf ok' }, gitOnlyCtx).behavior).toBe('ask')

    const compoundCtx = ctx('ask', {
      sessionAllowedToolRules: [
        { tool: 'run_command', ruleContent: 'git:*' },
        { tool: 'run_command', ruleContent: 'printf:*' },
      ],
    })
    expect(resolvePermission(run, { command: 'git status && printf ok' }, compoundCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
  })

  test('sessionAllowedToolRules 支持 PowerShell shell 规则', () => {
    const ps = tool({ name: 'PowerShell', requiresApproval: true, approvalClass: 'file' })
    const psCtx = ctx('ask', { sessionAllowedToolRules: [{ tool: 'PowerShell', ruleContent: 'Get-ChildItem *' }] })
    expect(resolvePermission(ps, { command: 'Get-ChildItem src' }, psCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'PowerShell' } })
    expect(resolvePermission(ps, { command: 'Remove-Item src' }, psCtx).behavior).toBe('ask')
  })

  test('requiresApprovalFor 动态命中 → ask', () => {
    const d = resolvePermission(tool({ requiresApprovalFor: () => true, approvalClass: 'outreach' }), {}, ctx('ask'))
    expect(d.behavior).toBe('ask')
  })

  test('工具钩子抛异常 → 失败关闭到 ask(不崩、绝不静默放行)', () => {
    expect(resolvePermission(tool({ fatalReasonFor: () => { throw new Error('boom') } }), {}, ctx('full')).behavior).toBe('ask')
    expect(resolvePermission(tool({ requiresApprovalFor: () => { throw new Error('boom') } }), {}, ctx('ask')).behavior).toBe('ask')
  })
})
