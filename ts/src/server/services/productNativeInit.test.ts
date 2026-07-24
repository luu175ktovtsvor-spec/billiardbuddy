import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServerPrivateNativeCorePort } from '../../cli/print.js'
import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { createPolicyBoundEnvelope } from '../product/permissionExecutionEnvelope.js'
import { productPermissionSnapshot } from '../../../shared/product/domain.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

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
    const port = await createServerPrivateNativeCorePort({ run_id, session_id: `session-${run_id}`, work_dir: project, permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval')), mcp_host, auto_memory })
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
  const client = { name: 'host', type: 'connected' } as MCPServerConnection
  const tool = { name: 'mcp__host__read' } as Tool
  const command = { name: 'mcp__host__prompt' } as Command
  let queryInput: Record<string, unknown> | undefined
  const query = (async function* (value: Record<string, unknown>) {
    queryInput = value
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createServerPrivateNativeCorePort({
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
    { type: 'terminal', state: 'completed', run_id: 'mcp-run' },
  ])
  expect(queryInput?.mcpClients).toEqual([client])
  expect(queryInput?.tools).toContain(tool)
  expect(queryInput?.commands).toContain(command)
})

test('native ProductTask automatic review allows workspace edits without widening the sandbox', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-permission-')); roots.push(root)
  let queryInput: Record<string, unknown> | undefined
  const query = (async function* (value: Record<string, unknown>) {
    queryInput = value
    yield { type: 'result', subtype: 'success', is_error: false, result: '完成' }
  }) as never
  const port = await createServerPrivateNativeCorePort({
    run_id: 'permission-run',
    session_id: 'permission-session',
    work_dir: root,
    permission_envelope: createPolicyBoundEnvelope(productPermissionSnapshot('approve_for_me')),
    query,
    load_commands: async () => [],
    load_tools: () => [],
  })

  await port.input('在工作区内写入结果')
  const getAppState = queryInput?.getAppState as (() => { toolPermissionContext: { mode: string; isBypassPermissionsModeAvailable: boolean } }) | undefined
  expect(getAppState?.().toolPermissionContext).toMatchObject({
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
  const port = await createServerPrivateNativeCorePort({
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
