import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer as createNodeServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { DemoInMemoryAuthProvider } from '@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js'
import { z } from 'zod/v4'
import { connectProductMcpServer } from './productMcpClient.js'
import {
  beginProductMcpAuthorization,
  PRODUCT_MCP_OAUTH_KEY_ENV,
  productMcpAuthorizationStatus,
} from './productMcpOAuth.js'
import type { ScopedProductMcpServerConfig } from './productMcpConfig.js'

const directories: string[] = []
const servers: Server[] = []
const originalConfigDir = process.env.BILLIARDBUDDY_CONFIG_DIR
const originalKey = process.env[PRODUCT_MCP_OAUTH_KEY_ENV]

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.BILLIARDBUDDY_CONFIG_DIR
  else process.env.BILLIARDBUDDY_CONFIG_DIR = originalConfigDir
  if (originalKey === undefined) delete process.env[PRODUCT_MCP_OAUTH_KEY_ENV]
  else process.env[PRODUCT_MCP_OAUTH_KEY_ENV] = originalKey
})

async function reservePort(): Promise<number> {
  const server = createNodeServer()
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('port unavailable'))
      const port = address.port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function startOAuthMcpServer(port: number): Promise<Server> {
  const baseUrl = new URL(`http://127.0.0.1:${port}`)
  const mcpUrl = new URL('/mcp', baseUrl)
  const provider = new DemoInMemoryAuthProvider()
  const app = createMcpExpressApp()
  app.use(mcpAuthRouter({ provider, issuerUrl: baseUrl, baseUrl, resourceServerUrl: mcpUrl, scopesSupported: ['mcp:tools'] }))
  const requireToken = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  })
  app.post('/mcp', requireToken, async (request, response) => {
    const mcp = new McpServer({ name: 'oauth-test', version: '1.0.0' })
    mcp.registerTool('probe', { description: 'OAuth protected probe', inputSchema: { value: z.string() } }, async ({ value }) => ({ content: [{ type: 'text', text: value }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(request, response, request.body)
    } finally { response.on('close', () => { void transport.close(); void mcp.close() }) }
  })
  app.get('/mcp', requireToken, (_request, response) => response.status(405).end())
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening))
    listening.once('error', reject)
  })
  servers.push(server)
  return server
}

describe('Product MCP OAuth', () => {
  test('completes PKCE authorization, stores encrypted credentials, and reconnects without browser state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bb-mcp-oauth-'))
    directories.push(directory)
    process.env.BILLIARDBUDDY_CONFIG_DIR = directory
    process.env[PRODUCT_MCP_OAUTH_KEY_ENV] = Buffer.alloc(32, 7).toString('base64url')
    const [serverPort, callbackPort] = await Promise.all([reservePort(), reservePort()])
    await startOAuthMcpServer(serverPort)
    const config: ScopedProductMcpServerConfig = {
      type: 'http',
      url: `http://127.0.0.1:${serverPort}/mcp`,
      oauth: { callbackPort },
      scope: 'user',
    }

    const started = await beginProductMcpAuthorization('protected', config)
    expect(started.connected).toBe(false)
    expect(started.authorizationUrl).toStartWith(`http://127.0.0.1:${serverPort}/authorize`)
    const browserResponse = await fetch(started.authorizationUrl!, { redirect: 'follow' })
    expect(browserResponse.status).toBe(200)
    expect(await browserResponse.text()).toContain('Authorization complete')
    expect(productMcpAuthorizationStatus('protected', started.flowId!)).toEqual({ status: 'connected' })

    const credentialFiles = readdirSync(join(directory, 'mcp-oauth')).filter(file => file.endsWith('.bin'))
    expect(credentialFiles).toHaveLength(1)
    const encrypted = readFileSync(join(directory, 'mcp-oauth', credentialFiles[0]!))
    expect(encrypted.subarray(0, 5).toString()).toBe('BBMO1')
    expect(encrypted.toString('utf8')).not.toContain('access_token')

    const connected = await connectProductMcpServer('protected', config)
    expect(connected.client.type).toBe('connected')
    expect(connected.tools.map(tool => tool.name)).toContain('mcp__protected__probe')
    await connected.client.cleanup?.()
  }, 15_000)

  test('does not disclose one server authorization flow through another server name', async () => {
    expect(() => productMcpAuthorizationStatus('other', randomUUID())).toThrow('MCP_OAUTH_FLOW_NOT_FOUND')
  })
})
