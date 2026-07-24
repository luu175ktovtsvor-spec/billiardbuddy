import { expect, test } from 'bun:test'
import type { Command } from '../../commands.js'
import type { Tool } from '../../Tool.js'
import type { MCPServerConnection, ScopedMcpServerConfig, ServerResource } from '../../services/mcp/types.js'
import { getCwd } from '../../utils/cwd.js'
import { StandardProductTaskMcpHost } from './mcpHost.js'

test('ProductTask MCP Host loads and connects the generic MCP layer inside the task workspace', async () => {
  const workDir = '/workspace/product-task'
  const config = { type: 'stdio', command: 'host-mcp', scope: 'user' } as ScopedMcpServerConfig
  const client = { name: 'host', type: 'connected', config } as MCPServerConnection
  const tool = { name: 'mcp__host__read' } as Tool
  const duplicateTool = { name: tool.name } as Tool
  const command = { name: 'mcp__host__prompt' } as Command
  const resource = { server: 'host', uri: 'resource://one', name: 'one' } as ServerResource
  let configCwd: string | undefined
  let connectCwd: string | undefined

  const host = new StandardProductTaskMcpHost({
    loadConfigs: async () => {
      configCwd = getCwd()
      return { servers: { host: config } }
    },
    connect: async (onConnection, configs) => {
      connectCwd = getCwd()
      expect(configs).toEqual({ host: config })
      onConnection({ client, tools: [tool, duplicateTool], commands: [command], resources: [resource] })
    },
  })

  const runtime = await host.connect(workDir)
  expect(configCwd).toBe(workDir)
  expect(connectCwd).toBe(workDir)
  expect(runtime).toEqual({
    clients: [client],
    tools: [duplicateTool],
    commands: [command],
    resources: { host: [resource] },
  })
})

test('ProductTask MCP Host preserves failed connection state without inventing tools', async () => {
  const config = { type: 'http', url: 'https://mcp.invalid', scope: 'user' } as ScopedMcpServerConfig
  const failed = { name: 'unavailable', type: 'failed', config, error: 'unavailable' } as MCPServerConnection
  const host = new StandardProductTaskMcpHost({
    loadConfigs: async () => ({ servers: { unavailable: config } }),
    connect: async (onConnection) => { onConnection({ client: failed, tools: [], commands: [] }) },
  })

  await expect(host.connect('/workspace/product-task')).resolves.toEqual({
    clients: [failed],
    tools: [],
    commands: [],
    resources: {},
  })
})
