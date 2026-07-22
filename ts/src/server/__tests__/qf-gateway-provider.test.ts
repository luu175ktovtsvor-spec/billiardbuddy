/**
 * Tests for the product-managed "qf-gateway" provider.
 *
 * Covers: startup auto-enable (without overwriting a user's choice), the
 * credential boundary (token stays in process.env, never on disk / never in the
 * CLI subprocess env), the full Anthropic → OpenAI Chat proxy round-trip through
 * the local proxy, streaming tool_use, and MiMo model selection.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ProviderService } from '../services/providerService.js'
import { handleProxyRequest } from '../proxy/handler.js'
import { buildProviderManagedEnv } from '../services/providerRuntimeEnv.js'
import {
  HOST_ONLY_GATEWAY_ENV_KEYS,
  QF_GATEWAY_PROVIDER_ID,
  buildQfGatewayProvider,
  stripHostOnlyGatewayEnv,
} from '../services/qfGatewayProvider.js'

// ─── Test harness ───────────────────────────────────────────────────────────

const GATEWAY_URL = 'https://gateway.example.com/gw'
const GATEWAY_TOKEN = 'qf-app-token-SECRET-value'
const TEST_SERVER_PORT = 4599

let tmpDir: string
let savedServerPort: number
const savedEnv: Record<string, string | undefined> = {}

function stashEnv(key: string): void {
  savedEnv[key] = process.env[key]
}

async function setup(): Promise<void> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qf-gateway-test-'))
  for (const key of [
    'CLAUDE_CONFIG_DIR',
    'QF_GATEWAY_URL',
    'QF_GATEWAY_TOKEN',
    'QF_GATEWAY_MODEL',
    'BB_INSTALLATION_ID',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ]) {
    stashEnv(key)
  }
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.QF_GATEWAY_URL = GATEWAY_URL
  process.env.QF_GATEWAY_TOKEN = GATEWAY_TOKEN
  delete process.env.QF_GATEWAY_MODEL
  delete process.env.BB_INSTALLATION_ID
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  // ProviderService.serverPort is a process-wide static — snapshot and restore it
  // so this suite never leaks its port into other files' runtime-env assertions.
  savedServerPort = ProviderService.getServerPort()
  ProviderService.setServerPort(TEST_SERVER_PORT)
}

async function teardown(): Promise<void> {
  ProviderService.setServerPort(savedServerPort)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
}

async function readProvidersRaw(): Promise<string> {
  return fs.readFile(path.join(tmpDir, 'billiardbuddy', 'providers.json'), 'utf-8')
}

async function readSettingsRaw(): Promise<string> {
  try {
    return await fs.readFile(path.join(tmpDir, 'billiardbuddy', 'settings.json'), 'utf-8')
  } catch {
    return ''
  }
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
}

async function collectSse(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }

  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const block of text.split('\n\n').filter(Boolean)) {
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) })
      } catch {
        // skip unparseable
      }
    }
  }
  return events
}

const sampleManualInput = {
  presetId: 'custom',
  name: 'User Manual Provider',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-user-manual',
  apiFormat: 'anthropic' as const,
  models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
}

// ─── Startup auto-enable ────────────────────────────────────────────────────

describe('qf-gateway startup auto-enable', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('activates the gateway when configured and no provider is active', async () => {
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )

    await ensureQfGatewayProviderRegistered(svc)

    const { activeId, providers } = await svc.listProviders()
    expect(activeId).toBe(QF_GATEWAY_PROVIDER_ID)
    // Synthetic provider — never appended to the saved list.
    expect(providers).toHaveLength(0)
  })

  test('replaces a stale manual provider because the product runtime is gateway-managed', async () => {
    const svc = new ProviderService()
    const manual = await svc.addProvider(sampleManualInput)
    await svc.activateProvider(manual.id)

    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    await ensureQfGatewayProviderRegistered(svc)

    const { activeId, providers } = await svc.listProviders()
    expect(activeId).toBe(QF_GATEWAY_PROVIDER_ID)
    expect(providers).toHaveLength(1)
    expect(providers[0]?.id).toBe(manual.id)
  })

  test('is a no-op when the gateway is not configured', async () => {
    delete process.env.QF_GATEWAY_URL
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )

    await ensureQfGatewayProviderRegistered(svc)

    const { activeId } = await svc.listProviders()
    expect(activeId).toBeNull()
  })

  test('re-running is idempotent when the gateway is already active', async () => {
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    await ensureQfGatewayProviderRegistered(svc)
    await ensureQfGatewayProviderRegistered(svc)

    const { activeId, providers } = await svc.listProviders()
    expect(activeId).toBe(QF_GATEWAY_PROVIDER_ID)
    expect(providers).toHaveLength(0)
  })
})

// ─── Readiness predicate & startup race (ISSUE 2) ───────────────────────────

describe('qf-gateway readiness predicate & startup race', () => {
  beforeEach(async () => {
    await setup()
    const { resetQfGatewayRegistrationForTests } = await import(
      '../services/qfGatewayProvider.js'
    )
    resetQfGatewayRegistrationForTests()
  })
  afterEach(async () => {
    const { resetQfGatewayRegistrationForTests } = await import(
      '../services/qfGatewayProvider.js'
    )
    resetQfGatewayRegistrationForTests()
    await teardown()
  })

  test('missing URL (token set) is not configured: no activation, not authed, no proxy target', async () => {
    delete process.env.QF_GATEWAY_URL
    const { qfGatewayConfigured, ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    expect(qfGatewayConfigured()).toBe(false)

    const svc = new ProviderService()
    await ensureQfGatewayProviderRegistered(svc)
    expect((await svc.listProviders()).activeId).toBeNull()
    expect((await svc.checkAuthStatus()).hasAuth).toBe(false)
    expect(await svc.getProviderForProxy(QF_GATEWAY_PROVIDER_ID)).toBeNull()
  })

  test('missing token (URL set) fails closed: no activation, not authed, never an empty Bearer', async () => {
    delete process.env.QF_GATEWAY_TOKEN
    const { qfGatewayConfigured, ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    expect(qfGatewayConfigured()).toBe(false)

    const svc = new ProviderService()
    await ensureQfGatewayProviderRegistered(svc)
    expect((await svc.listProviders()).activeId).toBeNull()
    const auth = await svc.checkAuthStatus()
    expect(auth.hasAuth).toBe(false)
    // Explicit-providerId proxy path must also refuse rather than emit `Bearer `.
    expect(await svc.getProviderForProxy(QF_GATEWAY_PROVIDER_ID)).toBeNull()
  })

  test('a public HTTP gateway is never configured or used as a proxy target', async () => {
    process.env.QF_GATEWAY_URL = 'http://39.106.214.21/gw'
    const { qfGatewayConfigured, resolveQfGatewayProxyTarget } = await import(
      '../services/qfGatewayProvider.js'
    )
    expect(qfGatewayConfigured()).toBe(false)
    expect(resolveQfGatewayProxyTarget()).toEqual({ baseUrl: '', apiKey: '' })

    const svc = new ProviderService()
    expect(await svc.getProviderForProxy(QF_GATEWAY_PROVIDER_ID)).toBeNull()
  })

  test('a secure URL outside the /gw gateway base is never configured or used as a proxy target', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    const { qfGatewayConfigured, resolveQfGatewayProxyTarget } = await import(
      '../services/qfGatewayProvider.js'
    )
    expect(qfGatewayConfigured()).toBe(false)
    expect(resolveQfGatewayProxyTarget()).toEqual({ baseUrl: '', apiKey: '' })

    const svc = new ProviderService()
    expect(await svc.getProviderForProxy(QF_GATEWAY_PROVIDER_ID)).toBeNull()
  })

  test('first session waits for registration: whenQfGatewayReady resolves after activation settles', async () => {
    const { ensureQfGatewayRegistration, whenQfGatewayReady } = await import(
      '../services/qfGatewayProvider.js'
    )
    const svc = new ProviderService()
    // Kick off registration WITHOUT awaiting it (mirrors startServer's call site)...
    ensureQfGatewayRegistration(svc)
    // ...then the session-start gate awaits readiness before reading the provider.
    await whenQfGatewayReady()
    expect((await svc.listProviders()).activeId).toBe(QF_GATEWAY_PROVIDER_ID)
  })

  test('registration is memoized: concurrent callers share one settled promise', async () => {
    const { ensureQfGatewayRegistration } = await import(
      '../services/qfGatewayProvider.js'
    )
    const svc = new ProviderService()
    const a = ensureQfGatewayRegistration(svc)
    const b = ensureQfGatewayRegistration(svc)
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect((await svc.listProviders()).activeId).toBe(QF_GATEWAY_PROVIDER_ID)
  })

  test('init failure is swallowed: whenQfGatewayReady still resolves, no unhandled rejection', async () => {
    const { ensureQfGatewayRegistration, whenQfGatewayReady } = await import(
      '../services/qfGatewayProvider.js'
    )
    const svc = new ProviderService()
    svc.activateProvider = mock(async () => { throw new Error('boom: activation failed') })
    // The kicked-off registration must resolve (error caught), not reject.
    await expect(ensureQfGatewayRegistration(svc)).resolves.toBeUndefined()
    await expect(whenQfGatewayReady()).resolves.toBeUndefined()
  })
})

// ─── Managed runtime privacy: default-disable non-essential/telemetry traffic ─

describe('qf-gateway managed runtime privacy', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('the managed CLI env disables non-essential traffic and telemetry by default', async () => {
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    await ensureQfGatewayProviderRegistered(svc)

    const { readActiveProviderManagedEnv } = await import(
      '../services/providerRuntimeEnv.js'
    )
    const env = readActiveProviderManagedEnv(tmpDir, { serverPort: TEST_SERVER_PORT })
    expect(env).not.toBeNull()
    expect(env!.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(env!.DISABLE_TELEMETRY).toBe('1')
    // Still routes through the local proxy and never carries the real app token.
    expect(env!.ANTHROPIC_BASE_URL).toContain(`/proxy/providers/${QF_GATEWAY_PROVIDER_ID}`)
    expect(JSON.stringify(env)).not.toContain(GATEWAY_TOKEN)
  })
})

// ─── Credential boundary: token in env, not on disk ─────────────────────────

describe('qf-gateway credential boundary', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('the token never lands in providers.json or settings.json after activation', async () => {
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    await ensureQfGatewayProviderRegistered(svc)

    const providersRaw = await readProvidersRaw()
    const settingsRaw = await readSettingsRaw()

    expect(providersRaw).not.toContain(GATEWAY_TOKEN)
    // The synthetic provider must not be persisted into the saved list at all.
    expect(providersRaw).not.toContain('"apiKey"')
    expect(settingsRaw).not.toContain(GATEWAY_TOKEN)
  })

  test('getProviderForProxy overlays the env token at request time', async () => {
    const svc = new ProviderService()
    const config = await svc.getProviderForProxy(QF_GATEWAY_PROVIDER_ID)

    expect(config).not.toBeNull()
    expect(config!.apiKey).toBe(GATEWAY_TOKEN)
    expect(config!.baseUrl).toBe(GATEWAY_URL)
    expect(config!.apiFormat).toBe('openai_chat')
  })

  test('the CLI subprocess env carries proxy-managed auth + local proxy, never the token', () => {
    const env = buildProviderManagedEnv(buildQfGatewayProvider(), {
      proxyPath: `/proxy/providers/${QF_GATEWAY_PROVIDER_ID}`,
      serverPort: TEST_SERVER_PORT,
    })

    expect(env.ANTHROPIC_API_KEY).toBe('proxy-managed')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBe(
      `http://127.0.0.1:${TEST_SERVER_PORT}/proxy/providers/${QF_GATEWAY_PROVIDER_ID}`,
    )
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-flash') // BilliardBuddy product default = DeepSeek V4 Flash
    // The real app token must appear nowhere in the subprocess env.
    expect(JSON.stringify(env)).not.toContain(GATEWAY_TOKEN)
  })
})

// ─── Proxy round-trip ───────────────────────────────────────────────────────

describe('qf-gateway proxy round-trip', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('forwards an Anthropic request to the gateway as OpenAI Chat with the app token', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-qf',
          object: 'chat.completion',
          created: 0,
          model: 'qwen3-coder-plus',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok from gateway' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3-coder-plus',
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hello gateway' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)

      // Upstream request assertions.
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`${GATEWAY_URL}/v1/chat/completions`)
      expect(calls[0].headers.Authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
      expect(calls[0].body.model).toBe('qwen3-coder-plus')
      // No install id set → no X-QF-Client-ID header (falls back to token-only scheduling).
      expect(calls[0].headers['X-QF-Client-ID']).toBeUndefined()

      // Response transformed back to Anthropic shape.
      const anthropic = (await res.json()) as Record<string, unknown>
      expect(anthropic.type).toBe('message')
      expect(anthropic.role).toBe('assistant')
      expect(Array.isArray(anthropic.content)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('forwards only QF native WebSearchTool requests as raw Anthropic Messages', async () => {
    process.env.BB_INSTALLATION_ID = 'bb-install-abcdef12'
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"server_tool_use"}}\n\n'
          + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"web_search_tool_result"}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream', 'request-id': 'gateway-native-search' } },
      )
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer forged-cli-token',
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'web-search-2025-03-05',
            'X-QF-Client-ID': 'forged-client-id-1234',
          },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            stream: true,
            messages: [{ role: 'user', content: 'search current billiards rules' }],
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('web_search_tool_result')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(`${GATEWAY_URL}/v1/messages`)
      expect(calls[0]?.headers.Authorization).toBe(`Bearer ${GATEWAY_TOKEN}`)
      expect(calls[0]?.headers.Authorization).not.toBe('Bearer forged-cli-token')
      expect(calls[0]?.headers['X-QF-Client-ID']).toBe('bb-install-abcdef12')
      expect(calls[0]?.headers['anthropic-beta']).toBe('web-search-2025-03-05')
      expect(calls[0]?.body.tools).toEqual([
        { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('attaches X-QF-Client-ID upstream when an install id is present (gateway path only)', async () => {
    process.env.BB_INSTALLATION_ID = 'bb-install-abcdef12'
    const originalFetch = globalThis.fetch
    const calls: Array<{ headers: Record<string, string> }> = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(
        JSON.stringify({
          id: 'c', object: 'chat.completion', created: 0, model: 'qwen3-coder-plus',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'qwen3-coder-plus', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(calls[0].headers['X-QF-Client-ID']).toBe('bb-install-abcdef12')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('the install id and media UI capability are host-only keys stripped from CLI subprocesses', () => {
    expect(HOST_ONLY_GATEWAY_ENV_KEYS).toContain('BB_INSTALLATION_ID')
    expect(HOST_ONLY_GATEWAY_ENV_KEYS).toContain('BB_MEDIA_UI_CAPABILITY')
    const stripped = stripHostOnlyGatewayEnv({
      PATH: '/x',
      BB_INSTALLATION_ID: 'bb-1',
      BB_MEDIA_UI_CAPABILITY: 'media-secret',
      QF_GATEWAY_TOKEN: 't',
    })
    expect(stripped.BB_INSTALLATION_ID).toBeUndefined()
    expect(stripped.BB_MEDIA_UI_CAPABILITY).toBeUndefined()
    expect(stripped.QF_GATEWAY_TOKEN).toBeUndefined()
    expect(stripped.PATH).toBe('/x')
  })

  test('allows an image request for a non-multimodal gateway model (Qwen) — reaches the gateway as image_url', async () => {
    // The gateway now owns the vision decision: Qwen is text-only itself, but the server-side
    // MiMo vision bridge reads the image first, so the local proxy must never 400 or drop it.
    const originalFetch = globalThis.fetch
    const calls: Array<{ body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(
        JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'qwen3-coder-plus',
          choices: [{ index: 0, message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3-coder-plus', max_tokens: 16,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
              { type: 'text', text: 'what is in this image?' },
            ] }],
          }),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(calls).toHaveLength(1) // reached the gateway (not rejected)
      expect(JSON.stringify(calls[0].body.messages)).toContain('image_url') // image preserved, gateway decides how to read it
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('allows an image request for mimo-v2.5-pro (text-only reasoning model) — reaches the gateway as image_url', async () => {
    // Same reasoning as the Qwen case above: mimo-v2.5-pro can't read images itself, but the
    // gateway's vision bridge can, so the local proxy still forwards the image untouched.
    const originalFetch = globalThis.fetch
    const calls: Array<{ body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(
        JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'mimo-v2.5-pro',
          choices: [{ index: 0, message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'mimo-v2.5-pro', max_tokens: 16, // -pro is text-only per MiMo docs
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
              { type: 'text', text: 'what is in this image?' },
            ] }],
          }),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(calls[0].body.messages)).toContain('image_url')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('allows an image request for MiMo (the multimodal upstream) — reaches the gateway as image_url', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(
        JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'mimo-v2.5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'a cat' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch
    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'mimo-v2.5', max_tokens: 16,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
              { type: 'text', text: 'what is in this image?' },
            ] }],
          }),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(calls).toHaveLength(1) // reached the gateway (not rejected)
      expect(JSON.stringify(calls[0].body.messages)).toContain('image_url') // image preserved in vision mode
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('streams tool_use through the proxy', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      const sseChunks = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"qwen3-coder-plus","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"qwen3-coder-plus","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"qwen3-coder-plus","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"NYC\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":0,"model":"qwen3-coder-plus","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]
      return new Response(makeStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen3-coder-plus',
            max_tokens: 64,
            stream: true,
            messages: [{ role: 'user', content: 'weather in NYC?' }],
          }),
        },
      )

      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(res.body).not.toBeNull()

      const events = await collectSse(res.body as ReadableStream<Uint8Array>)
      const toolUseStart = events.find(
        (e) =>
          e.event === 'content_block_start' &&
          (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
      )
      expect(toolUseStart).toBeDefined()

      const messageDelta = events.find((e) => e.event === 'message_delta')
      expect(
        (messageDelta?.data.delta as Record<string, unknown>)?.stop_reason,
      ).toBe('tool_use')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── MiMo model selection ───────────────────────────────────────────────────

describe('qf-gateway MiMo selection', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('QF_GATEWAY_MODEL flows to ANTHROPIC_MODEL and the forwarded upstream model', async () => {
    const mimoModel = 'mimo-7b-rl'
    process.env.QF_GATEWAY_MODEL = mimoModel

    // Subprocess env picks the mimo id.
    const env = buildProviderManagedEnv(buildQfGatewayProvider(), {
      proxyPath: `/proxy/providers/${QF_GATEWAY_PROVIDER_ID}`,
      serverPort: TEST_SERVER_PORT,
    })
    expect(env.ANTHROPIC_MODEL).toBe(mimoModel)

    // And the proxy forwards that same model id upstream.
    const originalFetch = globalThis.fetch
    const calls: Array<{ body: Record<string, unknown> }> = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-mimo',
          object: 'chat.completion',
          created: 0,
          model: mimoModel,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    try {
      const req = new Request(
        `http://localhost:3456/proxy/providers/${QF_GATEWAY_PROVIDER_ID}/v1/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: env.ANTHROPIC_MODEL,
            max_tokens: 64,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
      )
      const res = await handleProxyRequest(req, new URL(req.url))
      expect(res.status).toBe(200)
      expect(calls[0].body.model).toBe(mimoModel)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// Regression: qf-gateway is a synthetic built-in that is NEVER in the saved
// providers list. Every "is this a known provider" check must recognize it via
// isQfGatewayProviderId, or the first real session (ws getDefaultRuntimeSettings)
// treats it as stale and calls activateOfficial(), silently destroying routing.
describe('qf-gateway consumer recognition (must not be treated as stale)', () => {
  beforeEach(setup)
  afterEach(teardown)

  test('ws isKnownRuntimeProviderId recognizes qf-gateway even with an empty saved list', async () => {
    const { isKnownRuntimeProviderId } = await import('../ws/handler.js')
    expect(isKnownRuntimeProviderId(QF_GATEWAY_PROVIDER_ID, [])).toBe(true)
  })

  test('active qf-gateway survives a ProviderService round-trip (migration must not null activeId)', async () => {
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    await ensureQfGatewayProviderRegistered(svc)
    // A fresh service re-reads from disk, running the persistent-storage migration.
    const fresh = new ProviderService()
    const { activeId } = await fresh.listProviders()
    expect(activeId).toBe(QF_GATEWAY_PROVIDER_ID)
  })

  test('checkAuthStatus reports authed when qf-gateway is active and configured', async () => {
    const svc = new ProviderService()
    const { ensureQfGatewayProviderRegistered } = await import(
      '../services/qfGatewayProvider.js'
    )
    await ensureQfGatewayProviderRegistered(svc)
    const status = await svc.checkAuthStatus()
    expect(status.hasAuth).toBe(true)
    expect(status.source).toBe('billiardbuddy-provider')
  })
})
