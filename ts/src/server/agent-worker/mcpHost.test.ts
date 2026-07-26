import { expect, test } from 'bun:test'
import { getCwd } from '../../utils/cwd.js'
import { StandardProductTaskMcpHost } from './mcpHost.js'
import type { ProductMcpConnection, ProductMcpResource } from './productMcpClient.js'
import type { ScopedProductMcpServerConfig } from './productMcpConfig.js'
import type { ProductCommand, ProductTool } from './productTool.js'

test('ProductTask MCP Host loads and connects the BilliardBuddy MCP layer inside the task workspace', async () => {
  const workDir = '/workspace/product-task'
  const config = { type: 'stdio', command: 'host-mcp', scope: 'user' } as ScopedProductMcpServerConfig
  const client = { name: 'host', type: 'connected', config } as ProductMcpConnection
  const tool = { name: 'mcp__host__read' } as ProductTool
  const duplicateTool = { name: tool.name } as ProductTool
  const command = { name: 'mcp__host__prompt' } as ProductCommand
  const resource = { server: 'host', uri: 'resource://one', name: 'one' } as ProductMcpResource
  let configCwd: string | undefined
  let connectCwd: string | undefined

  const host = new StandardProductTaskMcpHost({
    loadConfigs: async () => {
      configCwd = getCwd()
      return { servers: { host: config } }
    },
    connect: async (name, received) => {
      connectCwd = getCwd()
      expect(name).toBe('host')
      expect(received).toEqual(config)
      return { client, tools: [tool, duplicateTool], commands: [command], resources: [resource] }
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
  const config = { type: 'http', url: 'https://mcp.invalid', scope: 'user' } as ScopedProductMcpServerConfig
  const failed = { name: 'unavailable', type: 'failed', config } as ProductMcpConnection
  const host = new StandardProductTaskMcpHost({
    loadConfigs: async () => ({ servers: { unavailable: config } }),
    connect: async () => ({ client: failed, tools: [], commands: [] }),
  })

  await expect(host.connect('/workspace/product-task')).resolves.toEqual({
    clients: [failed],
    tools: [],
    commands: [],
    resources: {},
  })
})

test('ProductTask MCP Host does not connect remote servers when the frozen Turn denies network', async () => {
  const config = { type: 'http', url: 'https://mcp.invalid', scope: 'project' } as ScopedProductMcpServerConfig
  let connections = 0
  const host = new StandardProductTaskMcpHost({
    loadConfigs: async () => ({ servers: { remote: config } }),
    connect: async () => { connections += 1; throw new Error('must not connect') },
  })

  const runtime = await host.connect('/workspace/product-task', { networkScope: 'denied' })

  expect(connections).toBe(0)
  expect(runtime.clients).toEqual([{ name: 'remote', type: 'failed', config }])
  expect(runtime.tools).toEqual([])
})
