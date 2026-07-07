import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHookRegistryFile, normalizeHookRegistry } from './hookConfig'
import { runHookEvent } from './hooks'
import { Workspace } from '../workspace/workspace'

test('normalizeHookRegistry supports hooks/rules arrays and drops invalid entries', async () => {
  const registry = normalizeHookRegistry({
    hooks: [
      { event: 'SessionStart', decision: { action: 'context', additionalContext: '店脑上下文' } },
      { event: 'PreToolUse', matcher: 'write_file', decisions: [{ action: 'deny', message: '不许写' }] },
      { event: 'BadEvent', decision: { action: 'context', additionalContext: 'skip' } },
      { event: 'SessionStart', decision: { action: 'context' } },
    ],
  })
  expect(registry.rules).toHaveLength(2)

  const ctx = { workspace: new Workspace(mkdtempSync(join(tmpdir(), 'hook-config-'))) }
  try {
    const session = await runHookEvent(registry, { event: 'SessionStart' }, ctx)
    expect(session).toEqual([{ action: 'context', additionalContext: '店脑上下文' }])
    const pre = await runHookEvent(registry, { event: 'PreToolUse', toolName: 'write_file' }, ctx)
    expect(pre).toEqual([{ action: 'deny', message: '不许写' }])
  } finally {
    rmSync(ctx.workspace.root, { recursive: true, force: true })
  }
})

test('loadHookRegistryFile returns undefined for missing/invalid/empty config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-file-'))
  try {
    expect(await loadHookRegistryFile(join(root, 'missing.json'))).toBeUndefined()
    const bad = join(root, 'bad.json')
    writeFileSync(bad, 'not-json')
    expect(await loadHookRegistryFile(bad)).toBeUndefined()
    const empty = join(root, 'empty.json')
    writeFileSync(empty, '{"hooks":[]}')
    expect(await loadHookRegistryFile(empty)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadHookRegistryFile loads static JSON decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-file-'))
  try {
    const file = join(root, 'hooks.json')
    writeFileSync(file, JSON.stringify({
      rules: [
        { event: 'UserPromptSubmit', decision: { action: 'modify', updatedInput: 'rewritten' } },
      ],
    }))
    const registry = await loadHookRegistryFile(file)
    expect(registry?.rules).toHaveLength(1)
    const ctx = { workspace: new Workspace(root) }
    expect(await runHookEvent(registry, { event: 'UserPromptSubmit', userPrompt: 'x' }, ctx)).toEqual([
      { action: 'modify', updatedInput: 'rewritten', message: undefined },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry supports CC-Haha frontmatter event map and agent Stop conversion', async () => {
  const registry = normalizeHookRegistry({
    SubagentStart: [
      {
        matcher: 'researcher',
        hooks: [
          { decision: { action: 'context', additionalContext: '启动上下文' } },
        ],
      },
    ],
    Stop: [
      {
        matcher: 'researcher',
        hooks: [
          { decision: { action: 'context', additionalContext: '收尾上下文' } },
        ],
      },
    ],
  }, { agentFrontmatter: true })
  expect(registry.rules.map(rule => [rule.event, rule.matcher])).toEqual([
    ['SubagentStart', 'researcher'],
    ['SubagentStop', 'researcher'],
  ])

  const ctx = { workspace: new Workspace(mkdtempSync(join(tmpdir(), 'hook-config-frontmatter-'))) }
  try {
    expect(await runHookEvent(registry, { event: 'SubagentStart', agentType: 'researcher', agentId: 'a1' }, ctx)).toEqual([
      { action: 'context', additionalContext: '启动上下文' },
    ])
    expect(await runHookEvent(registry, { event: 'SubagentStop', agentType: 'researcher', agentId: 'a1', output: 'done' }, ctx)).toEqual([
      { action: 'context', additionalContext: '收尾上下文' },
    ])
  } finally {
    rmSync(ctx.workspace.root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry command hook sends CC-Haha-style payload on stdin and parses stdout context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-command-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        SubagentStart: [
          {
            matcher: 'researcher',
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);console.log(JSON.stringify({action:'context',additionalContext:p.hook_event_name+':'+p.agent_type+':'+p.session_id}))})"`,
              },
            ],
          },
        ],
      },
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'session-1' }
    expect(await runHookEvent(registry, { event: 'SubagentStart', agentType: 'researcher', agentId: 'agent-1', sessionId: 'agent-1' }, ctx)).toEqual([
      { action: 'context', additionalContext: 'SubagentStart:researcher:agent-1' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
