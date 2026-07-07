import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../tools/Tool'
import { loadAgentsDir, resolveAgentTools } from './agentLoader'

test('loadAgentsDir:加载 .md agent frontmatter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agents-'))
  try {
    writeFileSync(join(root, 'billiards.md'), `---
name: billiards-ops
description: 台球运营代理
tools: [read_file, list_dir]
disallowedTools: [list_dir]
model: mimo-v2.5
skills: [daily-report]
memory: true
permissionMode: plan
maxTurns: 3
initialPrompt: 先读约束。
background: true
isolation: worktree
requiredMcpServers: [local fixture]
mcpServers:
  - local fixture
  - inline fixture:
      command: node
      args: [server.js]
hooks:
  SubagentStart:
    - matcher: billiards-ops
      hooks:
        - decision:
            action: context
            additionalContext: agent starting
  Stop:
    - matcher: billiards-ops
      hooks:
        - decision:
            action: context
            additionalContext: agent stopping
---
你是台球运营代理。
`)
    const agents = await loadAgentsDir(root)
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: 'billiards-ops',
      description: '台球运营代理',
      tools: ['read_file', 'list_dir'],
      disallowedTools: ['list_dir'],
      model: 'mimo-v2.5',
      skills: ['daily-report'],
      memory: true,
      permissionMode: 'plan',
      maxTurns: 3,
      initialPrompt: '先读约束。',
      background: true,
      isolation: 'worktree',
      requiredMcpServers: ['local fixture'],
      mcpServers: [
        'local fixture',
        { 'inline fixture': { command: 'node', args: ['server.js'] } },
      ],
      hooks: {
        rules: [
          { event: 'SubagentStart', matcher: 'billiards-ops' },
          { event: 'SubagentStop', matcher: 'billiards-ops' },
        ],
      },
      prompt: '你是台球运营代理。',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveAgentTools:按 tools 子集过滤,* 表示全量', () => {
  const tools = [
    { name: 'read_file' },
    { name: 'write_file' },
    { name: 'list_dir' },
  ] as Tool[]
  expect(resolveAgentTools({ name: 'a', description: '', prompt: '', filePath: '', tools: ['read_file'] }, tools).map(t => t.name))
    .toEqual(['read_file'])
  expect(resolveAgentTools({ name: 'a', description: '', prompt: '', filePath: '' }, tools).map(t => t.name))
    .toEqual(['read_file', 'write_file', 'list_dir'])
  expect(resolveAgentTools({ name: 'a', description: '', prompt: '', filePath: '', disallowedTools: ['write_file'] }, tools).map(t => t.name))
    .toEqual(['read_file', 'list_dir'])
  expect(resolveAgentTools({ name: 'a', description: '', prompt: '', filePath: '', tools: ['read_file', 'write_file'], disallowedTools: ['write_file'] }, tools).map(t => t.name))
    .toEqual(['read_file'])
})
