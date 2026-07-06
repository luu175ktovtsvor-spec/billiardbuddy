import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { closeMcpConnections, connectMcpServers } from './client'

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
