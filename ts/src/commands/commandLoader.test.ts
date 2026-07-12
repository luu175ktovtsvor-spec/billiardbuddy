import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { filterBridgeSafeCommands, isBridgeSafeCommand, createCommandTools, formatCommandIndex, loadCommandsDir, loadCommandsFromRoots, mergeCommandLibraries, normalizeCommandName, parseCommandInvocation, publicCommand } from './commandLoader'
import { normalizeAllowedTools } from './allowedTools'
import type { PromptCommand } from './types'

test('parseCommandInvocation accepts cc-style slash command names', () => {
  expect(parseCommandInvocation('/plugin:name.run 参数 一二三')).toEqual({
    name: 'plugin:name.run',
    args: '参数 一二三',
    raw: '/plugin:name.run 参数 一二三',
  })
  expect(normalizeCommandName('/Daily Report')).toBe('daily-report')
  expect(parseCommandInvocation('普通消息 /not-command')).toBeNull()
})

test('parseCommandInvocation/normalizeCommandName 支持中文斜杠命令(如 /台球)', () => {
  // 领域斜杠命令能用母语敲:名字段接受中文字母,不再被 ASCII 白名单整段吞掉。
  expect(parseCommandInvocation('/台球 帮我看看今天')).toEqual({
    name: '台球',
    args: '帮我看看今天',
    raw: '/台球 帮我看看今天',
  })
  expect(parseCommandInvocation('/台球')).toEqual({ name: '台球', args: '', raw: '/台球' })
  expect(normalizeCommandName('台球')).toBe('台球')
  expect(normalizeCommandName('/球房')).toBe('球房')
})

test('bridge-safe command gate follows prompt/local/local-jsx policy', () => {
  const prompt = {
    type: 'prompt',
    name: 'daily-report',
    description: 'Daily',
    source: 'commands',
    filePath: 'daily.md',
    baseDir: '/',
    contentLength: 1,
    async getPrompt() { return 'daily' },
  } satisfies PromptCommand

  expect(isBridgeSafeCommand(prompt)).toBe(true)
  expect(isBridgeSafeCommand({ type: 'local', name: 'files' })).toBe(true)
  expect(isBridgeSafeCommand({ type: 'local', name: 'goal' })).toBe(false)
  expect(isBridgeSafeCommand({ type: 'local-jsx', name: 'model' })).toBe(false)
  expect(filterBridgeSafeCommands([prompt])).toEqual([prompt])
})

test('loadCommandsDir scans markdown slash commands with frontmatter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-'))
  try {
    mkdirSync(join(root, 'ops'), { recursive: true })
    writeFileSync(join(root, 'ops', 'daily.md'), `---
name: daily-report
description: Write a daily report
whenToUse: 每日复盘
allowedTools: [Read, "Bash(git:*)"]
context: fork
agent: reviewer
---
# Daily

Summarize store data.
`)
    const lib = await loadCommandsDir(root)
    expect(lib.commands).toHaveLength(1)
    expect(publicCommand(lib.commands[0]!)).toMatchObject({
      name: 'daily-report',
      description: 'Write a daily report',
      whenToUse: '每日复盘',
      allowedTools: ['read_file', 'read_many_files', 'run_command'],
      allowedToolRules: ['Read', 'Bash(git:*)'],
      context: 'fork',
      agent: 'reviewer',
      source: 'commands',
    })
    expect(formatCommandIndex(lib)).toContain('/daily-report: Write a daily report')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommandsDir parses space-separated allowedTools while preserving rule contents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-allowed-tools-string-'))
  try {
    writeFileSync(join(root, 'shell.md'), `---
description: Shell helpers
allowedTools: 'Read Bash(git status *) Bash(node -e "a,b")'
---
Use shell helpers.
`)
    const lib = await loadCommandsDir(root)
    expect(publicCommand(lib.commands[0]!)).toMatchObject({
      allowedTools: ['read_file', 'read_many_files', 'run_command'],
      allowedToolRules: ['Read', 'Bash(git status *)', 'Bash(node -e "a,b")'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeAllowedTools maps cc edit alias to file and spreadsheet mutation tools', () => {
  expect(normalizeAllowedTools(['Edit'])).toEqual(['edit_file', 'edit_excel', 'patch_file', 'patch_files'])
})

test('createCommandTools exposes list/read progressive disclosure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-tools-'))
  try {
    writeFileSync(join(root, 'plan.md'), `---
description: Plan a campaign
---
Use the campaign planning checklist.
`)
    const lib = await loadCommandsDir(root)
    const [list, read] = createCommandTools(lib)
    const ctx = { workspace: new Workspace(root) }
    const listed = await list!.execute({}, ctx)
    expect(listed).toContain('/plan: Plan a campaign')
    expect(listed).not.toContain('campaign planning checklist')
    const full = await read!.execute({ name: '/plan', args: '周末活动' }, ctx)
    expect(full).toContain('命令: /plan')
    expect(full).toContain('命令参数')
    expect(full).toContain('周末活动')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommandsFromRoots lets later roots override earlier commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-merge-'))
  const builtin = join(root, 'builtin')
  const workspace = join(root, 'workspace', '.claude', 'commands')
  try {
    mkdirSync(builtin, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(builtin, 'review.md'), `---
description: Builtin review
---
Use builtin review.
`)
    writeFileSync(join(workspace, 'review.md'), `---
description: Workspace review
---
Use workspace review.
`)
    writeFileSync(join(workspace, 'fix.md'), `---
description: Workspace fix
---
Use workspace fix.
`)
    const lib = await loadCommandsFromRoots([builtin, workspace])
    expect(lib.commands.map(c => c.name).sort()).toEqual(['fix', 'review'])
    expect(lib.byName.get('review')?.description).toBe('Workspace review')
    expect(await lib.byName.get('review')?.getPrompt('', { workspace: new Workspace(root) })).toContain('Use workspace review.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommandsDir parses argument-hint/arguments frontmatter onto the command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-argument-hint-'))
  try {
    writeFileSync(join(root, 'greet.md'), `---
description: Greet someone
argument-hint: '[name] [greeting]'
arguments: name greeting
---
Say hello.
`)
    const lib = await loadCommandsDir(root)
    expect(publicCommand(lib.commands[0]!)).toMatchObject({
      argumentHint: '[name] [greeting]',
      argNames: ['name', 'greeting'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadCommandFile getPrompt substitutes $ARGUMENTS/$1/named placeholders, blank on missing args', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-substitute-'))
  try {
    writeFileSync(join(root, 'greet.md'), `---
description: Greet someone
arguments: name greeting
---
Hello $name, mode=$greeting all=[$ARGUMENTS] first=$0 second=$1 third=$2
`)
    const lib = await loadCommandsDir(root)
    const ctx = { workspace: new Workspace(root) }
    const full = await lib.commands[0]!.getPrompt('Alice hi', ctx)
    expect(full).toContain('Hello Alice, mode=hi all=[Alice hi] first=Alice second=hi third=')
    // 未传参数时占位符原样(不替换),不追加"命令参数"尾注
    const bare = await lib.commands[0]!.getPrompt('', ctx)
    expect(bare).toContain('Hello , mode=')
    expect(bare).not.toContain('命令参数')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mergeCommandLibraries lets later libraries override earlier commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-library-merge-'))
  const builtin = join(root, 'builtin')
  const pack = join(root, 'pack')
  try {
    mkdirSync(builtin, { recursive: true })
    mkdirSync(pack, { recursive: true })
    writeFileSync(join(builtin, 'daily.md'), `---
description: Builtin daily
---
Use builtin daily.
`)
    writeFileSync(join(pack, 'daily.md'), `---
description: Pack daily
---
Use pack daily.
`)
    const merged = mergeCommandLibraries(await loadCommandsDir(builtin), await loadCommandsDir(pack))
    expect(merged.commands).toHaveLength(1)
    expect(merged.byName.get('daily')?.description).toBe('Pack daily')
    expect(await merged.byName.get('daily')?.getPrompt('', { workspace: new Workspace(root) })).toContain('Use pack daily.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─── 统一执行契约(对齐 cc 单一 Skill 工具语义):use_command 与 use_skill 同管线 ───

test('use_command:安全命令免审批、内置兜底内联展开;带 allowedTools 的命令默认走审批', async () => {
  const root = mkdtempSync(join(tmpdir(), 'use-command-'))
  try {
    writeFileSync(join(root, 'safe.md'), '---\ndescription: 安全命令\n---\n照做即可')
    writeFileSync(join(root, 'granting.md'), '---\ndescription: 放权命令\nallowedTools: ["run_command(git status:*)"]\n---\n跑 git status')
    const library = await loadCommandsDir(root)
    const tools = createCommandTools(library)
    const useCommand = tools.find(tool => tool.name === 'use_command')!
    const ctx = { workspace: new Workspace(root), conversationId: 'c1' } as import('../tools/Tool').ToolContext
    // 安全命令:免审批 + 内联展开
    expect(useCommand.requiresApprovalFor?.({ name: 'safe' }, ctx)).toBe(false)
    const out = await useCommand.execute({ name: 'safe' }, ctx)
    expect(out).toContain('<command_invoked name="/safe">')
    expect(out).toContain('照做即可')
    // 放权命令:默认审批(与 use_skill 同口径);执行后 allowedTools 灌进会话
    expect(useCommand.requiresApprovalFor?.({ name: 'granting' }, ctx)).toBe(true)
    await useCommand.execute({ name: 'granting' }, ctx)
    expect(ctx.sessionAllowedToolRules?.some(rule => rule.tool === 'run_command' && rule.ruleContent === 'git status:*')).toBe(true)
    // 记住允许后免审批(镜像 use_skill 的 allow 规则记忆)
    const rememberedCtx = {
      workspace: new Workspace(root),
      permissionRules: [{ source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'use_command', ruleContent: 'granting' } }],
    } as unknown as import('../tools/Tool').ToolContext
    expect(useCommand.requiresApprovalFor?.({ name: 'granting' }, rememberedCtx)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('use_command:传入 executeCommand 执行器时全权委托(与 use_skill 共用一条执行管线)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'use-command-exec-'))
  try {
    writeFileSync(join(root, 'work.md'), '---\ndescription: 干活\n---\n正文')
    const library = await loadCommandsDir(root)
    const seen: string[] = []
    const tools = createCommandTools(library, {
      executeCommand: async (command, args) => { seen.push(`${command.name}|${args}`); return 'delegated' },
    })
    const useCommand = tools.find(tool => tool.name === 'use_command')!
    const ctx = { workspace: new Workspace(root) } as import('../tools/Tool').ToolContext
    expect(await useCommand.execute({ name: 'work', args: 'a b' }, ctx)).toBe('delegated')
    expect(seen).toEqual(['work|a b'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('命令 frontmatter hooks 不再被静默丢弃;工作区来源标 local 受信任门约束', async () => {
  const root = mkdtempSync(join(tmpdir(), 'command-hooks-'))
  try {
    writeFileSync(join(root, 'hooked.md'), [
      '---',
      'description: 带钩子的命令',
      'hooks:',
      '  PostToolUse:',
      '    - hooks:',
      '        - type: command',
      '          command: echo done',
      '---',
      '正文',
    ].join('\n'))
    const managed = await loadCommandsDir(root)
    expect(managed.byName.get('hooked')?.hooks?.rules).toHaveLength(1)
    expect(managed.byName.get('hooked')?.hooks?.rules[0]?.source).toBeUndefined() // managed(可信)
    const local = await loadCommandsDir(root, 'local')
    expect(local.byName.get('hooked')?.hooks?.rules[0]?.source).toBe('local') // 工作区来源受信任门约束
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('frontmatter 三字段:disable-model-invocation 剔出模型清单/use_command 拒绝,user-invocable 只影响用户面,aliases 进 byName', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cmd-fm-'))
  try {
    writeFileSync(join(root, 'deploy.md'), '---\ndescription: 部署\ndisable-model-invocation: true\naliases: [ship, release]\n---\n部署流程')
    writeFileSync(join(root, 'hidden.md'), '---\ndescription: 内部\nuser-invocable: false\n---\n内部命令')
    writeFileSync(join(root, 'normal.md'), '---\ndescription: 普通\n---\n普通命令')
    const lib = await loadCommandsDir(root)

    // 别名进 byName(主名优先不被覆盖)
    expect(lib.byName.get('ship')?.name).toBe('deploy')
    expect(lib.byName.get('release')?.name).toBe('deploy')
    expect(lib.byName.get('deploy')?.name).toBe('deploy')
    expect(lib.commands.length).toBe(3) // commands 只含主名,不含别名重复

    // 解析正确
    expect(lib.byName.get('deploy')?.disableModelInvocation).toBe(true)
    expect(lib.byName.get('hidden')?.userInvocable).toBe(false)
    expect(lib.byName.get('normal')?.disableModelInvocation).toBeUndefined()

    // 模型面清单:deploy 不列(disable-model-invocation),hidden 与 normal 都列(user-invocable 不影响模型面)
    const index = formatCommandIndex(lib)
    expect(index).not.toContain('/deploy')
    expect(index).toContain('/hidden')
    expect(index).toContain('/normal')

    // use_command 拒绝 disable-model-invocation(用别名也拒——解析到同一命令)
    const useCommand = createCommandTools(lib).find(t => t.name === 'use_command')!
    const ctx = { workspace: new Workspace(root) } as never
    expect(await useCommand.execute({ name: 'deploy' }, ctx)).toContain('不可由模型调用')
    expect(await useCommand.execute({ name: 'ship' }, ctx)).toContain('不可由模型调用')
    expect(await useCommand.execute({ name: 'normal' }, ctx)).toContain('<command_invoked')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
