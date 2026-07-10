import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { Workspace } from '../workspace/workspace'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { closeMcpConnections, connectMcpServers, createTransport } from './client'

function writeFixtureServer(root: string): string {
  const file = join(root, 'fixture-mcp-server.ts')
  writeFileSync(file, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import { z } from 'zod'

const taskStore = new InMemoryTaskStore()
const server = new McpServer({ name: 'fixture', version: '1.0.0' }, {
  capabilities: { tasks: { requests: { tools: { call: {} } } } },
  taskStore,
  taskMessageQueue: new InMemoryTaskMessageQueue(),
})
server.registerTool('echo', {
  description: 'Echo text through MCP',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: 'text', text: 'echo:' + text }],
}))

server.registerTool('ask_defaults', {
  description: 'Ask the client for non-sensitive defaults',
  inputSchema: {},
}, async () => {
  const result = await server.server.elicitInput({
    mode: 'form',
    message: 'Pick store defaults',
    requestedSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', default: 'Shanghai' },
        visits: { type: 'integer', default: 2 },
      },
      required: ['city', 'visits'],
    },
  })
  return { content: [{ type: 'text', text: 'elicit:' + result.action + ':' + JSON.stringify(result.content ?? {}) }] }
})

server.registerTool('sample_summary', {
  description: 'Ask the client model to summarize text',
  inputSchema: { text: z.string() },
}, async ({ text }) => {
  const result = await server.server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: 'summarize:' + text } }],
    maxTokens: 64,
  })
  return { content: [{ type: 'text', text: result.content.type === 'text' ? result.content.text : 'non-text' }] }
})

server.experimental.tasks.registerToolTask('delay_echo', {
  description: 'Task-based echo',
  inputSchema: { text: z.string() },
  execution: { taskSupport: 'required' },
}, {
  async createTask({ text }, { taskStore, taskRequestedTtl }) {
    const task = await taskStore.createTask({ ttl: taskRequestedTtl, pollInterval: 10 })
    setTimeout(() => {
      void taskStore.storeTaskResult(task.taskId, 'completed', {
        content: [{ type: 'text', text: 'task:' + text }],
      })
    }, 5)
    return { task }
  },
  async getTask(_args, { taskId, taskStore }) {
    return await taskStore.getTask(taskId)
  },
  async getTaskResult(_args, { taskId, taskStore }) {
    return await taskStore.getTaskResult(taskId)
  },
})

server.registerResource('store-profile', 'store://profile', {
  description: 'Store profile resource',
  mimeType: 'text/plain',
}, async uri => ({
  contents: [{ uri: uri.href, text: 'profile:vip-room', mimeType: 'text/plain' }],
}))

server.registerPrompt('daily', {
  description: 'Write daily summary',
  argsSchema: { topic: z.string() },
}, async ({ topic }) => ({
  description: 'Daily prompt',
  messages: [{ role: 'user', content: { type: 'text', text: 'daily:' + topic } }],
}))

await server.connect(new StdioServerTransport())
`)
  return file
}

test('createTransport:type:sse 走 SSEClientTransport,http 走 Streamable,stdio 走 Stdio(传输路由对齐 cc)', () => {
  // type:'sse' 之前被误当 streamable http;现在正确路由到旧式 SSE 传输(长连 + POST 回发)。
  const sse = createTransport({ name: 'x', transport: 'sse', url: 'https://example.test/sse', headers: { Authorization: 'Bearer t' } }, {})
  expect(sse).toBeInstanceOf(SSEClientTransport)
  const http = createTransport({ name: 'x', transport: 'http', url: 'https://example.test/mcp' }, {})
  expect(http).toBeInstanceOf(StreamableHTTPClientTransport)
  const stdio = createTransport({ name: 'x', transport: 'stdio', command: 'node', args: [] }, {})
  expect(stdio).toBeInstanceOf(StdioClientTransport)
})

test('connectMcpServers connects stdio server, exposes tools, and calls through JSON-RPC', async () => {
  const root = mkdtempSync(join(process.cwd(), '.mcp-client-'))
  const fixture = writeFixtureServer(root)
  const sampledPrompts: string[] = []
  const loaded = await connectMcpServers([{
    name: 'local fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
  }], {
    cwd: process.cwd(),
    timeoutMs: 5000,
    samplingHandler: async ({ params }) => {
      sampledPrompts.push(JSON.stringify(params.messages))
      return { model: 'fixture-sampler', role: 'assistant', content: { type: 'text', text: 'sampled summary' }, stopReason: 'endTurn' }
    },
  })

  try {
    expect(loaded.warnings).toEqual([])
    expect(loaded.tools.map(t => t.name)).toContain('mcp__local_fixture__echo')
    const echo = loaded.tools.find(t => t.name === 'mcp__local_fixture__echo')!
    expect(echo.isReadOnly).toBe(true)
    const out = await echo.execute({ text: 'hello' }, { workspace: new Workspace(root) })
    expect(out).toContain('<mcp_result server="local fixture" tool="echo">')
    expect(out).toContain('echo:hello')

    const askDefaults = loaded.tools.find(t => t.name === 'mcp__local_fixture__ask_defaults')!
    const defaults = await askDefaults.execute({}, { workspace: new Workspace(root) })
    expect(defaults).toContain('elicit:accept')
    expect(defaults).toContain('"city":"Shanghai"')
    expect(defaults).toContain('"visits":2')

    const sampleSummary = loaded.tools.find(t => t.name === 'mcp__local_fixture__sample_summary')!
    const sample = await sampleSummary.execute({ text: 'league night' }, { workspace: new Workspace(root) })
    expect(sample).toContain('sampled summary')
    expect(sampledPrompts.join('\\n')).toContain('summarize:league night')

    const delayEcho = loaded.tools.find(t => t.name === 'mcp__local_fixture__delay_echo')!
    const taskOut = await delayEcho.execute({ text: 'slow hello' }, { workspace: new Workspace(root) })
    expect(taskOut).toContain('<mcp_task_trace server="local fixture" tool="delay_echo">')
    expect(taskOut).toContain('event="created"')
    expect(taskOut).toContain('task:slow hello')

    const listResources = loaded.tools.find(t => t.name === 'list_mcp_resources')!
    const readResource = loaded.tools.find(t => t.name === 'read_mcp_resource')!
    const resources = await listResources.execute({}, { workspace: new Workspace(root) })
    expect(resources).toContain('store://profile')
    const profile = await readResource.execute({ uri: 'store://profile' }, { workspace: new Workspace(root) })
    expect(profile).toContain('<mcp_resource_result server="local fixture" uri="store://profile">')
    expect(profile).toContain('profile:vip-room')

    const listPrompts = loaded.tools.find(t => t.name === 'list_mcp_prompts')!
    const readPrompt = loaded.tools.find(t => t.name === 'read_mcp_prompt')!
    const prompts = await listPrompts.execute({}, { workspace: new Workspace(root) })
    expect(prompts).toContain('name=daily')
    const prompt = await readPrompt.execute({ name: 'daily', arguments: { topic: '周报' } }, { workspace: new Workspace(root) })
    expect(prompt).toContain('<mcp_prompt server="local fixture" name="daily" description="Daily prompt">')
    expect(prompt).toContain('daily:周报')
  } finally {
    await closeMcpConnections(loaded.connections)
    rmSync(root, { recursive: true, force: true })
  }
})

test('initialize 声明的 capabilities.elicitation 必须是精确空对象 {}(兼容修复:发 form/url 嵌套形状会打回零字段 Elicitation 的 Java/Spring MCP 服务器)', async () => {
  let capturedCapabilities: Record<string, unknown> | undefined

  const mcpServer = new McpServer({ name: 'cap-fixture', version: '1.0.0' })
  mcpServer.registerTool('noop', { description: 'no-op', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }))
  const serverTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
  await mcpServer.connect(serverTransport)

  const httpServer = Bun.serve({
    port: 0,
    async fetch(req) {
      // 截获 initialize 请求体,读取客户端真正发到线上的 capabilities(clone 不消耗原始 body)。
      if (req.method === 'POST' && capturedCapabilities === undefined) {
        try {
          const body = (await req.clone().json()) as unknown
          const msgs = Array.isArray(body) ? body : [body]
          for (const m of msgs) {
            if (m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize') {
              capturedCapabilities = (m as { params?: { capabilities?: Record<string, unknown> } }).params?.capabilities
            }
          }
        } catch {
          // 非 JSON(如 SSE GET)忽略
        }
      }
      return serverTransport.handleRequest(req)
    },
  })

  try {
    const loaded = await connectMcpServers([{
      name: 'cap fixture',
      transport: 'http',
      url: `http://127.0.0.1:${httpServer.port}/mcp`,
    }], { timeoutMs: 5000 })

    expect(loaded.warnings).toEqual([])
    expect(capturedCapabilities).toBeDefined()
    // 关键兼容断言:elicitation 精确为空对象,绝不带 form/url 嵌套键。
    expect(capturedCapabilities!.elicitation).toEqual({})
    expect(Object.keys(capturedCapabilities!.elicitation as object)).toEqual([])
    // 回归护栏:tasks 能力仍照常声明(top-level 未知字段被老服务器忽略,不打回,故不降)。
    expect(capturedCapabilities!.tasks).toBeDefined()

    await closeMcpConnections(loaded.connections)
  } finally {
    httpServer.stop(true)
    await serverTransport.close()
  }
})

test('connectMcpServers 把 http server 配置里的 headers(含 Authorization bearer)真的发到远程请求上(鉴权对齐 cc)', async () => {
  const seenHeaders: Array<{ authorization: string | null; apiKey: string | null }> = []

  const mcpServer = new McpServer({ name: 'auth-fixture', version: '1.0.0' })
  mcpServer.registerTool('whoami', { description: 'no-op', inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }))
  // 用有状态模式(sessionIdGenerator)而非 stateless:stateless transport 一次请求即失效,
  // 而客户端一次 connect 要走多轮请求(initialize/listTools/...),必须能在同一 session 内复用。
  const serverTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
  await mcpServer.connect(serverTransport)

  const httpServer = Bun.serve({
    port: 0,
    async fetch(req) {
      seenHeaders.push({ authorization: req.headers.get('authorization'), apiKey: req.headers.get('x-api-key') })
      return serverTransport.handleRequest(req)
    },
  })

  try {
    const loaded = await connectMcpServers([{
      name: 'remote fixture',
      transport: 'http',
      url: `http://127.0.0.1:${httpServer.port}/mcp`,
      headers: { Authorization: 'Bearer secret-token-123', 'X-Api-Key': 'k1' },
    }], { timeoutMs: 5000 })

    expect(loaded.warnings).toEqual([])
    expect(loaded.tools.map(t => t.name)).toContain('mcp__remote_fixture__whoami')
    expect(seenHeaders.length).toBeGreaterThan(0)
    for (const seen of seenHeaders) {
      expect(seen.authorization).toBe('Bearer secret-token-123')
      expect(seen.apiKey).toBe('k1')
    }

    await closeMcpConnections(loaded.connections)
  } finally {
    httpServer.stop(true)
    await serverTransport.close()
  }
})
