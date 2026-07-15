import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from '../tools/Tool'
import { bundledSkillsRoot, createSkillTools, formatSkillIndex, loadLayeredSkills, loadSkillsDir, skillHasOnlySafeProperties, skillRequiresApproval, userSkillsRoot, workspaceSkillsRoot } from './skillLoader'
import { clearInvokedSkills, getInvokedSkillsForScope } from './invokedSkills'
import { resolvePermission } from '../permissions/resolve'
import { actionKey, recordApproval, shouldAutoApprove } from '../permissions/denialTracking'
import type { PermissionRule } from '../permissions/types'

test('loadSkillsDir:只加载 */SKILL.md,frontmatter 变 PromptCommand', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-'))
  try {
    mkdirSync(join(root, 'poster'), { recursive: true })
    writeFileSync(join(root, 'poster', 'SKILL.md'), `---
name: poster-maker
description: Make posters
allowedTools: [read_file, write_file]
context: fork
agent: designer
hooks:
  SubagentStart:
    - matcher: designer
      hooks:
        - decision:
            action: context
            additionalContext: skill-start
---
# Poster

Follow these steps.
`)
    const lib = await loadSkillsDir(root)
    expect(lib.skills).toHaveLength(1)
    expect(lib.skills[0]).toMatchObject({
      type: 'prompt',
      name: 'poster-maker',
      description: 'Make posters',
      allowedTools: ['read_file', 'write_file'],
      allowedToolRules: ['read_file', 'write_file'],
      context: 'fork',
      agent: 'designer',
    })
    expect(lib.skills[0]!.hooks?.rules.map(rule => [rule.event, rule.matcher])).toEqual([
      ['SubagentStart', 'designer'],
    ])
    expect(formatSkillIndex(lib)).toContain('poster-maker: Make posters')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSkillsDir:保留中文技能名和中文别名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-unicode-name-'))
  try {
    mkdirSync(join(root, 'modular-router'), { recursive: true })
    writeFileSync(join(root, 'modular-router', 'SKILL.md'), `---
name: 模块化开发总路由
description: 先判断模块再改代码
aliases: [模块化开工, project-router]
---
先追踪调用链。
`)
    const lib = await loadLayeredSkills({ bundledRoot: root, userRoot: null })
    expect(lib.skills[0]?.name).toBe('模块化开发总路由')
    expect(lib.byName.get('模块化开工')?.name).toBe('模块化开发总路由')
    expect(lib.byName.get('project-router')?.name).toBe('模块化开发总路由')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSkillsDir:读取 agents/openai.yaml 展示元数据且不扩大技能权限', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-interface-'))
  try {
    const dir = join(root, 'daily-review')
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---
name: daily-review
description: Review daily data
---
Review facts.
`)
    writeFileSync(join(dir, 'agents', 'openai.yaml'), `interface:
  display_name: "经营日报复盘"
  short_description: "汇总真实数据并形成次日动作"
  default_prompt: "使用 $daily-review 复盘今天。"
`)

    const skill = (await loadSkillsDir(root)).skills[0]!
    expect(skill).toMatchObject({
      displayName: '经营日报复盘',
      shortDescription: '汇总真实数据并形成次日动作',
    })
    expect(skillRequiresApproval(skill)).toBe(false)

    writeFileSync(join(dir, 'agents', 'openai.yaml'), 'interface: [bad')
    const malformed = (await loadSkillsDir(root)).skills[0]!
    expect(malformed.displayName).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSkillsDir:解析 argument-hint/arguments frontmatter 并挂到 PromptCommand', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-argument-hint-'))
  try {
    mkdirSync(join(root, 'greet'), { recursive: true })
    writeFileSync(join(root, 'greet', 'SKILL.md'), `---
description: Greet someone
argument-hint: '[name] [greeting]'
arguments: name greeting
---
Say hello.
`)
    const lib = await loadSkillsDir(root)
    expect(lib.skills[0]).toMatchObject({
      argumentHint: '[name] [greeting]',
      argNames: ['name', 'greeting'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSkillsDir:来源分层——hookSource:local 给 frontmatter hooks 打 local 标(受信任门约束);默认 managed 无标', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-hooksrc-'))
  try {
    mkdirSync(join(root, 'guard'), { recursive: true })
    writeFileSync(join(root, 'guard', 'SKILL.md'), `---
name: guard
description: guard skill
hooks:
  PreToolUse:
    - matcher: write_file
      hooks:
        - type: command
          command: echo hi
---
Guard writes.
`)
    // 工作区提供的 .claude/skills → local(其 command hook 未受信工作区里不 spawn)
    const local = await loadSkillsDir(root, { hookSource: 'local' })
    expect(local.skills[0]!.hooks?.rules.length).toBeGreaterThan(0)
    expect(local.skills[0]!.hooks?.rules.every(rule => rule.source === 'local')).toBe(true)
    // app 内置 / 插件(默认)→ managed:无 source 标记,不受信任门约束
    const managed = await loadSkillsDir(root)
    expect(managed.skills[0]!.hooks?.rules.every(rule => rule.source === undefined)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadSkillFile getPrompt substitutes $ARGUMENTS/$1/named placeholders, blank on missing args', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-substitute-'))
  try {
    mkdirSync(join(root, 'greet'), { recursive: true })
    writeFileSync(join(root, 'greet', 'SKILL.md'), `---
description: Greet someone
arguments: name greeting
---
Hello $name, mode=$greeting all=[$ARGUMENTS] first=$0 second=$1 third=$2
`)
    const lib = await loadSkillsDir(root)
    const ctx = { workspace: new Workspace(root) }
    const full = await lib.skills[0]!.getPrompt('Alice hi', ctx)
    expect(full).toContain('Hello Alice, mode=hi all=[Alice hi] first=Alice second=hi third=')
    const bare = await lib.skills[0]!.getPrompt('', ctx)
    expect(bare).toContain('Hello , mode=')
    expect(bare).not.toContain('用户给这个技能的参数')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSkillTools:渐进式披露,先 list 再 read 完整正文', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-tools-'))
  try {
    mkdirSync(join(root, 'report'), { recursive: true })
    writeFileSync(join(root, 'report', 'SKILL.md'), `---
description: Write reports
---
Use store facts. ${'x'.repeat(20)}
`)
    const lib = await loadSkillsDir(root)
    const [list, read] = createSkillTools(lib)
    const ctx = { workspace: new Workspace(root) }
    const listed = await list!.execute({}, ctx)
    expect(listed).toContain('report: Write reports')
    expect(listed).not.toContain('Use store facts')
    const full = await read!.execute({ name: 'report', args: '今天' }, ctx)
    expect(full).toContain('Use store facts')
    expect(full).toContain('用户给这个技能的参数')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSkillTools:use_skill executes inline skills and accepts args', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-use-'))
  try {
    clearInvokedSkills('conv-use-skill')
    mkdirSync(join(root, 'report'), { recursive: true })
    writeFileSync(join(root, 'report', 'SKILL.md'), `---
description: Write reports
allowedTools: [Read, "Bash(git:*)"]
---
Use store facts.
`)
    const lib = await loadSkillsDir(root)
    const use = createSkillTools(lib).find(tool => tool.name === 'use_skill')!
    const ctx: ToolContext = { workspace: new Workspace(root), conversationId: 'conv-use-skill' }
    const out = await use.execute({ skill: 'report', args: '今天' }, ctx)
    expect(out).toContain('技能: report')
    expect(out).toContain('Use store facts')
    expect(out).toContain('用户给这个技能的参数')
    expect(out).toContain('今天')
    expect(out).toContain('<skill_allowed_tools skill="report">')
    expect(out).toContain('- read_file')
    expect(out).toContain('- read_many_files')
    expect(out).toContain('- run_command')
    expect(getInvokedSkillsForScope('conv-use-skill')[0]).toMatchObject({
      skillName: 'report',
      content: expect.stringContaining('Use store facts'),
    })
    expect(ctx.sessionAllowedTools).toEqual(new Set(['read_file', 'read_many_files']))
    expect(ctx.sessionAllowedToolRules).toEqual([{ tool: 'run_command', ruleContent: 'git:*' }])
  } finally {
    clearInvokedSkills('conv-use-skill')
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSkillTools:list_skills prioritizes and filters enabled-pack recommendations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-recommended-'))
  try {
    mkdirSync(join(root, 'daily-report'), { recursive: true })
    writeFileSync(join(root, 'daily-report', 'SKILL.md'), `---
description: Write daily reports
whenToUse: 老板要日报时
---
Daily report body.
`)
    mkdirSync(join(root, 'generic'), { recursive: true })
    writeFileSync(join(root, 'generic', 'SKILL.md'), `---
description: Generic helper
---
Generic body.
`)
    const lib = await loadSkillsDir(root)
    const [list] = createSkillTools(lib, { recommendedSkillNames: ['daily-report'] })
    const ctx = { workspace: new Workspace(root) }

    const listed = await list!.execute({}, ctx)
    expect(listed).toContain('已启用领域包推荐技能优先展示:daily-report')
    expect(listed.indexOf('daily-report [推荐]:')).toBeLessThan(listed.indexOf('generic:'))

    const recommendedOnly = await list!.execute({ recommended_only: true }, ctx)
    expect(recommendedOnly).toContain('daily-report [推荐]: Write daily reports')
    expect(recommendedOnly).not.toContain('generic')

    expect(await list!.execute({ query: 'generic' }, ctx)).toContain('generic: Generic helper')
    expect(await list!.execute({ query: 'missing', recommended_only: true }, ctx)).toBe('当前没有匹配技能。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createSkillTools:create_skill writes SKILL.md and updates current library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-create-'))
  try {
    const lib = await loadSkillsDir(root)
    const tools = createSkillTools(lib, { skillRoot: root })
    const create = tools.find(t => t.name === 'create_skill')!
    const list = tools.find(t => t.name === 'list_skills')!
    const read = tools.find(t => t.name === 'read_skill')!
    const ctx = { workspace: new Workspace(root) }

    const out = await create.execute({
      name: 'Daily Report',
      description: 'Write daily store reports',
      whenToUse: '老板要日报时',
      allowedTools: ['read_file', 'write_file'],
      instructions: '# Daily Report\n\n1. 汇总流水。\n2. 给出明日动作。',
    }, ctx)
    expect(out).toContain('daily-report')
    expect(formatSkillIndex(lib)).toContain('daily-report: Write daily store reports')
    expect(await list.execute({}, ctx)).toContain('使用时机:老板要日报时')
    const full = await read.execute({ name: 'daily-report' }, ctx)
    expect(full).toContain('汇总流水')

    await expect(create.execute({
      name: 'Daily Report',
      description: 'dup',
      instructions: 'dup',
    }, ctx)).rejects.toThrow(/已存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('bundledSkillsRoot:app 内置技能目录能被发现,含搬运过来的 commit/skillify/security-review', async () => {
  const lib = await loadSkillsDir(bundledSkillsRoot())
  const names = lib.skills.map(skill => skill.name)
  expect(names).toContain('commit')
  expect(names).toContain('skillify')
  expect(names).toContain('security-review')
  expect(names).toContain('review')
  expect(names).toContain('simplify')
  expect(names).toContain('verify')
  expect(names).toContain('debug')
  // frontmatter 正确解析:commit 的 allowedTools 归一化后含 run_command(Bash 别名)
  expect(lib.byName.get('commit')?.allowedTools).toContain('run_command')
  // 白标铁律:内置技能正文不得残留 Claude 字样
  for (const skill of lib.skills) {
    const body = await skill.getPrompt('', { workspace: new Workspace(process.cwd()) })
    expect(body.toLowerCase()).not.toContain('claude')
  }
})

test('userSkillsRoot / workspaceSkillsRoot:白标目录派生(.billiardbuddy,绝不 .claude)', () => {
  const prev = process.env.BILLIARDBUDDY_CONFIG_DIR
  const home = mkdtempSync(join(tmpdir(), 'bb-home-'))
  process.env.BILLIARDBUDDY_CONFIG_DIR = home
  try {
    expect(userSkillsRoot()).toBe(join(home, 'skills'))
    expect(userSkillsRoot()).not.toContain('.claude')
    expect(workspaceSkillsRoot('/proj')).toBe(join('/proj', '.billiardbuddy', 'skills'))
    expect(workspaceSkillsRoot('/proj')).not.toContain('.claude')
  } finally {
    if (prev === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadLayeredSkills:三层合并——workspace 带 local 信任标,同名覆盖 workspace>user>bundled', async () => {
  const bundled = mkdtempSync(join(tmpdir(), 'skills-bundled-'))
  const user = mkdtempSync(join(tmpdir(), 'skills-user-'))
  const wsRoot = mkdtempSync(join(tmpdir(), 'skills-ws-'))
  try {
    const write = (root: string, name: string, body: string) => {
      mkdirSync(join(root, name), { recursive: true })
      writeFileSync(join(root, name, 'SKILL.md'), body)
    }
    write(bundled, 'only-bundled', `---\ndescription: bundled only\n---\nB`)
    write(bundled, 'shared', `---\ndescription: from-bundled\n---\nB`)
    write(user, 'only-user', `---\ndescription: user only\n---\nU`)
    write(user, 'shared', `---\ndescription: from-user\n---\nU`)
    // 工作区技能落在 <wsRoot>/.billiardbuddy/skills 下
    const wsSkills = workspaceSkillsRoot(wsRoot)
    write(wsSkills, 'only-ws', `---\ndescription: ws only\nhooks:\n  PreToolUse:\n    - matcher: write_file\n      hooks:\n        - type: command\n          command: echo hi\n---\nW`)
    write(wsSkills, 'shared', `---\ndescription: from-ws\n---\nW`)

    const lib = await loadLayeredSkills({ bundledRoot: bundled, userRoot: user, workspaceRoot: wsRoot })
    const names = lib.skills.map(s => s.name).sort()
    expect(names).toEqual(['only-bundled', 'only-user', 'only-ws', 'shared'])
    // 同名覆盖:workspace 最后加载,赢
    expect(lib.byName.get('shared')?.description).toBe('from-ws')
    // 三层各自打 skillLayer 标(前端斜杠浮层「系统/个人/项目」作用域);同名覆盖后层标随覆盖者走
    expect(lib.byName.get('only-bundled')?.skillLayer).toBe('bundled')
    expect(lib.byName.get('only-user')?.skillLayer).toBe('user')
    expect(lib.byName.get('only-ws')?.skillLayer).toBe('workspace')
    expect(lib.byName.get('shared')?.skillLayer).toBe('workspace')
    // 工作区技能的 frontmatter hooks 必须带 local 信任标(否则绕过信任门)
    expect(lib.byName.get('only-ws')?.hooks?.rules.every(r => r.source === 'local')).toBe(true)
    // 内置技能不带 local 标(managed 可信)
    const onlyBundled = await loadSkillsDir(bundled)
    expect(onlyBundled.byName.get('only-bundled')?.hooks?.rules ?? []).toHaveLength(0)
  } finally {
    rmSync(bundled, { recursive: true, force: true })
    rmSync(user, { recursive: true, force: true })
    rmSync(wsRoot, { recursive: true, force: true })
  }
})

// —— use_skill 授权闸行为对齐(掰回“调技能绕过 Bash 审批”提权洞,口径照 cc SkillTool.checkPermissions)——

function makeSkillLib(root: string, name: string, frontmatter: string, body = 'do stuff') {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
}

async function useSkillTool(root: string) {
  const lib = await loadSkillsDir(root)
  const use = createSkillTools(lib).find(tool => tool.name === 'use_skill')!
  return use
}

test('use_skill 授权闸:带 allowedTools(git push)的技能触发 ask、不自动灌 allow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-gate-danger-'))
  try {
    makeSkillLib(root, 'deploy', 'name: deploy\ndescription: Deploy\nallowedTools: ["Bash(git push:*)"]')
    const use = await useSkillTool(root)
    const ctx: ToolContext = { workspace: new Workspace(root), conversationId: 'gate-danger' }

    // skillHasOnlySafeProperties/skillRequiresApproval 判定与 cc 一致:携带 allowedTools = 需审批
    const lib = await loadSkillsDir(root)
    expect(skillHasOnlySafeProperties(lib.byName.get('deploy')!)).toBe(false)
    expect(skillRequiresApproval(lib.byName.get('deploy')!)).toBe(true)

    const decision = resolvePermission(use, { skill: 'deploy' }, ctx)
    expect(decision.behavior).toBe('ask')
    // 关键红线:仅决定审批,execute 尚未执行 → 绝不把工具灌进会话(否则 git push 被旁路放行)
    expect(ctx.sessionAllowedTools).toBeUndefined()
    expect(ctx.sessionAllowedToolRules).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('use_skill 授权闸:携带 hooks 的技能同样触发 ask', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-gate-hooks-'))
  try {
    makeSkillLib(root, 'guard', 'name: guard\ndescription: Guard\nhooks:\n  PreToolUse:\n    - matcher: write_file\n      hooks:\n        - type: command\n          command: echo hi')
    const use = await useSkillTool(root)
    const ctx: ToolContext = { workspace: new Workspace(root), conversationId: 'gate-hooks' }
    const lib = await loadSkillsDir(root)
    expect(skillRequiresApproval(lib.byName.get('guard')!)).toBe(true)
    expect(resolvePermission(use, { skill: 'guard' }, ctx).behavior).toBe('ask')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('use_skill 授权闸:纯安全属性技能自动放行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-gate-safe-'))
  try {
    makeSkillLib(root, 'greet', 'name: greet\ndescription: Greet\nwhenToUse: 打招呼时\nmodel: fast')
    const use = await useSkillTool(root)
    const ctx: ToolContext = { workspace: new Workspace(root), conversationId: 'gate-safe' }
    const lib = await loadSkillsDir(root)
    expect(skillHasOnlySafeProperties(lib.byName.get('greet')!)).toBe(true)
    expect(skillRequiresApproval(lib.byName.get('greet')!)).toBe(false)
    expect(resolvePermission(use, { skill: 'greet' }, ctx).behavior).toBe('allow')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('use_skill 授权闸:记忆 allow 规则后二次放行(按名 + prefix,对齐 cc allowRules)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-gate-remember-'))
  try {
    makeSkillLib(root, 'deploy', 'name: deploy\ndescription: Deploy\nallowedTools: ["Bash(git push:*)"]')
    const use = await useSkillTool(root)
    const base: ToolContext = { workspace: new Workspace(root), conversationId: 'gate-remember' }

    // 首次:无规则 → ask
    expect(resolvePermission(use, { skill: 'deploy' }, base).behavior).toBe('ask')

    // 记住“允许 deploy 技能”后(按名 allow 规则)→ 二次放行
    const named: ToolContext = {
      ...base,
      permissionRules: [{ source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'use_skill', ruleContent: 'deploy' } }] as PermissionRule[],
    }
    expect(resolvePermission(use, { skill: 'deploy' }, named).behavior).toBe('allow')

    // 前缀规则 dep:* 亦放行
    const prefixed: ToolContext = {
      ...base,
      permissionRules: [{ source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'use_skill', ruleContent: 'dep:*' } }] as PermissionRule[],
    }
    expect(resolvePermission(use, { skill: 'deploy' }, prefixed).behavior).toBe('allow')

    // 不相干的按名规则不放行(仍 ask),防止规则误匹配放宽
    const unrelated: ToolContext = {
      ...base,
      permissionRules: [{ source: 'session', ruleBehavior: 'allow', ruleValue: { toolName: 'use_skill', ruleContent: 'other' } }] as PermissionRule[],
    }
    expect(resolvePermission(use, { skill: 'deploy' }, unrelated).behavior).toBe('ask')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('use_skill 授权闸:harness 原生审批记忆(recordApproval)后二次免卡', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-gate-native-'))
  try {
    makeSkillLib(root, 'deploy', 'name: deploy\ndescription: Deploy\nallowedTools: ["Bash(git push:*)"]')
    const use = await useSkillTool(root)
    const conversationId = 'gate-native-mem'
    const ctx: ToolContext = { workspace: new Workspace(root), conversationId }
    const input = { skill: 'deploy' }

    // 首次仍 ask,且原生记忆里没有该 key
    expect(resolvePermission(use, input, ctx).behavior).toBe('ask')
    const key = actionKey('use_skill', input)
    expect(shouldAutoApprove(conversationId, key)).toBe(false)

    // 老板“批准并记住”后,loop 会 recordApproval → 相同 (工具,入参) 二次自动放行,不再弹卡
    recordApproval(conversationId, key)
    expect(shouldAutoApprove(conversationId, key)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('create_skill:默认落用户白标目录 ~/.billiardbuddy/skills(server 用 userSkillsRoot 接线)', async () => {
  const prev = process.env.BILLIARDBUDDY_CONFIG_DIR
  const home = mkdtempSync(join(tmpdir(), 'bb-home-create-'))
  process.env.BILLIARDBUDDY_CONFIG_DIR = home
  try {
    const skillRoot = userSkillsRoot()
    const lib = await loadSkillsDir(skillRoot)
    const create = createSkillTools(lib, { skillRoot }).find(t => t.name === 'create_skill')!
    const ctx = { workspace: new Workspace(home) }
    const out = await create.execute({
      name: 'Daily Report',
      description: 'Write daily store reports',
      instructions: '# Daily Report\n\n1. 汇总流水。',
    }, ctx)
    const written = join(home, 'skills', 'daily-report', 'SKILL.md')
    expect(existsSync(written)).toBe(true)
    expect(out).toContain(written)
    // 落在白标目录,绝不 .claude
    expect(written).not.toContain('.claude')
    const freshSessionLibrary = await loadLayeredSkills({ bundledRoot: join(home, 'bundled'), userRoot: skillRoot })
    expect(freshSessionLibrary.byName.get('daily-report')).toMatchObject({
      name: 'daily-report',
      skillLayer: 'user',
    })
  } finally {
    if (prev === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('parseSkillPaths(对齐 cc):去 /** 后缀、全 ** 视作无、支持逗号/换行/数组', async () => {
  const { parseSkillPaths } = await import('./skillLoader')
  expect(parseSkillPaths(undefined)).toBeUndefined()
  expect(parseSkillPaths('**')).toBeUndefined()          // 全 match-all → 无条件
  expect(parseSkillPaths('src/**')).toEqual(['src'])     // 去 /** 后缀
  expect(parseSkillPaths('*.sql, migrations/**')).toEqual(['*.sql', 'migrations'])
  expect(parseSkillPaths(['*.ts', '*.tsx'])).toEqual(['*.ts', '*.tsx'])
})

test('条件技能(带 paths)默认不进发现清单,但 by-name 可调;activateConditionalSkillsForPaths 命中路径才激活', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-paths-'))
  try {
    const bundled = join(root, 'bundled'); mkdirSync(join(bundled, 'sqlhelper'), { recursive: true })
    mkdirSync(join(bundled, 'always'), { recursive: true })
    writeFileSync(join(bundled, 'sqlhelper', 'SKILL.md'), '---\nname: sqlhelper\ndescription: SQL 助手\npaths: "*.sql"\n---\n写 SQL')
    writeFileSync(join(bundled, 'always', 'SKILL.md'), '---\nname: always\ndescription: 常驻\n---\n常驻技能')
    const lib = await loadLayeredSkills({ bundledRoot: bundled, userRoot: null })

    // 发现清单只含无条件技能;条件技能不列
    expect(lib.skills.map(s => s.name)).toEqual(['always'])
    expect(formatSkillIndex(lib)).not.toContain('sqlhelper')
    // 但 byName 里有(可 by-name 调 / 供激活扫描)
    expect(lib.byName.get('sqlhelper')?.paths).toEqual(['*.sql'])

    // 碰到 *.sql 文件 → 激活;碰到别的 → 不激活
    const { activateConditionalSkillsForPaths } = await import('./skillLoader')
    expect([...activateConditionalSkillsForPaths(lib, root, ['db/schema.sql'])]).toEqual(['sqlhelper'])
    expect([...activateConditionalSkillsForPaths(lib, root, ['src/app.ts'])]).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('问题4:技能别名进 byName(主名优先不覆盖)+ realpath 去重(symlink 同物理文件只算一次)', async () => {
  const { symlinkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'skill-alias-real-'))
  try {
    const bundled = join(root, 'bundled')
    mkdirSync(join(bundled, 'commit'), { recursive: true })
    mkdirSync(join(bundled, 'realtool'), { recursive: true })
    writeFileSync(join(bundled, 'commit', 'SKILL.md'), '---\nname: commit\ndescription: 提交\naliases: [ci, gc]\n---\n提交流程')
    writeFileSync(join(bundled, 'realtool', 'SKILL.md'), '---\nname: realtool\ndescription: 真实\n---\n真实技能')
    const lib = await loadLayeredSkills({ bundledRoot: bundled, userRoot: null })
    // 别名进 byName、指向主名技能
    expect(lib.byName.get('ci')?.name).toBe('commit')
    expect(lib.byName.get('gc')?.name).toBe('commit')
    expect(lib.skills.map(s => s.name).sort()).toEqual(['commit', 'realtool']) // skills 数组不含别名重复

    // realpath 去重:user 层 symlink 指向 bundled 的同一物理文件 → 只算一次
    const user = join(root, 'user')
    mkdirSync(join(user, 'linked'), { recursive: true })
    symlinkSync(join(bundled, 'realtool', 'SKILL.md'), join(user, 'linked', 'SKILL.md'))
    const lib2 = await loadLayeredSkills({ bundledRoot: bundled, userRoot: user })
    const realCount = lib2.skills.filter(s => {
      try { return require('node:fs').realpathSync(s.filePath) === require('node:fs').realpathSync(join(bundled, 'realtool', 'SKILL.md')) } catch { return false }
    }).length
    expect(realCount).toBe(1) // 同物理文件只留一个条目
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('问题4 补防线:技能别名与某真实主名冲突时,byName 指向真实主名技能(别名不覆盖主名)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-alias-conflict-'))
  try {
    const bundled = join(root, 'bundled')
    mkdirSync(join(bundled, 'deploy'), { recursive: true })
    mkdirSync(join(bundled, 'ship'), { recursive: true })
    // ship 技能声明别名 'deploy' —— 但 deploy 是另一个技能的真实主名,别名不能覆盖它
    writeFileSync(join(bundled, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: 真实部署技能\n---\n主名 deploy')
    writeFileSync(join(bundled, 'ship', 'SKILL.md'), '---\nname: ship\ndescription: 发货\naliases: [deploy]\n---\n别名想抢 deploy')
    const lib = await loadLayeredSkills({ bundledRoot: bundled, userRoot: null })
    // 冲突消解:deploy 键必须指向真实的 deploy 技能,不是 ship
    expect(lib.byName.get('deploy')?.name).toBe('deploy')
    expect(lib.byName.get('deploy')?.description).toBe('真实部署技能')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('toolInputFilePaths:覆盖各文件工具真实入参形状(单数path/read_many的paths数组+ranges/patch_files的patches)', async () => {
  const { toolInputFilePaths, FILE_TOUCH_TOOL_NAMES } = await import('./skillLoader')
  // 顶层单数 path(read_file/edit_file/multi_edit_file/patch_file/write_file)
  expect(toolInputFilePaths({ path: 'a.sql' })).toEqual(['a.sql'])
  expect(toolInputFilePaths({ file_path: 'b.sql' })).toEqual(['b.sql'])
  // read_many_files:paths 数组(审查逮到:旧实现对它返回 undefined)
  expect(toolInputFilePaths({ paths: ['a.sql', 'b.sql'] })).toEqual(['a.sql', 'b.sql'])
  expect(toolInputFilePaths({ paths: 'single.sql' })).toEqual(['single.sql'])
  // read_many_files:ranges[].path
  expect(toolInputFilePaths({ ranges: [{ path: 'c.sql', start: 1 }] })).toEqual(['c.sql'])
  // patch_files:patches[].path
  expect(toolInputFilePaths({ patches: [{ path: 'd.sql', patch: 'x' }, { path: 'e.sql', patch: 'y' }] })).toEqual(['d.sql', 'e.sql'])
  // NotebookEdit:notebook_path 主字段(审查逮到旧实现只认单数 path、提不出 notebook_path)
  expect(toolInputFilePaths({ notebook_path: 'nb.ipynb' })).toEqual(['nb.ipynb'])
  // 空/非对象
  expect(toolInputFilePaths({})).toEqual([])
  expect(toolInputFilePaths(null)).toEqual([])
  // 全部会读/改文件的工具都在触发集合(审查逮到 multi_edit_file/patch_file/patch_files/edit_excel/NotebookEdit 曾漏掉;
  // 权威对照源 = tools/fileHistory.ts FileHistoryOperation 全写工具 + read_file/read_many_files)
  for (const name of ['read_file', 'read_many_files', 'write_file', 'edit_file', 'edit_excel', 'multi_edit_file', 'patch_file', 'patch_files', 'NotebookEdit']) {
    expect(FILE_TOUCH_TOOL_NAMES.has(name)).toBe(true)
  }
})
