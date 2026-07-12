import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { McpOAuthProvider } from './oauth'
import { closeMcpConnections, connectMcpServers } from './client'
import { Workspace } from '../workspace/workspace'

test('McpOAuthProvider:凭据落盘往返 + 按域作废(tokens 清了 clientInformation 还在)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-store-'))
  try {
    const a = new McpOAuthProvider({ serverName: 'srv A', storageDir: dir })
    expect(a.hasTokens()).toBe(false)
    a.saveClientInformation({ client_id: 'cid-9', redirect_uris: [] } as never)
    a.saveTokens({ access_token: 'at-9', token_type: 'bearer', refresh_token: 'rt-9' } as never)
    const b = new McpOAuthProvider({ serverName: 'srv A', storageDir: dir })
    expect(b.hasTokens()).toBe(true)
    expect(b.tokens()?.access_token).toBe('at-9')
    expect(b.clientInformation()?.client_id).toBe('cid-9')
    b.invalidateCredentials('tokens')
    const c = new McpOAuthProvider({ serverName: 'srv A', storageDir: dir })
    expect(c.hasTokens()).toBe(false)
    expect(c.clientInformation()?.client_id).toBe('cid-9') // 注册信息保留,免重复动态注册
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('McpOAuthProvider:本地回调——state 防伪(错 state 400 不收 code,对 state 才放行);closeCallback 幂等', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-cb-'))
  const p = new McpOAuthProvider({ serverName: 's', storageDir: dir, callbackTimeoutMs: 5000 })
  try {
    await p.prepareInteractive()
    const cbUrl = p.redirectUrl!
    expect(cbUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(p.clientMetadata.redirect_uris).toEqual([cbUrl])
    const state = p.state()
    const bad = await fetch(`${cbUrl}?code=EVIL&state=wrong-${state}`)
    expect(bad.status).toBe(400)
    const good = await fetch(`${cbUrl}?code=OK-1&state=${state}`)
    expect(good.status).toBe(200)
    expect(await p.waitForAuthorizationCode()).toBe('OK-1')
  } finally {
    p.closeCallback()
    p.closeCallback() // 幂等
    rmSync(dir, { recursive: true, force: true })
  }
})

test('McpOAuthProvider:等授权码超时按 callbackTimeoutMs 报错(不无限吊死)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-to-'))
  const p = new McpOAuthProvider({ serverName: 's', storageDir: dir, callbackTimeoutMs: 100 })
  try {
    await p.prepareInteractive()
    await expect(p.waitForAuthorizationCode()).rejects.toThrow(/超时/)
  } finally {
    p.closeCallback()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OAuth 端到端:401→发现→动态注册→PKCE 授权(拉"浏览器")→回调换令牌→重连拿到工具;二次连接复用令牌不再拉浏览器', async () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-e2e-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'mcp-oauth-ws-'))

  // 多 session fixture:每个 mcp-session-id 一对 server/transport(单 transport 只吃一次 initialize;
  // e2e 要连两轮=两 session)。这与真实多 session HTTP MCP server 一致。
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  const closers: Array<() => Promise<void>> = []
  const handleMcp = async (req: Request): Promise<Response> => {
    const sid = req.headers.get('mcp-session-id')
    const existing = sid ? sessions.get(sid) : undefined
    if (existing) return existing.handleRequest(req)
    const mcpServer = new McpServer({ name: 'oauth-fixture', version: '1.0.0' })
    mcpServer.registerTool('ping', { description: 'ping', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() })
    await mcpServer.connect(t)
    closers.push(() => t.close())
    const res = await t.handleRequest(req)
    if (t.sessionId) sessions.set(t.sessionId, t)
    return res
  }

  let tokenRequests = 0
  let registeredRedirects: string[] = []
  const httpServer = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const base = url.origin // 从请求 URL 派生,避免在 Bun.serve 初始化器里自引用 httpServer.port
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      }
      if (url.pathname.startsWith('/.well-known/openid-configuration')) return new Response(null, { status: 404 })
      if (url.pathname === '/register' && req.method === 'POST') {
        const body = (await req.json()) as { redirect_uris?: string[]; client_name?: string }
        registeredRedirects = body.redirect_uris ?? []
        return Response.json({
          client_id: 'cid-1',
          redirect_uris: body.redirect_uris ?? [],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: body.client_name,
        })
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        tokenRequests++
        const form = new URLSearchParams(await req.text())
        expect(form.get('grant_type')).toBe('authorization_code')
        expect(form.get('code')).toBe('CODE-1')
        expect(form.get('code_verifier')).toBeTruthy() // PKCE 真在跑
        return Response.json({ access_token: 'at-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'rt-1' })
      }
      if (url.pathname === '/mcp') {
        if (req.headers.get('authorization') !== 'Bearer at-1') {
          return new Response('unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` },
          })
        }
        return handleMcp(req)
      }
      return new Response(null, { status: 404 })
    },
  })

  let browserOpens = 0
  const openAuthUrl = (rawUrl: string): void => {
    browserOpens++
    const u = new URL(rawUrl)
    expect(u.pathname).toBe('/authorize')
    expect(u.searchParams.get('code_challenge')).toBeTruthy()
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    const redirect = u.searchParams.get('redirect_uri')!
    const state = u.searchParams.get('state')!
    // 模拟用户在浏览器完成授权:授权服务器 302 回本地回调带 code+state。
    setTimeout(() => { void fetch(`${redirect}?code=CODE-1&state=${state}`) }, 20)
  }

  const serverConfig = {
    name: 'oauth fixture',
    transport: 'http' as const,
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    oauth: {},
  }

  try {
    const loaded = await connectMcpServers([serverConfig], {
      timeoutMs: 8000,
      oauth: { storageDir, openAuthUrl },
    })
    expect(loaded.warnings).toEqual([])
    expect(browserOpens).toBe(1)
    expect(tokenRequests).toBe(1)
    expect(registeredRedirects[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const ping = loaded.tools.find(t => t.name === 'mcp__oauth_fixture__ping')!
    expect(ping).toBeDefined()
    expect(await ping.execute({}, { workspace: new Workspace(workspaceRoot) } as never)).toContain('pong')
    await closeMcpConnections(loaded.connections)

    // 二连:令牌已落盘 → 不再拉浏览器、不再换码,直接带 Bearer 连上。
    const again = await connectMcpServers([serverConfig], {
      timeoutMs: 8000,
      oauth: { storageDir, openAuthUrl },
    })
    expect(again.warnings).toEqual([])
    expect(browserOpens).toBe(1)
    expect(tokenRequests).toBe(1)
    expect(again.tools.some(t => t.name === 'mcp__oauth_fixture__ping')).toBe(true)
    await closeMcpConnections(again.connections)
  } finally {
    httpServer.stop(true)
    await Promise.allSettled(closers.map(close => close()))
    rmSync(storageDir, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
}, 20000)

test('OAuth 无人值守(interactive:false):无令牌时不拉浏览器、直接报错(需前台先授权)', async () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-headless-'))
  let browserOpens = 0
  try {
    const loaded = await connectMcpServers([{
      name: 'needs auth',
      transport: 'http' as const,
      url: 'http://127.0.0.1:1/mcp', // 不会真连
      oauth: {},
    }], {
      timeoutMs: 3000,
      oauth: { storageDir, interactive: false, openAuthUrl: () => { browserOpens++ } },
    })
    expect(browserOpens).toBe(0)
    expect(loaded.warnings.length).toBe(1)
    expect(loaded.warnings[0]).toContain('无人值守')
    expect(loaded.tools).toEqual([])
  } finally {
    rmSync(storageDir, { recursive: true, force: true })
  }
})
