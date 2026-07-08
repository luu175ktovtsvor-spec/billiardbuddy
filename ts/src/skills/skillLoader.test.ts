import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { createSkillTools, formatSkillIndex, loadSkillsDir } from './skillLoader'
import { clearInvokedSkills, getInvokedSkillsForScope } from './invokedSkills'

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
      context: 'fork',
      agent: 'designer',
    })
    expect(formatSkillIndex(lib)).toContain('poster-maker: Make posters')
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
    const out = await use.execute({ skill: 'report', args: '今天' }, { workspace: new Workspace(root), conversationId: 'conv-use-skill' })
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
