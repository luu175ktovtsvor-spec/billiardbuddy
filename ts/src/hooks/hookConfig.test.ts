import { expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHookRegistryFile, normalizeHookRegistry } from './hookConfig'
import { runHookEvent } from './hooks'
import { Workspace } from '../workspace/workspace'
import type { AssistantStep, Model, ModelStepInput } from '../types/model'

async function withHttpServer(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server address unavailable')
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

function hookModel(step: AssistantStep): Model & { received: ModelStepInput[] } {
  const received: ModelStepInput[] = []
  return {
    received,
    async step(input) {
      received.push(input)
      return step
    },
  }
}

function firstPromptText(input: ModelStepInput): string {
  const block = input.messages[0]?.content[0]
  if (!block || block.type !== 'text') throw new Error('expected first model message to be text')
  return block.text
}

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

test('normalizeHookRegistry http hook posts payload, interpolates allowed headers and parses hook JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-http-'))
  const previousToken = process.env.HOOK_TEST_TOKEN
  process.env.HOOK_TEST_TOKEN = 'secret-token'
  try {
    await withHttpServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        const payload = JSON.parse(body) as { hook_event_name: string; agent_type: string; session_id: string }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          action: 'context',
          additionalContext: `${payload.hook_event_name}:${payload.agent_type}:${payload.session_id}:${req.headers.authorization}:${req.headers['x-denied']}`,
        }))
      })
    }, async url => {
      const registry = normalizeHookRegistry({
        hooks: {
          SubagentStart: [
            {
              matcher: 'researcher',
              hooks: [
                {
                  type: 'http',
                  url,
                  headers: {
                    Authorization: 'Bearer $HOOK_TEST_TOKEN',
                    'X-Denied': '$NOT_ALLOWED',
                  },
                  allowedEnvVars: ['HOOK_TEST_TOKEN'],
                },
              ],
            },
          ],
        },
      })
      const ctx = { workspace: new Workspace(root), conversationId: 'session-1' }
      expect(await runHookEvent(registry, { event: 'SubagentStart', agentType: 'researcher', agentId: 'agent-1', sessionId: 'agent-1' }, ctx)).toEqual([
        { action: 'context', additionalContext: 'SubagentStart:researcher:agent-1:Bearer secret-token:' },
      ])
    })
  } finally {
    if (previousToken === undefined) delete process.env.HOOK_TEST_TOKEN
    else process.env.HOOK_TEST_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry http hook supports CC-Haha hookSpecificOutput and non-2xx warning context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-http-specific-'))
  try {
    await withHttpServer((req, res) => {
      if (req.url === '/fail') {
        res.statusCode = 500
        res.end('backend down')
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'specific context',
        },
      }))
    }, async url => {
      const registry = normalizeHookRegistry({
        hooks: {
          SubagentStart: [
            {
              matcher: 'researcher',
              hooks: [
                { type: 'http', url },
                { type: 'http', url: `${url}/fail` },
              ],
            },
          ],
        },
      })
      const ctx = { workspace: new Workspace(root), conversationId: 'session-2' }
      expect(await runHookEvent(registry, { event: 'SubagentStart', agentType: 'researcher', agentId: 'agent-2', sessionId: 'agent-2' }, ctx)).toEqual([
        { action: 'context', additionalContext: 'specific context' },
        { action: 'context', additionalContext: '[SubagentStart http hook 非阻塞错误] HTTP 500: backend down' },
      ])
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry prompt hook queries model with substituted CC-Haha payload and allows ok true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-prompt-ok-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        PreToolUse: [
          {
            matcher: 'write_file',
            hooks: [
              {
                type: 'prompt',
                prompt: 'check payload $ARGUMENTS',
              },
            ],
          },
        ],
      },
    })
    const model = hookModel({ kind: 'final', text: '{"ok":true}' })
    const ctx = { workspace: new Workspace(root), conversationId: 'session-prompt', model }
    const decisions = await runHookEvent(registry, { event: 'PreToolUse', toolName: 'write_file', input: { path: 'a.ts' } }, ctx)
    expect(decisions).toEqual([{ action: 'allow' }])
    expect(model.received).toHaveLength(1)
    expect(model.received[0]!.system).toContain('{"ok": true}')
    expect(model.received[0]!.tools).toEqual([])
    const prompt = firstPromptText(model.received[0]!)
    expect(prompt).toContain('"hook_event_name":"PreToolUse"')
    expect(prompt).toContain('"tool_name":"write_file"')
    expect(prompt).not.toContain('$ARGUMENTS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry prompt hook supports indexed argument placeholders and appends arguments when missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-prompt-args-'))
  try {
    const first = normalizeHookRegistry({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'prompt', prompt: 'first=$ARGUMENTS[0] short=$0 all=$ARGUMENTS' }] },
        ],
      },
    })
    const firstModel = hookModel({ kind: 'final', text: '{"ok":true}' })
    await runHookEvent(first, { event: 'SessionStart', sessionId: 's1' }, { workspace: new Workspace(root), model: firstModel })
    const firstPrompt = firstPromptText(firstModel.received[0]!)
    expect(firstPrompt).toContain('first={hook_event_name:SessionStart')
    expect(firstPrompt).toContain('short={hook_event_name:SessionStart')
    expect(firstPrompt).toContain('all={"hook_event_name":"SessionStart"')

    const second = normalizeHookRegistry({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'prompt', prompt: 'plain prompt' }] },
        ],
      },
    })
    const secondModel = hookModel({ kind: 'final', text: '{"ok":true}' })
    await runHookEvent(second, { event: 'SessionStart', sessionId: 's2' }, { workspace: new Workspace(root), model: secondModel })
    const secondPrompt = firstPromptText(secondModel.received[0]!)
    expect(secondPrompt).toContain('plain prompt\n\nARGUMENTS: {"hook_event_name":"SessionStart"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry prompt hook maps ok false to deny', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-prompt-deny-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          { hooks: [{ type: 'prompt', prompt: 'verify final answer' }] },
        ],
      },
    })
    const model = hookModel({ kind: 'final', text: '{"ok":false,"reason":"missing tests"}' })
    const ctx = { workspace: new Workspace(root), conversationId: 'session-deny', model }
    expect(await runHookEvent(registry, { event: 'Stop', output: 'done' }, ctx)).toEqual([
      { action: 'deny', message: 'Prompt hook condition was not met: missing tests' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry prompt hook keeps ordinary invalid JSON non-blocking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-prompt-invalid-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          { hooks: [{ type: 'prompt', prompt: 'ordinary prompt hook' }] },
        ],
      },
    })
    const model = hookModel({ kind: 'final', text: 'not json' })
    const ctx = { workspace: new Workspace(root), model }
    expect(await runHookEvent(registry, { event: 'Stop', output: 'done' }, ctx)).toEqual([
      { action: 'context', additionalContext: '[Stop prompt hook 非阻塞错误] JSON validation failed: not json' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry prompt hook turns goal evaluator invalid JSON into blocking continuation feedback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-prompt-goal-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'prompt',
                prompt: [
                  '<cc-haha-goal-hook>',
                  '<goal-objective>',
                  'ship the goal',
                  '</goal-objective>',
                ].join('\n'),
              },
            ],
          },
        ],
      },
    })
    const model = hookModel({ kind: 'final', text: '{"ok":"bad"}' })
    const ctx = { workspace: new Workspace(root), model }
    const decisions = await runHookEvent(registry, { event: 'Stop', output: 'done' }, ctx)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.action).toBe('deny')
    expect(decisions[0]?.action === 'deny' ? decisions[0].message : '').toContain('Goal evaluator failed')
    expect(decisions[0]?.action === 'deny' ? decisions[0].message : '').toContain('continue working toward it')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
