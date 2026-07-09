import { describe, expect, test } from 'bun:test'
import type { Tool, ToolContext } from '../tools/Tool'
import { Workspace } from '../workspace/workspace'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePermission } from './resolve'
import type { PermissionRule } from './types'

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
    const d = resolvePermission(tool({ fatalReasonFor: () => '要删根目录' }), {}, ctx('bypassPermissions'))
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

  test('无 requiresApproval 的普通工具在执行档和 dontAsk 直接 allow', () => {
    for (const m of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk'] as const) {
      expect(resolvePermission(tool({}), {}, ctx(m)).behavior).toBe('allow')
    }
  })

  test('旧权限值会归一到 CC 五档兼容模式', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('ask'))).toMatchObject({
      behavior: 'ask',
      reason: { type: 'mode', mode: 'default' },
    })
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'file' }), {}, ctx('auto_files'))).toMatchObject({
      behavior: 'allow',
      reason: { type: 'mode', mode: 'acceptEdits' },
    })
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('full'))).toMatchObject({
      behavior: 'allow',
      reason: { type: 'mode', mode: 'bypassPermissions' },
    })
  })

  test('dontAsk 是正式模式:需要确认的动作直接 deny,不弹卡', () => {
    const d = resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('dontAsk'))
    expect(d).toMatchObject({ behavior: 'deny', reason: { type: 'mode', mode: 'dontAsk' } })
  })

  test('Delta B:forceConfirm 连 bypassPermissions(跳过确认)也弹卡', () => {
    const d = resolvePermission(tool({ requiresApproval: true, forceConfirm: true, approvalClass: 'destructive' }), {}, ctx('bypassPermissions'))
    expect(d.behavior).toBe('ask')
    expect(d.behavior === 'ask' && d.reason?.type).toBe('forceConfirm')
  })

  test('forceConfirmFor 可按入参动态强制确认', () => {
    const t = tool({
      requiresApprovalFor: input => !!(input as { restore?: boolean }).restore,
      forceConfirmFor: input => !!(input as { restore?: boolean }).restore,
      approvalClassFor: input => (input as { restore?: boolean }).restore ? 'destructive' : undefined,
    })
    expect(resolvePermission(t, { restore: false }, ctx('bypassPermissions')).behavior).toBe('allow')
    const d = resolvePermission(t, { restore: true }, ctx('bypassPermissions'))
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

  test('default 档:requiresApproval 工具 → ask', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('default')).behavior).toBe('ask')
  })

  test('default 档 file 类本机动作 ask,acceptEdits 才放行,非 file 类仍 ask', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'file' }), {}, ctx('default')).behavior).toBe('ask')
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'file' }), {}, ctx('acceptEdits')).behavior).toBe('allow')
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('acceptEdits')).behavior).toBe('ask')
  })

  test('结构化 permissionRules: deny 优先,ask 在普通模式弹卡,allow 放行', () => {
    const deny: PermissionRule = {
      source: 'userSettings',
      ruleBehavior: 'deny',
      ruleValue: { toolName: 'run_command' },
    }
    const askRule: PermissionRule = {
      source: 'projectSettings',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'run_command' },
    }
    const allow: PermissionRule = {
      source: 'localSettings',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'run_command' },
    }
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' })

    expect(resolvePermission(run, { command: 'curl https://example.com' }, ctx('bypassPermissions', { permissionRules: [deny] }))).toMatchObject({
      behavior: 'deny',
      reason: { type: 'rule', rule: deny },
    })
    expect(resolvePermission(run, { command: 'curl https://example.com' }, ctx('default', { permissionRules: [askRule, allow] }))).toMatchObject({
      behavior: 'ask',
      reason: { type: 'rule', rule: askRule },
    })
    expect(resolvePermission(run, { command: 'curl https://example.com' }, ctx('default', { permissionRules: [allow] }))).toMatchObject({
      behavior: 'allow',
      reason: { type: 'rule', rule: allow },
    })
  })

  test('结构化 permissionRules 支持 Bash 别名和命令内容匹配', () => {
    const allowGit: PermissionRule = {
      source: 'command',
      ruleBehavior: 'allow',
      ruleValue: { toolName: 'Bash', ruleContent: 'git:*' },
    }
    const askNpm: PermissionRule = {
      source: 'session',
      ruleBehavior: 'ask',
      ruleValue: { toolName: 'Bash', ruleContent: 'npm publish:*' },
    }
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })

    expect(resolvePermission(run, { command: 'git status --short' }, ctx('default', { permissionRules: [allowGit] }))).toMatchObject({
      behavior: 'allow',
      reason: { type: 'rule', rule: allowGit },
    })
    expect(resolvePermission(run, { command: 'npm publish --dry-run' }, ctx('default', { permissionRules: [askNpm, allowGit] }))).toMatchObject({
      behavior: 'ask',
      reason: { type: 'rule', rule: askNpm },
    })
    expect(resolvePermission(run, { command: 'npm publish --dry-run' }, ctx('dontAsk', { permissionRules: [askNpm] }))).toMatchObject({
      behavior: 'deny',
      reason: { type: 'mode', mode: 'dontAsk' },
    })
    expect(resolvePermission(run, { command: 'npm publish --dry-run' }, ctx('bypassPermissions', { permissionRules: [askNpm] }))).toMatchObject({
      behavior: 'allow',
      reason: { type: 'mode', mode: 'bypassPermissions' },
    })
  })

  test('bypassPermissions 档:spend 类按普通审批跳过,强确认另由 forceConfirm 表达', () => {
    const t = tool({ requiresApproval: true, approvalClass: 'spend' })
    expect(resolvePermission(t, {}, ctx('bypassPermissions')).behavior).toBe('allow')
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'spend', forceConfirm: true }), {}, ctx('bypassPermissions')).behavior).toBe('ask')
  })

  test('safePrefixFor 命中 → allow(即便 requiresApproval)', () => {
    const d = resolvePermission(tool({ requiresApproval: true, safePrefixFor: () => true }), {}, ctx('default'))
    expect(d.behavior).toBe('allow')
    expect(d.behavior === 'allow' && d.reason?.type).toBe('safePrefix')
  })

  test('sessionAllowedTools 放行普通审批,但不越过 plan/fatal/forceConfirm/用户交互', () => {
    const allowedCtx = ctx('default', { sessionAllowedTools: new Set(['run_command']) })
    const allowed = resolvePermission(tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' }), {}, allowedCtx)
    expect(allowed).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })

    expect(resolvePermission(tool({ name: 'run_command', requiresApproval: true }), {}, ctx('plan', { sessionAllowedTools: new Set(['run_command']) })).behavior).toBe('deny')
    expect(resolvePermission(tool({ name: 'run_command', fatalReasonFor: () => '禁止' }), {}, allowedCtx).behavior).toBe('deny')
    expect(resolvePermission(tool({ name: 'run_command', requiresApproval: true, forceConfirm: true }), {}, allowedCtx).behavior).toBe('ask')
    expect(resolvePermission(tool({ name: 'run_command', requiresApproval: true, requiresUserInteraction: true }), {}, allowedCtx).behavior).toBe('ask')

    const ruleCtx = ctx('default', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git:*' }] })
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })
    expect(resolvePermission(run, { command: 'git status --short' }, ruleCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    const outreachRun = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' })
    expect(resolvePermission(outreachRun, { command: 'curl https://example.com' }, ruleCtx).behavior).toBe('ask')
  })

  test('sessionAllowedToolRules 支持 shell exact/wildcard 规则', () => {
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })
    const wildcardCtx = ctx('default', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git status *' }] })
    expect(resolvePermission(run, { command: 'git status --short' }, wildcardCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'git status' }, wildcardCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    const outreachRun = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' })
    expect(resolvePermission(outreachRun, { command: 'git log --oneline' }, wildcardCtx).behavior).toBe('ask')

    const exactCtx = ctx('default', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git status' }] })
    expect(resolvePermission(run, { command: 'git status' }, exactCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(outreachRun, { command: 'git status --short' }, exactCtx).behavior).toBe('ask')
  })

  test('sessionAllowedToolRules normalize safe bash wrappers and reject partial compound matches', () => {
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'file' })
    const npmCtx = ctx('default', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'npm run *' }] })
    expect(resolvePermission(run, { command: 'NODE_ENV=test npm run build' }, npmCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    expect(resolvePermission(run, { command: 'timeout 10 npm run build' }, npmCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
    const outreachRun = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' })
    expect(resolvePermission(outreachRun, { command: 'PATH=/tmp npm run build' }, npmCtx).behavior).toBe('ask')
    expect(resolvePermission(outreachRun, { command: 'timeout -k$(id) 10 npm run build' }, npmCtx).behavior).toBe('ask')

    const gitOnlyCtx = ctx('default', { sessionAllowedToolRules: [{ tool: 'run_command', ruleContent: 'git:*' }] })
    expect(resolvePermission(outreachRun, { command: 'git status && curl https://example.com' }, gitOnlyCtx).behavior).toBe('ask')

    const compoundCtx = ctx('default', {
      sessionAllowedToolRules: [
        { tool: 'run_command', ruleContent: 'git:*' },
        { tool: 'run_command', ruleContent: 'printf:*' },
      ],
    })
    expect(resolvePermission(run, { command: 'git status && printf ok' }, compoundCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'run_command' } })
  })

  test('sessionAllowedToolRules 支持 PowerShell shell 规则', () => {
    const ps = tool({ name: 'PowerShell', requiresApproval: true, approvalClass: 'file' })
    const psCtx = ctx('default', { sessionAllowedToolRules: [{ tool: 'PowerShell', ruleContent: 'Get-ChildItem *' }] })
    expect(resolvePermission(ps, { command: 'Get-ChildItem src' }, psCtx)).toMatchObject({ behavior: 'allow', reason: { type: 'sessionAllowedTool', tool: 'PowerShell' } })
    const destructivePs = tool({ name: 'PowerShell', requiresApproval: true, approvalClass: 'destructive' })
    expect(resolvePermission(destructivePs, { command: 'Remove-Item src' }, psCtx).behavior).toBe('ask')
  })

  test('requiresApprovalFor 动态命中 → ask', () => {
    const d = resolvePermission(tool({ requiresApprovalFor: () => true, approvalClass: 'outreach' }), {}, ctx('default'))
    expect(d.behavior).toBe('ask')
  })

  test('工具钩子抛异常 → 失败关闭到 ask(不崩、绝不静默放行)', () => {
    expect(resolvePermission(tool({ fatalReasonFor: () => { throw new Error('boom') } }), {}, ctx('bypassPermissions')).behavior).toBe('ask')
    expect(resolvePermission(tool({ requiresApprovalFor: () => { throw new Error('boom') } }), {}, ctx('default')).behavior).toBe('ask')
  })
})

// —— 文件路径作用域规则对文件类工具(Read/Write/Edit)生效(cc filesystem.matchingRuleForInput 对齐)——
// 缺口:此前对文件工具一律不匹配 ruleContent,deny 读 .env / **/secrets/** 被静默放读。
describe('文件路径作用域规则(deny/ask/allow 对文件类工具生效)', () => {
  const read = tool({ name: 'read_file', isReadOnly: true })
  const edit = tool({ name: 'edit_file', requiresApproval: true, approvalClass: 'file' })
  const write = tool({ name: 'write_file', requiresApproval: true, approvalClass: 'file' })

  function fileRule(behavior: PermissionRule['ruleBehavior'], toolName: string, ruleContent?: string): PermissionRule {
    return { source: 'projectSettings', ruleBehavior: behavior, ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent } }
  }
  function fctx(w: ToolContext['workspace'], mode: ToolContext['permissionMode'], rules: PermissionRule[]): ToolContext {
    return ctx(mode, { workspace: w, permissionRules: rules })
  }

  test('deny Read(.env):读 .env 被拒(不再静默放读),且 deny 优先于任何档位', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '.env')]
    for (const m of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk'] as const) {
      const d = resolvePermission(read, { path: '.env' }, fctx(w, m, rules))
      expect(d.behavior).toBe('deny')
      expect(d.behavior === 'deny' && d.reason.type).toBe('rule')
    }
  })

  test('deny Read(.env):基名任意深度命中子目录 .env,但不误伤 foo.env', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '.env')]
    expect(resolvePermission(read, { path: 'sub/deep/.env' }, fctx(w, 'default', rules)).behavior).toBe('deny')
    expect(resolvePermission(read, { path: 'foo.env' }, fctx(w, 'default', rules)).behavior).toBe('allow')
    // `..` 先归一再匹配:sub/../.env → .env → 命中
    expect(resolvePermission(read, { path: 'sub/../.env' }, fctx(w, 'default', rules)).behavior).toBe('deny')
  })

  test('deny Read(**/secrets/**):命中任意层级 secrets 子目录,不相干路径放行', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '**/secrets/**')]
    expect(resolvePermission(read, { path: 'config/secrets/key.pem' }, fctx(w, 'default', rules)).behavior).toBe('deny')
    expect(resolvePermission(read, { path: 'a/b/secrets/c/d.txt' }, fctx(w, 'default', rules)).behavior).toBe('deny')
    expect(resolvePermission(read, { path: 'secrets/token' }, fctx(w, 'default', rules)).behavior).toBe('deny')
    expect(resolvePermission(read, { path: 'src/index.ts' }, fctx(w, 'default', rules)).behavior).toBe('allow')
  })

  test('Edit 家族规则作用于所有写/改工具(edit_file 与 write_file),但 deny 不外溢到读', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Edit', '.env')]
    expect(resolvePermission(edit, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(write, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    // cc:read 只吃 read-deny + edit-allow;Edit deny 不禁一个读动作。
    expect(resolvePermission(read, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('Read 家族 deny 不外溢到写工具(家族隔离:读禁不自动扩成写禁)', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '.env')]
    // 同一条规则:读被拒,写不受影响(bypass 下写无匹配规则 → 放行)。
    expect(resolvePermission(read, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(write, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('allow 规则放行命中路径(否则 default 下 file 类要 ask),未命中仍 ask', () => {
    const w = ws()
    const rules = [fileRule('allow', 'Write', 'build/**')]
    const hit = resolvePermission(write, { path: 'build/out.js' }, fctx(w, 'default', rules))
    expect(hit).toMatchObject({ behavior: 'allow', reason: { type: 'rule' } })
    expect(resolvePermission(write, { path: 'src/x.ts' }, fctx(w, 'default', rules)).behavior).toBe('ask')
  })

  test('ask 规则强制审批:即便 acceptEdits(本会自动放行文件写)也弹卡;dontAsk 下转 deny', () => {
    const w = ws()
    const rules = [fileRule('ask', 'Write', 'deploy/**')]
    const forced = resolvePermission(write, { path: 'deploy/app.tar' }, fctx(w, 'acceptEdits', rules))
    expect(forced).toMatchObject({ behavior: 'ask', reason: { type: 'rule' } })
    // 未命中 deploy 的路径在 acceptEdits 下 file 类自动放行。
    expect(resolvePermission(write, { path: 'src/x.ts' }, fctx(w, 'acceptEdits', rules)).behavior).toBe('allow')
    // dontAsk 把 ask 结果转成 deny(不弹卡)。
    expect(resolvePermission(write, { path: 'deploy/app.tar' }, fctx(w, 'dontAsk', rules)).behavior).toBe('deny')
  })

  test('通配工具名 * + 路径 glob 同时作用于读与写', () => {
    const w = ws()
    const rules = [fileRule('deny', '*', '*.pem')]
    expect(resolvePermission(read, { path: 'certs/server.pem' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(write, { path: 'certs/server.pem' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
  })

  test('裸 Read 规则(无 ruleContent)覆盖该家族全部读文件', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read')]
    expect(resolvePermission(read, { path: 'anything.txt' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    // 但不作用于写工具。
    expect(resolvePermission(write, { path: 'anything.txt' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('边界:根锚定 `/` 前缀只命中工作区根级,不命中子目录', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '/.env')]
    expect(resolvePermission(read, { path: '.env' }, fctx(w, 'default', rules)).behavior).toBe('deny')
    expect(resolvePermission(read, { path: 'sub/.env' }, fctx(w, 'default', rules)).behavior).toBe('allow')
  })

  test('边界:穿越到工作区外的路径,工作区作用域规则不匹配(scope 正确)', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '.env')]
    // ../outside.env 解析到工作区根之外 → 相对路径以 `../` 开头 → 规则跳过(不误命中)。
    expect(resolvePermission(read, { path: '../outside.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
    // 对照:同名文件在工作区内则被拒。
    expect(resolvePermission(read, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
  })

  test('命令类工具分支不受影响(run_command 仍按命令模式匹配,不当作路径)', () => {
    const w = ws()
    const run = tool({ name: 'run_command', requiresApproval: true, approvalClass: 'outreach' })
    const denyCurl: PermissionRule = { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'run_command', ruleContent: 'curl:*' } }
    expect(resolvePermission(run, { command: 'curl https://x.com' }, fctx(w, 'bypassPermissions', [denyCurl])).behavior).toBe('deny')
    expect(resolvePermission(run, { command: 'ls -la' }, fctx(w, 'bypassPermissions', [denyCurl])).behavior).toBe('allow')
  })
})

// —— 同族文件工具全部受路径规则 gate(对抗式审查员 POC 复现:真 resolvePermission)——
// 此前 filePathsFromInput / WRITE/READ_PATH_TOOLS 漂移,导致同族文件工具原样重开 .env 读/写保护洞:
//   • patch_files{patches:[{path:'.env'}]}:抽不到嵌套路径 → deny Edit(.env) 静默不匹配 → ALLOW(应 deny)
//   • restore_file(写工具)未加入 WRITE_PATH_TOOLS → 不 gate → deny Edit(.env) 失效
//   • code_outline(读工具,出 imports+符号)未加入 READ_PATH_TOOLS → deny Read(.env) 失效(泄露 import/符号)
// 均在 bypassPermissions 档验证:deny 规则优先于任何档位,连旁路也拦得住。
describe('同族文件工具受路径规则 gate(POC:bypassPermissions + deny 应拒)', () => {
  function fileRule(behavior: PermissionRule['ruleBehavior'], toolName: string, ruleContent: string): PermissionRule {
    return { source: 'projectSettings', ruleBehavior: behavior, ruleValue: { toolName, ruleContent } }
  }
  function fctx(w: ToolContext['workspace'], mode: ToolContext['permissionMode'], rules: PermissionRule[]): ToolContext {
    return ctx(mode, { workspace: w, permissionRules: rules })
  }

  test('patch_files{patches:[{path:.env}]} 被 deny Edit(.env) 拦下(原漏网洞:嵌套路径抽不到)', () => {
    const w = ws()
    const patchFiles = tool({ name: 'patch_files', requiresApproval: true, approvalClass: 'file' })
    const rules = [fileRule('deny', 'Edit', '.env')]
    const d = resolvePermission(patchFiles, { patches: [{ path: '.env', patch: '@@ -1 +1 @@' }] }, fctx(w, 'bypassPermissions', rules))
    expect(d.behavior).toBe('deny')
    expect(d.behavior === 'deny' && d.reason.type).toBe('rule')
    // 批里任一路径命中即拦(混入被禁文件不能靠夹带别的文件绕过)。
    expect(resolvePermission(patchFiles, { patches: [{ path: 'src/x.ts', patch: '@@' }, { path: '.env', patch: '@@' }] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    // 对照:全是无关文件则放行。
    expect(resolvePermission(patchFiles, { patches: [{ path: 'src/x.ts', patch: '@@' }] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('restore_file{path:.env} 被 deny Edit(.env) 拦下(原漏网洞:写工具未 gate)', () => {
    const w = ws()
    const restore = tool({ name: 'restore_file', isReadOnly: false, requiresApproval: true, approvalClass: 'destructive', forceConfirm: true })
    const rules = [fileRule('deny', 'Edit', '.env')]
    expect(resolvePermission(restore, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    // 对照:无关文件放行(还原本身仍会另走 forceConfirm,这里只验路径 deny 生效)。
    expect(resolvePermission(restore, { path: 'notes.txt' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('ask')
  })

  test('code_outline{path:.env} 被 deny Read(.env) 拦下(原漏网洞:读工具未 gate,防泄露 import/符号)', () => {
    const w = ws()
    const outline = tool({ name: 'code_outline', isReadOnly: true })
    const rules = [fileRule('deny', 'Read', '.env')]
    expect(resolvePermission(outline, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    // paths 数组形态也拦。
    expect(resolvePermission(outline, { paths: ['src/a.ts', '.env'] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(outline, { path: 'src/a.ts' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
    // Edit deny 不外溢到 code_outline 这个读动作(cc:read 只吃 read-deny)。
    expect(resolvePermission(outline, { path: '.env' }, fctx(w, 'bypassPermissions', [fileRule('deny', 'Edit', '.env')])).behavior).toBe('allow')
  })

  test('read_many_files:paths 与 ranges[].path 都受 deny Read(.env) 约束', () => {
    const w = ws()
    const readMany = tool({ name: 'read_many_files', isReadOnly: true })
    const rules = [fileRule('deny', 'Read', '.env')]
    expect(resolvePermission(readMany, { paths: ['.env'] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(readMany, { paths: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(readMany, { ranges: [{ path: '.env', start_line: 1 }] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(readMany, { paths: ['src/a.ts'] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('NotebookEdit:notebook_path 与 path 别名都受 deny Edit(.env) 约束', () => {
    const w = ws()
    const nb = tool({ name: 'NotebookEdit', requiresApproval: true, approvalClass: 'file' })
    const rules = [fileRule('deny', 'Edit', '.env')]
    expect(resolvePermission(nb, { notebook_path: '.env', new_source: 'x' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(nb, { path: '.env', new_source: 'x' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(nb, { notebook_path: 'analysis.ipynb', new_source: 'x' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('edit_excel / patch_file(单数) 受 deny Edit(.env) 约束', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Edit', '.env')]
    const excel = tool({ name: 'edit_excel', requiresApproval: true, approvalClass: 'file' })
    const patch = tool({ name: 'patch_file', requiresApproval: true, approvalClass: 'file' })
    expect(resolvePermission(excel, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(patch, { path: '.env', patch: '@@' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(excel, { path: 'report.xlsx' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })

  test('file_history{path:.env} 受 deny Read(.env) 约束(带 path 时会 emit 快照 diff = 历史内容)', () => {
    const w = ws()
    const rules = [fileRule('deny', 'Read', '.env')]
    const history = tool({ name: 'file_history', isReadOnly: true })
    expect(resolvePermission(history, { path: '.env' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(history, { paths: ['.env'] }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('deny')
    expect(resolvePermission(history, { path: 'notes.txt' }, fctx(w, 'bypassPermissions', rules)).behavior).toBe('allow')
  })
})
