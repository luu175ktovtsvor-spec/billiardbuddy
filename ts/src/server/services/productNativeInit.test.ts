import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { createProductAgentHarness } from '../agent-worker/productAgentHarness.js'
import type { ProductHarnessLifecycleHookHost } from '../agent-worker/productLifecycleHooks.js'
import type { ProductCommand, ProductTool, ProductToolContext } from '../agent-worker/productTool.js'
import type { ProductMcpConnection } from '../agent-worker/productMcpClient.js'
import { createPolicyBoundEnvelope } from '../product/permissionExecutionEnvelope.js'
import { productPermissionSnapshot } from '../../../shared/product/domain.js'

const roots: string[] = []
const emptyExtensionSnapshot = {
  type: 'event',
  event: 'extension_snapshot',
  digest: 'c7df84b5244d7e8cd71a1dcf53b1c40d13866c36d9fcae3234ee1aa3e5b5ef4a',
  tool_count: 0,
  command_count: 0,
  mcp_server_count: 0,
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

function lifecycleHooks(overrides: Partial<ProductHarnessLifecycleHookHost> = {}): ProductHarnessLifecycleHookHost {
  return {
    sessionStart: async () => ({}),
    userPrompt: async () => ({}),
    preTool: async () => ({}),
    postTool: async () => ({}),
    preCompact: async () => ({}),
    postCompact: async () => undefined,
    stop: async () => ({}),
    ...overrides,
  }
}

test('native ProductTask /init is local, idempotent, and terminal without model execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-init-')); roots.push(root)
  const project = path.join(root, 'project'); await fs.mkdir(project)
  const auto_memory = { storage_dir: path.join(root, 'auto-memory'), work_dir: project, enabled: true, task_id: 'task', entry_id: 'entry' }
  const hostedWorkDirs: string[] = []
  const mcp_host = { connect: async (workDir: string) => {
    hostedWorkDirs.push(workDir)
    return { clients: [], tools: [], commands: [], resources: {} }
  } }

  const run = async (run_id: string) => {
    const events: unknown[] = []
    const port = await createProductAgentHarness({ run_id, session_id: `session-${run_id}`, work_dir: project, permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')), mcp_host, auto_memory })
    port.subscribe(message => events.push(message))
    await port.input('/init')
    return events
  }

  expect(await run('first')).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'delta', data: '项目已初始化。' },
    { type: 'terminal', state: 'completed', run_id: 'first' },
  ])
  const firstInstruction = await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')
  expect(await run('second')).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'delta', data: '项目已经初始化，无需更改。' },
    { type: 'terminal', state: 'completed', run_id: 'second' },
  ])
  expect(await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')).toBe(firstInstruction)
  expect(hostedWorkDirs).toEqual([])
})

test('native ProductTask Core passes hosted MCP clients, tools, and commands into the query loop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-mcp-')); roots.push(root)
  const client = { name: 'host', type: 'connected', config: { type: 'stdio', command: 'host', scope: 'project' } } as ProductMcpConnection
  const tool = { name: 'mcp__host__read' } as ProductTool
  const command = { name: 'mcp__host__prompt' } as ProductCommand
  let queryInput: Record<string, unknown> | undefined
  const query = (async function* (value: Record<string, unknown>) {
    queryInput = value
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'mcp-run',
    session_id: 'mcp-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    mcp_host: { connect: async () => ({ clients: [client], tools: [tool], commands: [command], resources: {} }) },
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })

  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('使用连接')
  expect(events).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'extension_snapshot', digest: 'a78d93722e6aea08f34d2e76cc23fafe5baeeaa697657d4e6769917c59e38957', tool_count: 1, command_count: 1, mcp_server_count: 1 },
    { type: 'terminal', state: 'completed', run_id: 'mcp-run' },
  ])
  const toolUseContext = queryInput?.toolUseContext as ProductToolContext | undefined
  expect(toolUseContext?.options.tools).toContain(tool)
  expect(queryInput?.tools).toContain(tool)
  expect(queryInput?.commands).toContain(command)
})

test('native ProductTask Harness runs lifecycle Hooks and continues when Stop blocks completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-hooks-')); roots.push(root)
  const calls: Record<string, unknown>[] = []
  let stopCalls = 0
  const port = await createProductAgentHarness({
    run_id: 'hook-run',
    session_id: 'hook-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    lifecycle_hooks: lifecycleHooks({
      sessionStart: async input => {
        expect(input.source).toBe('startup')
        return { additionalContext: 'SessionStart 提供的项目事实' }
      },
      userPrompt: async input => {
        expect(input.prompt).toBe('执行 Hook 旅程')
        return { additionalContext: 'UserPromptSubmit 提供的约束' }
      },
      stop: async () => {
        stopCalls += 1
        return stopCalls === 1 ? { blocked: true, reason: '必须先核验真实结果' } : {}
      },
    }),
    query: (async function* (value: Record<string, unknown>) {
      calls.push(value)
      yield { type: 'result', subtype: 'success', is_error: false, result: calls.length === 1 ? '过早完成' : '核验后完成' }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('执行 Hook 旅程')

  expect(calls).toHaveLength(2)
  expect((calls[0]!.promptContext as { hookInstructions: string }).hookInstructions).toContain('SessionStart 提供的项目事实')
  expect((calls[0]!.promptContext as { hookInstructions: string }).hookInstructions).toContain('UserPromptSubmit 提供的约束')
  expect(String(calls[1]!.prompt)).toContain('必须先核验真实结果')
  expect(events.at(-1)).toEqual({ type: 'terminal', state: 'completed', run_id: 'hook-run' })
})

test('native ProductTask Harness executes the frozen BilliardBuddy project Hook in the production path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-project-hook-')); roots.push(root)
  const project = path.join(root, 'project')
  await fs.mkdir(path.join(project, '.BilliardBuddy'), { recursive: true })
  await fs.writeFile(path.join(project, '.BilliardBuddy', 'settings.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"BB_PRODUCT_HOOK"}}'`,
        }],
      }],
    },
  }))
  const calls: Record<string, unknown>[] = []
  const query = (async function* (value: Record<string, unknown>) {
    calls.push(value)
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'project-hook-run',
    session_id: 'project-hook-session',
    work_dir: project,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })

  await port.input('遵守项目 Hook')

  expect(calls).toHaveLength(1)
  expect((calls[0]!.promptContext as { hookInstructions: string }).hookInstructions).toBe('BB_PRODUCT_HOOK')
})

test('native ProductTask Harness contains a blocking prompt Hook without leaking its output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-hook-block-')); roots.push(root)
  let queried = false
  const port = await createProductAgentHarness({
    run_id: 'hook-block-run',
    session_id: 'hook-block-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    lifecycle_hooks: lifecycleHooks({
      userPrompt: async () => ({ blocked: true, reason: 'private hook command /Users/private/secret.sh' }),
    }),
    query: (async function* () { queried = true }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('应被阻止')

  expect(queried).toBeFalse()
  expect(events).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'delta', data: '项目 Hook 已阻止本次请求。请检查项目自动化规则后重试。' },
    { type: 'terminal', state: 'completed', run_id: 'hook-block-run' },
  ])
  expect(JSON.stringify(events)).not.toContain('/Users/private')
})

test('native ProductTask Harness applies PreCompact and PostCompact Hooks to durable compaction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-compact-hooks-')); roots.push(root)
  const prompts: string[] = []
  const completed: string[] = []
  const port = await createProductAgentHarness({
    run_id: 'compact-hook-run',
    session_id: 'compact-hook-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    session_context: { text: '需要压缩的历史事实', event_sequence: 4, estimated_tokens: 10, compact_generation: 0 },
    lifecycle_hooks: lifecycleHooks({
      preCompact: async ({ trigger }) => ({ instructions: `保留验收编号，触发方式 ${trigger}` }),
      postCompact: async ({ trigger, summary }) => { completed.push(`${trigger}:${summary}`) },
    }),
    query: (async function* (value: Record<string, unknown>) {
      prompts.push(String(value.prompt))
      yield { type: 'result', subtype: 'success', is_error: false, result: '包含验收编号 BB-HOOK-1' }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  await port.input('/compact')

  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('保留验收编号，触发方式 manual')
  expect(completed).toEqual(['manual:包含验收编号 BB-HOOK-1'])
})

test('native ProductTask Harness resumes private structured tool context across Turns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-session-')); roots.push(root)
  const binding = {
    storage_dir: path.join(root, 'harness-sessions'),
    binding_id: 'resume-binding',
    lineage_id: 'lineage-main',
  }
  const firstQuery = (async function* (value: Record<string, unknown>) {
    const persist = value.onMessageState as (messages: readonly unknown[]) => Promise<void>
    await persist([
      { type: 'user', uuid: 'user-1', timestamp: '2026-07-26T00:00:00.000Z', message: { role: 'user', content: '检查配置' } },
      { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-07-26T00:00:01.000Z', message: { id: 'assistant-response-1', role: 'assistant', content: [{ type: 'tool_call', id: 'tool-1', name: 'Read', arguments: { file_path: 'config.json' } }], model: 'test-model', stop_reason: 'tool_call', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'user', uuid: 'result-1', timestamp: '2026-07-26T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'tool-1', content: '配置有效' }] } },
    ])
    yield { type: 'result', subtype: 'success', is_error: false, result: '第一轮完成' }
  }) as never
  const first = await createProductAgentHarness({
    run_id: 'session-run-1',
    session_id: 'private-1',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    session_context: { text: '<user>更早的目标</user>', event_sequence: 4, estimated_tokens: 4, compact_generation: 0 },
    harness_session: binding,
    query: firstQuery,
    load_commands: async () => [],
    load_tools: () => [],
  })
  await first.input('检查配置')

  let resumedInput: Record<string, unknown> | undefined
  const second = await createProductAgentHarness({
    run_id: 'session-run-2',
    session_id: 'private-2',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    session_context: { text: '<user>不应替换已经持久化的结构化上下文</user>', event_sequence: 9, estimated_tokens: 8, compact_generation: 0 },
    harness_session: binding,
    query: (async function* (value: Record<string, unknown>) {
      resumedInput = value
      yield { type: 'result', subtype: 'success', is_error: false, result: '第二轮完成' }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  await second.input('继续')

  expect(resumedInput?.mutableMessages).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'assistant', uuid: 'assistant-1' }),
    expect.objectContaining({ type: 'user', uuid: 'result-1' }),
  ]))
  expect((resumedInput?.promptContext as { sessionSummary: string }).sessionSummary).toBe('<user>更早的目标</user>')
})

test('native ProductTask recovery keeps the original instruction snapshot for the same Turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-instruction-recovery-')); roots.push(root)
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'same turn alpha instruction')
  const binding = { storage_dir: path.join(root, 'sessions'), binding_id: 'binding', lineage_id: 'lineage' }
  const first = await createProductAgentHarness({
    run_id: 'same-run',
    session_id: 'first-process',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    harness_session: binding,
    query: (async function* (value: Record<string, unknown>) {
      await (value.onMessageState as (messages: readonly unknown[]) => Promise<void>)([
        { type: 'user', uuid: 'user-1', timestamp: '2026-07-26T00:00:00.000Z', message: { role: 'user', content: '开始' } },
      ])
      throw new Error('simulated process loss')
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  await first.input('开始')
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'same turn beta instruction')

  let resumed: Record<string, unknown> | undefined
  const recovery = await createProductAgentHarness({
    run_id: 'same-run',
    session_id: 'replacement-process',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    harness_session: binding,
    query: (async function* (value: Record<string, unknown>) {
      resumed = value
      yield { type: 'result', subtype: 'success', is_error: false, result: '恢复完成' }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  await recovery.input('恢复')

  const projectInstructions = (resumed?.promptContext as { projectInstructions: string }).projectInstructions
  expect(projectInstructions).toContain('same turn alpha instruction')
  expect(projectInstructions).not.toContain('same turn beta instruction')
})

test('native ProductTask compacts large private tool context before it can overflow the model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-private-compact-')); roots.push(root)
  const binding = { storage_dir: path.join(root, 'sessions'), binding_id: 'binding', lineage_id: 'lineage' }
  const first = await createProductAgentHarness({
    run_id: 'private-context-1',
    session_id: 'private-context-1',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    harness_session: binding,
    query: (async function* (value: Record<string, unknown>) {
      await (value.onMessageState as (messages: readonly unknown[]) => Promise<void>)([
        { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-07-26T00:00:00.000Z', message: { id: 'assistant-response-1', role: 'assistant', content: [{ type: 'tool_call', id: 'tool-1', name: 'Read', arguments: { file_path: 'large.txt' } }], model: 'test-model', stop_reason: 'tool_call', usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'user', uuid: 'result-1', timestamp: '2026-07-26T00:00:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'tool-1', content: 'x'.repeat(60_000) }] } },
      ])
      yield { type: 'result', subtype: 'success', is_error: false, result: '第一轮完成' }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  await first.input('读取大文件')

  const summaries: string[] = []
  let normalTurn: Record<string, unknown> | undefined
  const second = await createProductAgentHarness({
    run_id: 'private-context-2',
    session_id: 'private-context-2',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    harness_session: binding,
    session_context: { text: '短公开上下文', event_sequence: 3, estimated_tokens: 3, compact_generation: 0 },
    query: (async function* (value: Record<string, unknown>) {
      const prompt = String(value.prompt)
      if (prompt.includes('压缩为可供后续模型')) {
        summaries.push(prompt)
        yield { type: 'result', subtype: 'success', is_error: false, result: '工具读取了大文件，后续只需保留结论。' }
      } else {
        normalTurn = value
        yield { type: 'result', subtype: 'success', is_error: false, result: '第二轮完成' }
      }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  second.subscribe(message => events.push(message))
  await second.input('继续')

  expect(summaries.length).toBeGreaterThan(0)
  expect(summaries.some(prompt => prompt.includes('structured_tool_context'))).toBeTrue()
  expect(normalTurn?.mutableMessages).toEqual([])
  expect((normalTurn?.promptContext as { sessionSummary: string }).sessionSummary).toContain('工具读取了大文件')
  expect(events).toContainEqual(expect.objectContaining({ event: 'context_compaction', phase: 'started', source: 'automatic' }))
})

test('native ProductTask compacts authoritative context before the next model turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-compact-')); roots.push(root)
  const calls: Record<string, unknown>[] = []
  const query = (async function* (value: Record<string, unknown>) {
    calls.push(value)
    const prompt = String(value.prompt)
    yield { type: 'result', subtype: 'success', is_error: false, result: prompt.includes('压缩为可供后续模型') ? '保留后的上下文摘要' : '本轮完成' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'compact-run',
    session_id: 'compact-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    session_context: { text: '历史事实'.repeat(8_000), event_sequence: 41, estimated_tokens: 12_000, compact_generation: 2 },
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('继续执行')

  expect(calls).toHaveLength(3)
  expect(calls.slice(0, 2).every(call => (call.tools as unknown[]).length === 0)).toBeTrue()
  expect((calls[2]!.promptContext as { sessionSummary: string }).sessionSummary).toContain('保留后的上下文摘要')
  expect(events).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'context_compaction', phase: 'started', source: 'automatic', generation: 3, input_tokens: 12_000 },
    { type: 'event', event: 'context_compaction', phase: 'completed', source: 'automatic', generation: 3, input_tokens: 12_000, output_tokens: 5, summary: '保留后的上下文摘要\n\n保留后的上下文摘要', compacted_through_event_sequence: 41 },
    emptyExtensionSnapshot,
    { type: 'terminal', state: 'completed', run_id: 'compact-run' },
  ])
})

test('native ProductTask /compact performs a manual durable compaction without running a normal turn', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-manual-compact-')); roots.push(root)
  const prompts: string[] = []
  const query = (async function* (value: Record<string, unknown>) {
    prompts.push(String(value.prompt))
    yield { type: 'result', subtype: 'success', is_error: false, result: '手动压缩摘要' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'manual-compact-run',
    session_id: 'manual-compact-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    session_context: { text: '<user>历史任务</user>', event_sequence: 8, estimated_tokens: 5, compact_generation: 0 },
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('/compact')
  expect(prompts).toHaveLength(1)
  expect(events).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'context_compaction', phase: 'started', source: 'manual', generation: 1, input_tokens: 5 },
    { type: 'event', event: 'context_compaction', phase: 'completed', source: 'manual', generation: 1, input_tokens: 5, output_tokens: 2, summary: '手动压缩摘要', compacted_through_event_sequence: 8 },
    { type: 'event', event: 'delta', data: '上下文已压缩。' },
    { type: 'terminal', state: 'completed', run_id: 'manual-compact-run' },
  ])
})

test('native ProductTask Harness projects a verifiable tool class without private payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-activity-')); roots.push(root)
  const query = (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'tool_call', id: 'private-tool-id', name: 'Read', arguments: { path: '/private/secret' } }] } }
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_call_id: 'private-tool-id', content: 'PRIVATE_RESULT', is_error: false }] } }
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'activity-run',
    session_id: 'activity-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('读取资料')
  const id = `activity_${createHash('sha256').update('activity-run:private-tool-id').digest('hex').slice(0, 32)}`
  expect(events).toEqual([
    { type: 'event', event: 'started' },
    emptyExtensionSnapshot,
    { type: 'event', event: 'activity', activity: { id, kind: 'file_read', phase: 'started', summary: '正在读取工作区内容' } },
    { type: 'event', event: 'activity', activity: { id, kind: 'file_read', phase: 'completed', summary: '已读取工作区内容' } },
    { type: 'terminal', state: 'completed', run_id: 'activity-run' },
  ])
  expect(JSON.stringify(events)).not.toContain('private-tool-id')
  expect(JSON.stringify(events)).not.toContain('/private/secret')
  expect(JSON.stringify(events)).not.toContain('PRIVATE_RESULT')
})

test('native ProductTask Harness projects child-loop tools beneath their Subtask activity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-child-activity-')); roots.push(root)
  const query = (async function* (value: Record<string, unknown>) {
    yield { type: 'assistant', message: { content: [{ type: 'tool_call', id: 'private-parent-id', name: 'Subtask', arguments: { description: '检查文件' } }] } }
    const context = value.toolUseContext as {
      onProductHarnessMessage?: (message: unknown, parentToolUseId?: string) => void
    }
    context.onProductHarnessMessage?.(
      { type: 'assistant', message: { content: [{ type: 'tool_call', id: 'private-child-id', name: 'Read', arguments: { path: '/private/child' } }] } },
      'private-parent-id',
    )
    context.onProductHarnessMessage?.(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_call_id: 'private-child-id', content: 'PRIVATE_CHILD_RESULT' }] } },
      'private-parent-id',
    )
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_call_id: 'private-parent-id', content: 'PRIVATE_PARENT_RESULT' }] } }
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'child-activity-run',
    session_id: 'child-activity-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))
  await port.input('并行检查')

  const parentId = `activity_${createHash('sha256').update('child-activity-run:private-parent-id').digest('hex').slice(0, 32)}`
  const childId = `activity_${createHash('sha256').update('child-activity-run:private-child-id').digest('hex').slice(0, 32)}`
  expect(events).toContainEqual({
    type: 'event', event: 'activity',
    activity: { id: parentId, kind: 'subtask', phase: 'started', summary: '正在协同处理事项' },
  })
  expect(events).toContainEqual({
    type: 'event', event: 'activity',
    activity: { id: childId, parentId, kind: 'file_read', phase: 'started', summary: '正在读取工作区内容' },
  })
  expect(events).toContainEqual({
    type: 'event', event: 'activity',
    activity: { id: childId, parentId, kind: 'file_read', phase: 'completed', summary: '已读取工作区内容' },
  })
  expect(JSON.stringify(events)).not.toContain('private-parent-id')
  expect(JSON.stringify(events)).not.toContain('private-child-id')
  expect(JSON.stringify(events)).not.toContain('PRIVATE_CHILD_RESULT')
})

test('native ProductTask Harness pauses for a structured question and resumes with server-built answers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-question-')); roots.push(root)
  let decision: unknown
  let questionReady!: () => void
  const ready = new Promise<void>(resolve => { questionReady = resolve })
  const port = await createProductAgentHarness({
    run_id: 'question-run',
    session_id: 'question-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    query: (async function* (value: Record<string, unknown>) {
      const canUseTool = value.canUseTool as (...args: unknown[]) => Promise<unknown>
      decision = await canUseTool(
        { name: 'AskUserQuestion' },
        { questions: [{ question: '选择方案', options: [{ label: '方案 A' }, { label: '方案 B' }] }] },
        {},
        {},
        'question-1',
        { behavior: 'ask' },
      )
      yield { type: 'result', subtype: 'success', is_error: false, result: '已按回答继续' }
    }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => {
    events.push(message)
    if (message.type === 'event' && message.event === 'question') questionReady()
  })
  const running = port.input('需要选择')
  await ready
  await port.answer('question-1', ['方案 A'])
  await running

  expect(events).toContainEqual({
    type: 'event',
    event: 'question',
    request_id: 'question-1',
    questions: [{ question: '选择方案', options: [{ label: '方案 A' }, { label: '方案 B' }] }],
  })
  expect(decision).toMatchObject({
    behavior: 'allow',
    updatedInput: { answers: { 选择方案: '方案 A' } },
  })
})

test('native ProductTask automatic review allows workspace edits without widening the sandbox', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-permission-')); roots.push(root)
  let queryInput: Record<string, unknown> | undefined
  const query = (async function* (value: Record<string, unknown>) {
    queryInput = value
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createProductAgentHarness({
    run_id: 'permission-run',
    session_id: 'permission-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('approve_for_me')),
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })

  await port.input('在工作区内写入结果')
  const toolUseContext = queryInput?.toolUseContext as ProductToolContext | undefined
  expect(toolUseContext?.permissionContext).toMatchObject({
    mode: 'acceptEdits',
    isBypassPermissionsModeAvailable: false,
  })
})

test('native ProductTask Core never enters the query loop after stop wins an MCP connection race', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-mcp-stop-')); roots.push(root)
  let releaseHost!: () => void
  let hostStarted!: () => void
  const heldHost = new Promise<void>(resolve => { releaseHost = resolve })
  const hostIsConnecting = new Promise<void>(resolve => { hostStarted = resolve })
  let queryCalled = false
  const port = await createProductAgentHarness({
    run_id: 'stopped-mcp-run',
    session_id: 'stopped-mcp-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')),
    mcp_host: { connect: async () => {
      hostStarted()
      await heldHost
      return { clients: [], tools: [], commands: [], resources: {} }
    } },
    query: (async function* () { queryCalled = true }) as never,
    load_commands: async () => [],
    load_tools: () => [],
  })
  const events: unknown[] = []
  port.subscribe(message => events.push(message))

  const running = port.input('连接后执行')
  await hostIsConnecting
  await port.stop()
  releaseHost()
  await running

  expect(queryCalled).toBeFalse()
  expect(events).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'stopping' },
    { type: 'terminal', state: 'stopped', run_id: 'stopped-mcp-run' },
  ])
})
