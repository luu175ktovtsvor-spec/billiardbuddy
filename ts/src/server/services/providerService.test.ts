import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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

test('ProviderService with a credential key encrypts secrets at rest (ciphertext on disk) and reads them back intact', async () => {
  const root = tempRoot()
  const credentialKeyHex = randomBytes(32).toString('hex')
  try {
    const service = new ProviderService(root, { credentialKeyHex })
    await service.create({
      id: 'byok',
      name: 'BYOK',
      apiFormat: 'anthropic',
      baseUrl: 'https://gateway.example/v1',
      authToken: 'app-token-should-be-encrypted',
      apiKey: 'sk-should-be-encrypted',
      model: 'gw-model',
    })

    // 落盘必须是密文:明文 secret 不出现,反而带 enc:v1: 前缀
    const raw = await readFile(join(root, 'providers.json'), 'utf8')
    expect(raw).not.toContain('sk-should-be-encrypted')
    expect(raw).not.toContain('app-token-should-be-encrypted')
    expect(raw).toContain('enc:v1:')

    // 用同一把密钥的新实例读回,内存里必须是解密后的明文(下游 model factory 才能用)
    const reopened = new ProviderService(root, { credentialKeyHex })
    const runtime = await reopened.resolveRuntimeConfig({})
    expect(runtime?.source).toBe('saved-provider')
    expect(runtime?.config.apiKey).toBe('sk-should-be-encrypted')
    expect(runtime?.config.authToken).toBe('app-token-should-be-encrypted')

    // public 视图仍不泄露密钥
    const listed = await reopened.list()
    expect(JSON.stringify(listed)).not.toContain('sk-should-be-encrypted')
    expect(JSON.stringify(listed)).not.toContain('app-token-should-be-encrypted')
    expect(listed.providers[0]).toMatchObject({ id: 'byok', hasApiKey: true, hasAuthToken: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ProviderService without a key stores plaintext (back-compat) and can still be read by an encrypting instance later', async () => {
  const root = tempRoot()
  try {
    // 无密钥:明文落盘(与老行为一致)
    const plain = new ProviderService(root)
    await plain.create({
      id: 'legacy',
      name: 'Legacy',
      apiFormat: 'openai_chat',
      baseUrl: 'https://legacy.example/v1',
      apiKey: 'legacy-plaintext-secret',
      model: 'legacy-model',
    })
    const raw = await readFile(join(root, 'providers.json'), 'utf8')
    expect(raw).toContain('legacy-plaintext-secret')

    // 之后即便配了密钥,旧明文条目也能无缝读回(迁移:下次写盘会被加密)
    const withKey = new ProviderService(root, { credentialKeyHex: randomBytes(32).toString('hex') })
    const runtime = await withKey.resolveRuntimeConfig({})
    expect(runtime?.config.apiKey).toBe('legacy-plaintext-secret')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ProviderService resolves active provider, saved fallbacks, then distinct env fallback', async () => {
  const root = tempRoot()
  try {
    const service = new ProviderService(root)
    await service.create({
      id: 'saved',
      name: 'Saved Provider',
      apiFormat: 'openai_chat',
      baseUrl: 'https://saved.example/v1/',
      apiKey: 'saved-secret',
      model: 'saved-model',
    })
    await service.create({
      id: 'backup',
      name: 'Backup Provider',
      apiFormat: 'openai_chat',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'backup-secret',
      model: 'backup-model',
    })
    await service.create({
      id: 'same_target',
      name: 'Same Target',
      apiFormat: 'openai_chat',
      baseUrl: 'https://saved.example/v1',
      apiKey: 'same-target-secret',
      model: 'saved-model',
    })

    const runtimes = await service.resolveRuntimeConfigs({
      OPENAI_BASE_URL: 'https://fallback.example/v1',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'fallback-model',
    })
    expect(runtimes.map(runtime => runtime.source)).toEqual(['saved-provider', 'saved-provider', 'env'])
    expect(runtimes[0]?.providerId).toBe('saved')
    expect(runtimes[1]?.providerId).toBe('backup')
    expect(runtimes[2]?.summary).toMatchObject({ model: 'fallback-model', hasApiKey: true })
    expect(JSON.stringify(runtimes.map(runtime => runtime.summary))).not.toContain('saved-secret')
    expect(JSON.stringify(runtimes.map(runtime => runtime.summary))).not.toContain('backup-secret')
    expect(JSON.stringify(runtimes.map(runtime => runtime.summary))).not.toContain('same-target-secret')
    expect(JSON.stringify(runtimes.map(runtime => runtime.summary))).not.toContain('fallback-secret')

    const deduped = await service.resolveRuntimeConfigs({
      OPENAI_BASE_URL: 'https://saved.example/v1/',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'saved-model',
    })
    expect(deduped.map(runtime => runtime.providerId ?? runtime.source)).toEqual(['saved', 'backup'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ProviderService can disable and reorder saved fallback providers without leaking secrets', async () => {
  const root = tempRoot()
  try {
    const service = new ProviderService(root)
    await service.create({
      id: 'primary',
      name: 'Primary',
      apiFormat: 'openai_chat',
      baseUrl: 'https://primary.example/v1',
      apiKey: 'primary-secret',
      model: 'primary-model',
    })
    await service.create({
      id: 'backup',
      name: 'Backup',
      apiFormat: 'openai_chat',
      baseUrl: 'https://backup.example/v1',
      apiKey: 'backup-secret',
      model: 'backup-model',
    })
    await service.create({
      id: 'slow',
      name: 'Slow',
      apiFormat: 'openai_chat',
      baseUrl: 'https://slow.example/v1',
      apiKey: 'slow-secret',
      model: 'slow-model',
    })

    const disabledActive = await service.setEnabled('primary', false)
    expect(disabledActive.enabled).toBe(false)
    expect((await service.list()).activeId).toBe('backup')

    await service.activate('backup')
    await service.reorder(['slow', 'backup', 'primary'])
    await service.setEnabled('slow', false)

    const listed = await service.list()
    expect(listed.providers.map(provider => [provider.id, provider.enabled])).toEqual([
      ['slow', false],
      ['backup', true],
      ['primary', false],
    ])
    expect(JSON.stringify(listed)).not.toContain('backup-secret')

    const runtimes = await service.resolveRuntimeConfigs({
      OPENAI_BASE_URL: 'https://fallback.example/v1',
      OPENAI_API_KEY: 'fallback-secret',
      TEXT_MODEL_NAME: 'fallback-model',
    })
    expect(runtimes.map(runtime => runtime.providerId ?? runtime.source)).toEqual(['backup', 'env'])

    const raw = await readFile(join(root, 'providers.json'), 'utf8')
    expect(raw).toContain('"enabled": false')
    expect(raw).toContain('primary-secret')
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
