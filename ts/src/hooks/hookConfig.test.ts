import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_DOT_DIR } from '../harness/memoryNames'
import { loadHookRegistryFile, loadPluginHookRegistry, loadWorkspaceHookRegistry, normalizeHookRegistry } from './hookConfig'
import { configureHookTrust, resetHookTrust, runHookEvent } from './hooks'

// 前后都复位:防其它测试文件(index.test.ts 的 startServer 会 configureHookTrust)在同进程泄漏进程级 override。
beforeEach(() => resetHookTrust())
afterEach(() => resetHookTrust())
import { Workspace } from '../workspace/workspace'
import type { AssistantStep, Model, ModelStepInput } from '../types/model'
import type { Tool } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'

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

function scriptedHookModel(steps: AssistantStep[]): Model & { received: ModelStepInput[] } {
  const received: ModelStepInput[] = []
  return {
    received,
    async step(input) {
      received.push(input)
      const step = steps.shift()
      if (!step) throw new Error('scripted hook model exhausted')
      return step
    },
  }
}

function testTool(name: string, execute: Tool['execute'], isReadOnly = true): Tool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object' },
    isReadOnly,
    execute,
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

// —— P0 回归:hook 配置三级加载(user/project/local),取代已删除的死路径 defaultHooksPath()/server/hooks.json ——
// 对齐同仓库 permissions/permissionsSettings.ts loadPermissionRules 的三级路径解析;隔离
// BILLIARDBUDDY_CONFIG_DIR 让 loadUserHookRegistry 不读开发机真实 ~/.billiardbuddy。
test('loadWorkspaceHookRegistry:user(~/.billiardbuddy/settings.json)+ project(.billiardbuddy/settings.json)+ local(settings.local.json)三级全部加载并合并生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-settings-'))
  const userHome = mkdtempSync(join(tmpdir(), 'bb-hook-userhome-'))
  const savedConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
  process.env.BILLIARDBUDDY_CONFIG_DIR = userHome
  try {
    writeFileSync(join(userHome, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'user-hook' } }] },
    }))
    mkdirSync(join(root, MEMORY_DOT_DIR), { recursive: true })
    writeFileSync(join(root, MEMORY_DOT_DIR, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'project-hook' } }] },
    }))
    writeFileSync(join(root, MEMORY_DOT_DIR, 'settings.local.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'local-hook' } }] },
    }))
    // .claude 里放东西不该被读到(白标掰回分叉,与 permissionsSettings 同一口径)
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'should-not-load' } }] },
    }))

    const registry = await loadWorkspaceHookRegistry(root)
    expect(registry?.rules).toHaveLength(3)
    expect(registry?.rules.map(rule => rule.source).sort()).toEqual(['local', 'local', 'user'])

    const wsCtx = { workspace: new Workspace(root) }
    const decisions = await runHookEvent(registry, { event: 'SessionStart' }, wsCtx)
    const notes = decisions.filter((d): d is { action: 'context'; additionalContext: string } => d.action === 'context').map(d => d.additionalContext).sort()
    expect(notes).toEqual(['local-hook', 'project-hook', 'user-hook'])
    expect(notes).not.toContain('should-not-load')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(userHome, { recursive: true, force: true })
    if (savedConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = savedConfigDir
  }
})

test('loadWorkspaceHookRegistry + 信任门:未受信工作区挡下 project/local(source:local),user 不受影响', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-settings-trust-'))
  const userHome = mkdtempSync(join(tmpdir(), 'bb-hook-userhome-trust-'))
  const savedConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
  process.env.BILLIARDBUDDY_CONFIG_DIR = userHome
  try {
    writeFileSync(join(userHome, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'user-hook' } }] },
    }))
    mkdirSync(join(root, MEMORY_DOT_DIR), { recursive: true })
    writeFileSync(join(root, MEMORY_DOT_DIR, 'settings.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'project-hook' } }] },
    }))
    writeFileSync(join(root, MEMORY_DOT_DIR, 'settings.local.json'), JSON.stringify({
      hooks: { SessionStart: [{ decision: { action: 'context', additionalContext: 'local-hook' } }] },
    }))

    configureHookTrust({ interactive: true, isWorkspaceTrusted: () => false })
    const registry = await loadWorkspaceHookRegistry(root)
    const wsCtx = { workspace: new Workspace(root) }
    const decisions = await runHookEvent(registry, { event: 'SessionStart' }, wsCtx)
    const notes = decisions.filter((d): d is { action: 'context'; additionalContext: string } => d.action === 'context').map(d => d.additionalContext)
    // 未受信:只有 user 生效,project/local(source:'local')被信任门挡下
    expect(notes).toEqual(['user-hook'])

    // 受信后 project/local 恢复生效
    configureHookTrust({ interactive: true, isWorkspaceTrusted: () => true })
    const trustedDecisions = await runHookEvent(registry, { event: 'SessionStart' }, wsCtx)
    const trustedNotes = trustedDecisions.filter((d): d is { action: 'context'; additionalContext: string } => d.action === 'context').map(d => d.additionalContext).sort()
    expect(trustedNotes).toEqual(['local-hook', 'project-hook', 'user-hook'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(userHome, { recursive: true, force: true })
    if (savedConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = savedConfigDir
  }
})

test('loadWorkspaceHookRegistry:extraPath 显式覆盖路径叠加(source:local),与三级设置文件一起合并', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-settings-extra-'))
  const userHome = mkdtempSync(join(tmpdir(), 'bb-hook-userhome-extra-'))
  const savedConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
  process.env.BILLIARDBUDDY_CONFIG_DIR = userHome
  try {
    const extraPath = join(root, 'explicit-hooks.json')
    writeFileSync(extraPath, JSON.stringify({
      hooks: [{ event: 'SessionStart', decision: { action: 'context', additionalContext: 'explicit-hook' } }],
    }))
    const registry = await loadWorkspaceHookRegistry(root, extraPath)
    expect(registry?.rules).toHaveLength(1)
    expect(registry?.rules[0]?.source).toBe('local')
    const wsCtx = { workspace: new Workspace(root) }
    expect(await runHookEvent(registry, { event: 'SessionStart' }, wsCtx)).toEqual([
      { action: 'context', additionalContext: 'explicit-hook' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(userHome, { recursive: true, force: true })
    if (savedConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = savedConfigDir
  }
})

test('loadWorkspaceHookRegistry:三级文件全缺失安全退 undefined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-settings-empty-'))
  const userHome = mkdtempSync(join(tmpdir(), 'bb-hook-userhome-empty-'))
  const savedConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
  process.env.BILLIARDBUDDY_CONFIG_DIR = userHome
  try {
    expect(await loadWorkspaceHookRegistry(root)).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(userHome, { recursive: true, force: true })
    if (savedConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
    else process.env.BILLIARDBUDDY_CONFIG_DIR = savedConfigDir
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

test('normalizeHookRegistry supports once hooks from frontmatter maps', async () => {
  const registry = normalizeHookRegistry({
    hooks: {
      PreToolUse: [
        {
          matcher: 'write_file',
          hooks: [
            { once: true, decision: { action: 'context', additionalContext: 'first only' } },
          ],
        },
      ],
    },
  })
  const ctx = { workspace: new Workspace(mkdtempSync(join(tmpdir(), 'hook-config-once-'))) }
  try {
    expect(await runHookEvent(registry, { event: 'PreToolUse', toolName: 'write_file' }, ctx)).toEqual([
      { action: 'context', additionalContext: 'first only' },
    ])
    expect(await runHookEvent(registry, { event: 'PreToolUse', toolName: 'write_file' }, ctx)).toEqual([])
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

test('normalizeHookRegistry:source:local 标记透传到每条规则;loadHookRegistryFile 加载的文件 hook 标 local', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-source-'))
  try {
    const tagged = normalizeHookRegistry({
      hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'echo hi' }, { decision: { action: 'deny', message: 'no' } }] }] },
    }, { source: 'local' })
    expect(tagged.rules.length).toBeGreaterThan(0)
    expect(tagged.rules.every(rule => rule.source === 'local')).toBe(true)

    // 未标 source 的内置(managed)注册表不带 local 标记
    const managed = normalizeHookRegistry({ hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'echo hi' }] }] } })
    expect(managed.rules.every(rule => rule.source === undefined)).toBe(true)

    // 从文件加载的 hook 视为 local(工作区 .claude/settings 攻击面)
    const hooksFile = join(root, 'hooks.json')
    writeFileSync(hooksFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }))
    const loaded = await loadHookRegistryFile(hooksFile)
    expect(loaded?.rules.every(rule => rule.source === 'local')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('信任门端到端:交互未受信时 local command hook 不 spawn(不落哨兵文件);受信则正常执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-gate-'))
  try {
    const sentinel = join(root, 'sentinel.txt')
    const registry = normalizeHookRegistry({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `${process.execPath} -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(sentinel)}` }] }] },
    }, { source: 'local' })
    const ctx = { workspace: new Workspace(root), conversationId: 'gate' }

    // 交互 + 未受信:command hook 被信任门拦下,子进程根本不 spawn
    configureHookTrust({ interactive: true, isWorkspaceTrusted: () => false })
    const blocked = await runHookEvent(registry, { event: 'SessionStart', sessionId: 'gate' }, ctx)
    expect(blocked).toEqual([])
    expect(existsSync(sentinel)).toBe(false)

    // 交互 + 受信:正常执行,哨兵文件落盘
    configureHookTrust({ interactive: true, isWorkspaceTrusted: () => true })
    await runHookEvent(registry, { event: 'SessionStart', sessionId: 'gate' }, ctx)
    expect(existsSync(sentinel)).toBe(true)
  } finally {
    resetHookTrust()
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

test('normalizeHookRegistry http hook enforces URL policy patterns before network I/O', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-http-policy-'))
  try {
    await withHttpServer((_req, res) => {
      res.end(JSON.stringify({ action: 'context', additionalContext: 'allowed url' }))
    }, async url => {
      const registry = normalizeHookRegistry({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'http', url },
              ],
            },
          ],
        },
      }, {
        httpPolicy: { allowedUrls: [`${url}*`] },
      })
      const decisions = await runHookEvent(registry, { event: 'SessionStart', sessionId: 's-http-policy' }, {
        workspace: new Workspace(root),
        conversationId: 's-http-policy',
      })
      expect(decisions).toEqual([
        { action: 'context', additionalContext: 'allowed url' },
      ])

      const blockedRegistry = normalizeHookRegistry({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'http', url }] },
          ],
        },
      }, {
        httpPolicy: { allowedUrls: [] },
      })
      expect(await runHookEvent(blockedRegistry, { event: 'SessionStart', sessionId: 's-http-policy' }, {
        workspace: new Workspace(root),
        conversationId: 's-http-policy',
      })).toEqual([
        { action: 'deny', message: `HTTP hook blocked: ${url}/ does not match any pattern in allowedHttpHookUrls` },
      ])
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadHookRegistryFile applies CC-Haha-style top-level HTTP hook policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-http-file-policy-'))
  const previousToken = process.env.HOOK_FILE_POLICY_TOKEN
  process.env.HOOK_FILE_POLICY_TOKEN = 'file-policy-token'
  try {
    await withHttpServer((req, res) => {
      res.end(JSON.stringify({
        action: 'context',
        additionalContext: `${req.headers.authorization}`,
      }))
    }, async url => {
      const file = join(root, 'hooks.json')
      writeFileSync(file, JSON.stringify({
        allowedHttpHookUrls: [`${url}*`],
        httpHookAllowedEnvVars: ['HOOK_FILE_POLICY_TOKEN'],
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'http',
                  url,
                  headers: { Authorization: 'Bearer $HOOK_FILE_POLICY_TOKEN' },
                  allowedEnvVars: ['HOOK_FILE_POLICY_TOKEN'],
                },
              ],
            },
          ],
        },
      }))
      const registry = await loadHookRegistryFile(file)
      expect(await runHookEvent(registry, { event: 'SessionStart', sessionId: 's-http-file-policy' }, {
        workspace: new Workspace(root),
      })).toEqual([
        { action: 'context', additionalContext: 'Bearer file-policy-token' },
      ])
    })
  } finally {
    if (previousToken === undefined) delete process.env.HOOK_FILE_POLICY_TOKEN
    else process.env.HOOK_FILE_POLICY_TOKEN = previousToken
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry http hook intersects hook and policy env allowlists and strips header injection bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-http-env-policy-'))
  const previousAllowed = process.env.HOOK_ALLOWED_TOKEN
  const previousDenied = process.env.HOOK_DENIED_TOKEN
  process.env.HOOK_ALLOWED_TOKEN = 'safe-token\r\nX-Injected: yes'
  process.env.HOOK_DENIED_TOKEN = 'denied-token'
  try {
    await withHttpServer((req, res) => {
      res.end(JSON.stringify({
        action: 'context',
        additionalContext: `${req.headers.authorization}:${req.headers['x-denied']}:${req.headers['x-injected'] ?? ''}`,
      }))
    }, async url => {
      const registry = normalizeHookRegistry({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'http',
                  url,
                  headers: {
                    Authorization: 'Bearer $HOOK_ALLOWED_TOKEN',
                    'X-Denied': '$HOOK_DENIED_TOKEN',
                  },
                  allowedEnvVars: ['HOOK_ALLOWED_TOKEN', 'HOOK_DENIED_TOKEN'],
                },
              ],
            },
          ],
        },
      }, {
        httpPolicy: { allowedEnvVars: ['HOOK_ALLOWED_TOKEN'] },
      })
      expect(await runHookEvent(registry, { event: 'SessionStart', sessionId: 's-http-env' }, {
        workspace: new Workspace(root),
      })).toEqual([
        { action: 'context', additionalContext: 'Bearer safe-tokenX-Injected: yes::' },
      ])
    })
  } finally {
    if (previousAllowed === undefined) delete process.env.HOOK_ALLOWED_TOKEN
    else process.env.HOOK_ALLOWED_TOKEN = previousAllowed
    if (previousDenied === undefined) delete process.env.HOOK_DENIED_TOKEN
    else process.env.HOOK_DENIED_TOKEN = previousDenied
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry http hook blocks private and metadata IP targets through SSRF guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-http-ssrf-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'http', url: 'http://169.254.169.254/latest/meta-data', timeout: 1 }] },
        ],
      },
    })
    const decisions = await runHookEvent(registry, { event: 'SessionStart', sessionId: 's-http-ssrf' }, {
      workspace: new Workspace(root),
    })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.action).toBe('context')
    expect(decisions[0]?.action === 'context' ? decisions[0].additionalContext : '').toContain('HTTP hook blocked: 169.254.169.254 resolves to 169.254.169.254')
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

test('normalizeHookRegistry agent hook runs a verifier agent and allows ok true structured output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-agent-ok-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          { hooks: [{ type: 'agent', prompt: 'verify final $ARGUMENTS' }] },
        ],
      },
    })
    const model = scriptedHookModel([
      { kind: 'tool_calls', text: 'return structured result', calls: [{ id: 'structured-1', name: 'StructuredOutput', input: { ok: true } }] },
      { kind: 'final', text: 'done' },
    ])
    const toolRegistry = new ToolRegistry([])
    const decisions = await runHookEvent(registry, { event: 'Stop', output: 'done' }, {
      workspace: new Workspace(root),
      conversationId: 'agent-hook-ok',
      model,
      registry: toolRegistry,
    })
    expect(decisions).toEqual([{ action: 'allow' }])
    expect(model.received[0]!.system).toContain('call StructuredOutput exactly once')
    expect(model.received[0]!.tools.map(tool => tool.name)).toEqual(['StructuredOutput'])
    expect(firstPromptText(model.received[0]!)).toContain('"hook_event_name":"Stop"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry agent hook maps ok false structured output to deny', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-agent-deny-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          { hooks: [{ type: 'agent', prompt: 'verify final' }] },
        ],
      },
    })
    const model = scriptedHookModel([
      { kind: 'tool_calls', calls: [{ id: 'structured-1', name: 'StructuredOutput', input: { ok: false, reason: 'missing verification' } }] },
      { kind: 'final', text: 'done' },
    ])
    const decisions = await runHookEvent(registry, { event: 'Stop', output: 'done' }, {
      workspace: new Workspace(root),
      model,
      registry: new ToolRegistry([]),
    })
    expect(decisions).toEqual([
      { action: 'deny', message: 'Agent hook condition was not met: missing verification' },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry agent hook can inspect with allowed tools before structured output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-agent-tool-'))
  try {
    writeFileSync(join(root, 'result.txt'), 'verified payload')
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          { hooks: [{ type: 'agent', prompt: 'verify file exists' }] },
        ],
      },
    })
    const model = scriptedHookModel([
      { kind: 'tool_calls', calls: [{ id: 'read-1', name: 'read_file', input: { path: 'result.txt' } }] },
      { kind: 'tool_calls', calls: [{ id: 'structured-1', name: 'StructuredOutput', input: { ok: true } }] },
      { kind: 'final', text: 'done' },
    ])
    const toolRegistry = new ToolRegistry([
      testTool('read_file', async input => {
        expect(input).toEqual({ path: 'result.txt' })
        return 'verified payload'
      }),
      testTool('write_file', async () => {
        throw new Error('write_file should not be available to agent hooks')
      }, false),
    ])
    const decisions = await runHookEvent(registry, { event: 'Stop', output: 'done' }, {
      workspace: new Workspace(root),
      model,
      registry: toolRegistry,
    })
    expect(decisions).toEqual([{ action: 'allow' }])
    expect(model.received[0]!.tools.map(tool => tool.name).sort()).toEqual(['StructuredOutput', 'read_file'])
    const feedback = model.received[1]!.messages.flatMap(message => message.content).find(block => block.type === 'tool_result')
    expect(feedback && feedback.type === 'tool_result' ? feedback.content : '').toContain('verified payload')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry agent hook returns non-blocking context when registry is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-agent-no-registry-'))
  try {
    const registry = normalizeHookRegistry({
      hooks: {
        Stop: [
          { hooks: [{ type: 'agent', prompt: 'verify final' }] },
        ],
      },
    })
    const model = hookModel({ kind: 'final', text: '{"ok":true}' })
    expect(await runHookEvent(registry, { event: 'Stop', output: 'done' }, {
      workspace: new Workspace(root),
      model,
    })).toEqual([
      { action: 'context', additionalContext: '[Stop agent hook 非阻塞错误] tool registry was unavailable' },
    ])
    expect(model.received).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizeHookRegistry:新增生命周期事件(PreCompact/PostCompact/SessionEnd/Notification/PostToolUseFailure)进白名单可派发', async () => {
  const registry = normalizeHookRegistry({
    hooks: {
      PreCompact: [{ hooks: [{ decision: { action: 'context', additionalContext: 'pre' } }] }],
      PostCompact: [{ hooks: [{ decision: { action: 'context', additionalContext: 'post' } }] }],
      SessionEnd: [{ hooks: [{ decision: { action: 'context', additionalContext: 'end' } }] }],
      Notification: [{ hooks: [{ decision: { action: 'context', additionalContext: 'notify' } }] }],
      PostToolUseFailure: [{ matcher: 'run_command', hooks: [{ decision: { action: 'context', additionalContext: 'fail' } }] }],
    },
  })
  const ctx = { workspace: new Workspace(mkdtempSync(join(tmpdir(), 'hook-config-lifecycle-'))) }
  expect(await runHookEvent(registry, { event: 'PreCompact', compactTrigger: 'auto' }, ctx)).toEqual([{ action: 'context', additionalContext: 'pre' }])
  expect(await runHookEvent(registry, { event: 'PostCompact', compactTrigger: 'auto', compactSummary: 's' }, ctx)).toEqual([{ action: 'context', additionalContext: 'post' }])
  expect(await runHookEvent(registry, { event: 'SessionEnd', sessionEndReason: 'clear' }, ctx)).toEqual([{ action: 'context', additionalContext: 'end' }])
  expect(await runHookEvent(registry, { event: 'Notification', notificationMessage: 'm' }, ctx)).toEqual([{ action: 'context', additionalContext: 'notify' }])
  expect(await runHookEvent(registry, { event: 'PostToolUseFailure', toolName: 'run_command', errorMessage: 'x' }, ctx)).toEqual([{ action: 'context', additionalContext: 'fail' }])
})

test('commandHookPayload:PreCompact/Notification/SessionEnd 载荷字段以 cc snake_case 送到命令 hook stdin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-config-payload-'))
  try {
    const out = join(root, 'payload.json')
    // hook 命令把 stdin 原样落盘,供断言字段名对齐 cc(trigger/compact_summary/message/notification_type/reason)。
    const cmd = `${process.execPath} -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').writeFileSync(process.argv[1],d))" ${JSON.stringify(out)}`
    const registry = normalizeHookRegistry({
      hooks: { PostCompact: [{ hooks: [{ type: 'command', command: cmd }] }] },
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'sess-x' }
    await runHookEvent(registry, { event: 'PostCompact', compactTrigger: 'manual', compactSummary: '摘要文本', sessionId: 'sess-x' }, ctx)
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
    expect(parsed.hook_event_name).toBe('PostCompact')
    expect(parsed.trigger).toBe('manual')
    expect(parsed.compact_summary).toBe('摘要文本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadPluginHookRegistry:插件 hooks.json 归一为 source:plugin 的注册表,能真触发', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-hooks-'))
  try {
    // cc 包裹结构:{ description, hooks: { <event>: [{matcher, hooks:[...]}] } }
    const fileA = join(root, 'a-hooks.json')
    writeFileSync(fileA, JSON.stringify({
      description: 'plugin A hooks',
      hooks: { PreToolUse: [{ matcher: 'write_file', hooks: [{ decision: { action: 'deny', message: 'A blocks write' } }] }] },
    }))
    // 裸事件映射也支持
    const fileB = join(root, 'b-hooks.json')
    writeFileSync(fileB, JSON.stringify({ SessionStart: [{ hooks: [{ decision: { action: 'context', additionalContext: 'B ctx' } }] }] }))

    const registry = await loadPluginHookRegistry([fileA, fileB, join(root, 'missing.json')])
    expect(registry).toBeTruthy()
    expect(registry!.rules.every(rule => rule.source === 'plugin')).toBe(true)

    const ctx = { workspace: new Workspace(root) }
    // 插件源 hook 即便工作区未受信也照跑(app 级可信,不过 workspace trust 闸)
    configureHookTrust({ interactive: true, isWorkspaceTrusted: () => false })
    expect(await runHookEvent(registry, { event: 'PreToolUse', toolName: 'write_file' }, ctx)).toEqual([{ action: 'deny', message: 'A blocks write' }])
    expect(await runHookEvent(registry, { event: 'SessionStart' }, ctx)).toEqual([{ action: 'context', additionalContext: 'B ctx' }])
  } finally {
    resetHookTrust()
    rmSync(root, { recursive: true, force: true })
  }
})

test('27 事件全集全部可声明(对齐 cc coreTypes.ts:25-53),一个不被静默吞', () => {
  const ALL_27 = [
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit',
    'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
    'PreCompact', 'PostCompact', 'PermissionRequest', 'PermissionDenied', 'Setup',
    'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult',
    'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded', 'CwdChanged', 'FileChanged',
  ]
  // 事件映射形式(cc settings.json hooks 结构):每个事件一条 command hook
  const eventMap = Object.fromEntries(ALL_27.map(event => [event, [{ hooks: [{ type: 'command', command: 'echo hi' }] }]]))
  const registry = normalizeHookRegistry({ hooks: eventMap })
  const declared = new Set(registry.rules.map(rule => rule.event))
  for (const event of ALL_27) expect(declared.has(event as never)).toBe(true)
  expect(registry.rules.length).toBe(27)
  // 未知事件仍被拒(防拼错静默生效)
  const bogus = normalizeHookRegistry({ hooks: { NotARealEvent: [{ hooks: [{ type: 'command', command: 'echo' }] }] } })
  expect(bogus.rules.length).toBe(0)
})

test('官方新增 3 事件(PostToolBatch/UserPromptExpansion/MessageDisplay)可声明,不被静默吞', () => {
  const registry = normalizeHookRegistry({
    hooks: {
      PostToolBatch: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      UserPromptExpansion: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      MessageDisplay: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  })
  expect(new Set(registry.rules.map(r => r.event))).toEqual(new Set(['PostToolBatch', 'UserPromptExpansion', 'MessageDisplay']))
})

test('command hook 官方通用输出字段:continue:false→halt / systemMessage 伴随 decision / suppressOutput 吞上下文兜底', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-universal-'))
  try {
    const ctx = { workspace: new Workspace(root), conversationId: 's1' }
    const nodeEcho = (json: string): string => `${process.execPath} -e "console.log(JSON.stringify(${json}))"`
    const run = async (json: string) => {
      const registry = normalizeHookRegistry({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: nodeEcho(json) }] }] },
      })
      return runHookEvent(registry, { event: 'Stop', sessionId: 's1' }, ctx as never)
    }
    // continue:false + stopReason → halt
    expect(await run(`{continue:false,stopReason:'预算用尽'}`)).toEqual([{ action: 'halt', reason: '预算用尽' }])
    // systemMessage 与 decision:block 并存 → [context ⚠️, deny]
    expect(await run(`{systemMessage:'注意风险',decision:'block',reason:'r1'}`)).toEqual([
      { action: 'context', additionalContext: '⚠️ 注意风险' },
      { action: 'deny', message: 'r1' },
    ])
    // suppressOutput:true 且无任何决策 → 什么都不产出(stdout 不再当上下文进 transcript)
    expect(await run(`{suppressOutput:true,debug:'内部日志'}`)).toEqual([])
    // 普通 JSON 数据(无任何契约字段)→ 维持旧行为:原文当上下文
    const plain = await run(`{foo:1}`)
    expect(plain).toEqual([{ action: 'context', additionalContext: '{"foo":1}' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveHookShell:非Windows恒默认shell;win32 Git Bash优先→PowerShell兜底;shell 字段可显式指定', async () => {
  const { resolveHookShell } = await import('./hookConfig')
  expect(resolveHookShell(undefined, 'darwin')).toBe(true)
  const noBash = () => false
  const hasBash = (p: string) => p.includes('Program Files\\Git')
  expect(resolveHookShell(undefined, 'win32', noBash)).toBe('powershell.exe')
  expect(resolveHookShell(undefined, 'win32', hasBash)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  expect(resolveHookShell('powershell', 'win32', hasBash)).toBe('powershell.exe')
  expect(resolveHookShell('bash', 'win32', noBash)).toBe('powershell.exe') // 指明bash但没装→仍退PowerShell
})

test('命令 hook 注入 CLAUDE_PROJECT_DIR;插件 hook 的 ${CLAUDE_PLUGIN_ROOT} 被替换并注入 env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hook-env-'))
  try {
    const ctx = { workspace: new Workspace(root), conversationId: 's1' }
    const echoEnv = `${process.execPath} -e "console.log(JSON.stringify({action:'context',additionalContext:process.env.CLAUDE_PROJECT_DIR+'|'+(process.env.CLAUDE_PLUGIN_ROOT||'')}))"`
    const plain = normalizeHookRegistry({ hooks: { Stop: [{ hooks: [{ type: 'command', command: echoEnv }] }] } })
    const d1 = await runHookEvent(plain, { event: 'Stop', sessionId: 's1' }, ctx as never)
    expect(d1).toEqual([{ action: 'context', additionalContext: `${root}|` }])

    const withPlugin = normalizeHookRegistry(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: echoEnv }] }] } },
      { source: 'plugin', pluginRoot: '/tmp/my-plugin' },
    )
    const d2 = await runHookEvent(withPlugin, { event: 'Stop', sessionId: 's1' }, ctx as never)
    expect(d2).toEqual([{ action: 'context', additionalContext: `${root}|/tmp/my-plugin` }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('async/asyncRewake:后台跑不阻塞派发;exit 2 时唤醒进【进程级 flat 队列】(不分会话,跨回合不丢,对齐 cc commandQueue)', async () => {
  const { drainAsyncHookWakes, clearAsyncHookWakes } = await import('./asyncHookRegistry')
  const root = mkdtempSync(join(tmpdir(), 'hook-async-'))
  clearAsyncHookWakes()
  try {
    const ctx = { workspace: new Workspace(root), conversationId: 'conv-async-1' }
    const rewake = normalizeHookRegistry({
      hooks: { Stop: [{ hooks: [{ type: 'command', asyncRewake: true, command: `${process.execPath} -e "console.error('磁盘快满了');process.exit(2)"` }] }] },
    })
    const t0 = Date.now()
    const decisions = await runHookEvent(rewake, { event: 'Stop', sessionId: 'conv-async-1' }, ctx as never)
    expect(decisions).toEqual([]) // 不等子进程、无决策
    expect(Date.now() - t0).toBeLessThan(1500)
    // 关键回归:唤醒消息进的是进程级队列(按 conversationId),不随回合销毁——回合结束后仍能 drain 到。
    let drained: string[] = []
    for (let i = 0; i < 50 && drained.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100))
      drained = drainAsyncHookWakes()
    }
    expect(drained.length).toBe(1)
    expect(drained[0]).toContain('磁盘快满了')
    expect(drained[0]).toContain('后台 hook Stop 唤醒')
    // drain 后清空
    expect(drainAsyncHookWakes()).toEqual([])

    // async(非 rewake):exit 2 也不入队
    clearAsyncHookWakes()
    const silent = normalizeHookRegistry({
      hooks: { Stop: [{ hooks: [{ type: 'command', async: true, command: `${process.execPath} -e "process.exit(2)"` }] }] },
    })
    const d2 = await runHookEvent(silent, { event: 'Stop', sessionId: 'conv-async-2' }, { workspace: new Workspace(root), conversationId: 'conv-async-2' } as never)
    expect(d2).toEqual([])
    await new Promise(r => setTimeout(r, 400))
    expect(drainAsyncHookWakes()).toEqual([])
  } finally {
    clearAsyncHookWakes()
    rmSync(root, { recursive: true, force: true })
  }
})
