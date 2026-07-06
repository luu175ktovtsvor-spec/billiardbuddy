import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderService } from './providerService'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'provider-service-'))
}

function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const line of lines) c.enqueue(enc.encode(`data: ${line}\n\n`))
      c.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('ProviderService persists providers, redacts secrets, and resolves active runtime config first', async () => {
  const root = tempRoot()
  try {
    const service = new ProviderService(root)
    const created = await service.create({
      id: 'mimo',
      name: 'MiMo v2.5',
      apiFormat: 'openai_chat',
      baseUrl: 'https://api.xiaomimimo.com/v1/',
      apiKey: 'real-secret',
      model: 'mimo-v2.5',
      reasoningEffort: 'max',
      networkSettings: { proxy: { mode: 'direct' } },
    })
    expect(created).toMatchObject({
      id: 'mimo',
      hasApiKey: true,
      hasAuthToken: false,
      baseUrl: 'https://api.xiaomimimo.com/v1',
      reasoningEffort: 'high',
    })
    expect(JSON.stringify(created)).not.toContain('real-secret')

    const second = new ProviderService(root)
    const listed = await second.list()
    expect(listed.activeId).toBe('mimo')
    expect(listed.providers).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('real-secret')

    const runtime = await second.resolveRuntimeConfig({
      OPENAI_BASE_URL: 'https://fallback.example/v1',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'fallback-model',
    })
    expect(runtime?.source).toBe('saved-provider')
    expect(runtime?.providerId).toBe('mimo')
    expect(runtime?.config.model).toBe('mimo-v2.5')
    expect(runtime?.summary.hasApiKey).toBe(true)
    expect(JSON.stringify(runtime?.summary)).not.toContain('real-secret')

    const raw = await readFile(join(root, 'providers.json'), 'utf8')
    expect(raw).toContain('real-secret')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ProviderService falls back to env when active provider is cleared', async () => {
  const root = tempRoot()
  try {
    const service = new ProviderService(root)
    await service.create({
      id: 'p1',
      name: 'Provider',
      apiFormat: 'openai_chat',
      baseUrl: 'https://saved.example/v1',
      apiKey: 'saved-secret',
      model: 'saved-model',
    })
    await service.clearActive()
    const runtime = await service.resolveRuntimeConfig({
      OPENAI_BASE_URL: 'https://fallback.example/v1',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'fallback-model',
    })
    expect(runtime?.source).toBe('env')
    expect(runtime?.config.model).toBe('fallback-model')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ProviderService testProviderConfig calls model adapter and never returns the key', async () => {
  const root = tempRoot()
  const service = new ProviderService(root)
  let sentUrl = ''
  let sentBody: any
  try {
    const result = await service.testProviderConfig({
      name: 'MiMo',
      apiFormat: 'openai_chat',
      baseUrl: 'https://model.example/v1',
      apiKey: 'secret-key',
      model: 'mimo-v2.5',
    }, {
      fetchImpl: async (url, init) => {
        sentUrl = String(url)
        sentBody = JSON.parse(init?.body as string)
        return sseResponse([
          JSON.stringify({ id: 'x', model: 'mimo-v2.5', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }),
          '[DONE]',
        ])
      },
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toMatchObject({
      apiFormat: 'openai_chat',
      hasApiKey: true,
      model: 'mimo-v2.5',
    })
    expect(result.textSample).toBe('OK')
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(sentUrl).toBe('https://model.example/v1/chat/completions')
    expect(sentBody.model).toBe('mimo-v2.5')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
