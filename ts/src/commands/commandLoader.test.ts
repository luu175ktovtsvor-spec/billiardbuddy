import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { createCommandTools, formatCommandIndex, loadCommandsDir, normalizeCommandName, parseCommandInvocation, publicCommand } from './commandLoader'

test('parseCommandInvocation accepts cc-style slash command names', () => {
  expect(parseCommandInvocation('/plugin:name.run 参数 一二三')).toEqual({
    name: 'plugin:name.run',
    args: '参数 一二三',
    raw: '/plugin:name.run 参数 一二三',
  })
  expect(normalizeCommandName('/Daily Report')).toBe('daily-report')
  expect(parseCommandInvocation('普通消息 /not-command')).toBeNull()
})

test('loadCommandsDir scans markdown slash commands with frontmatter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'commands-'))
  try {
    mkdirSync(join(root, 'ops'), { recursive: true })
    writeFileSync(join(root, 'ops', 'daily.md'), `---
name: daily-report
description: Write a daily report
whenToUse: 每日复盘
allowedTools: [read_file]
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
      allowedTools: ['read_file'],
      source: 'commands',
    })
    expect(formatCommandIndex(lib)).toContain('/daily-report: Write a daily report')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
