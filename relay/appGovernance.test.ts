import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRelayFetch, MAX_PRE_PROVIDER_ADMISSION_RETRIES } from './app'
import type { RelayAdmissionBackend, RelayProviderAdmissionConfig } from './capacityPolicy'
import { imageRelayIdempotencyLookupPath } from '../ts/shared/product/imageRelayProtocol'
import { CapacityQueueError } from '../ts/shared/kernel/providerAdmission'

const IMAGE_SERVICE_TOKEN = 'image-relay-service-token-123456789012345'
const RESULT_SIGNING_KEY = 'result-signing-key-that-is-longer-than-thirty-two-bytes'

function environment(openaiKey = 'openai-secret-that-must-not-leak'): Record<string, string> {
  return {
    RELAY_OPENAI_KEY: openaiKey,
    RELAY_OPENAI_BASE: 'https://provider.example.test/v1',
    RELAY_OPENAI_ACCOUNT_REF: 'openai-primary-account',
    RELAY_OPENAI_ACCOUNT_BINDING_REVISION: 'openai-binding-test-v1',
    RELAY_SEEDREAM_ACCOUNT_REF: 'seedream-primary-account',
    RELAY_SEEDREAM_ACCOUNT_BINDING_REVISION: 'seedream-binding-test-v1',
    RELAY_IMG_CONC: '1',
    RELAY_IMG_USER_CONC: '1',
    RELAY_OPENAI_RPM: '120',
    RELAY_QUEUE_MAX: '4',
    RELAY_USER_MAX: '2',
    IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: IMAGE_SERVICE_TOKEN,
    IMAGE_RELAY_PUBLIC_BASE: 'https://relay.example.test/image-generation',
    IMAGE_RELAY_RESULT_SIGNING_KEY: RESULT_SIGNING_KEY,
  }
}

function identityFor(desktopBearer: string): Record<string, unknown> {
  const marker = desktopBearer === 'desktop-b' ? 'b' : 'a'
  const principalId = `installation:${marker.repeat(32)}`
  const installationId = `desktop-installation-${marker}`
  return {
    active: true,
    principal_id: principalId,
    installation_id: installationId,
    session_id: marker.repeat(24),
    expires_at: Date.now() + 60_000,
    owner: `${principalId}:${installationId}`,
  }
}

function identityFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init)
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = authorization.replace(/^Bearer\s+/i, '')
  return Promise.resolve(Response.json(identityFor(bearer)))
}

function requestHeaders(desktopBearer: string, operation: string, legacyOwner = 'forged-owner'): Record<string, string> {
  return {
    Authorization: `Bearer ${desktopBearer}`,
    'Content-Type': 'application/json',
    // These legacy headers are deliberately ignored: only Gateway introspection derives owner.
    'X-Relay-Owner': legacyOwner,
    'X-BB-Provider-Protocol': 'bb-provider-gateway/1.0',
    'Idempotency-Key': operation,
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

describe('Image Relay resource governance', () => {
  test('uses one injected backend for Gateway identity and provider account concurrency plus RPM', async () => {
    const providerConfigs: RelayProviderAdmissionConfig[] = []
    const identityConfigs: Array<{ maxActive: number; maxQueued: number; maxWaitMs: number }> = []
    const acquired: string[] = []
    let providerReleases = 0
    let identityFenceChecks = 0
    let providerFenceChecks = 0
    const admissionBackend: RelayAdmissionBackend = {
      createIdentityAdmission(config) {
        identityConfigs.push(config)
        return { async acquire() { return { async assertCurrent() { identityFenceChecks += 1 }, release() {} } } }
      },
      createProviderAdmission(config) {
        providerConfigs.push(config)
        return {
          async acquire(owner) {
            acquired.push(owner)
            return { async assertCurrent() { providerFenceChecks += 1 }, release() { providerReleases += 1 } }
          },
          async acquireGenerationRate() {},
          snapshot() {
            return {
              active: 0, queued: 0, activeOwners: 0, queuedOwners: 0,
              maxActive: 91, maxActivePerOwner: 92, maxQueued: 93, maxQueuedPerOwner: 94,
              oldestQueueMs: 0, closed: false,
              rate: { available: 95, queued: 0, rpm: config.requests_per_minute, queueMax: config.rate_queue_max },
            }
          },
        }
      },
    }
    const relay = createRelayFetch({
      env: { ...environment('openai-backend-injection-key'), RELAY_OPENAI_RPM: '17', RELAY_IDENTITY_MAX_ACTIVE: '3', RELAY_IDENTITY_QUEUE_MAX: '7', RELAY_IDENTITY_MAX_WAIT_MS: '9000' },
      admissionBackend,
      identityFetchImpl: identityFetch,
      fetchImpl: async () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }),
    })
    expect(identityConfigs).toEqual([expect.objectContaining({ maxActive: 3, maxQueued: 7, maxWaitMs: 9000 })])
    expect(providerConfigs).toHaveLength(2)
    expect(providerConfigs[0]).toEqual(expect.objectContaining({
      provider: 'openai', account_key: 'image:openai:openai-primary-account@openai-binding-test-v1', requests_per_minute: 17, rate_queue_max: 4,
      concurrency: expect.objectContaining({ maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2 }),
    }))
    expect(providerConfigs[1]).toEqual(expect.objectContaining({
      provider: 'seedream', account_key: 'image:seedream:seedream-primary-account@seedream-binding-test-v1',
    }))
    const health = await relay(new Request('https://relay.example.test/healthz'))
    expect(await health.json()).toMatchObject({ provider_capacity: { openai: { maxActive: 91, rate: { available: 95, rpm: 17 } } } })
    const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST', headers: requestHeaders('desktop-a', 'operation-injected-backend'),
      body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'injected backend', n: 1, size: '1024x1024' }),
    }))
    expect(submitted.status).toBe(202)
    await waitFor(() => providerReleases === 1, 'injected provider admission was not released')
    expect(acquired).toEqual([`installation:${'a'.repeat(32)}:desktop-installation-a`])
    expect(identityFenceChecks).toBeGreaterThanOrEqual(1)
    expect(providerFenceChecks).toBeGreaterThanOrEqual(2)
  })

  test('revalidates the Seedream account permit before every returned-asset GET', async () => {
    const events: string[] = []
    let providerReleases = 0
    const admissionBackend: RelayAdmissionBackend = {
      createIdentityAdmission() {
        return { async acquire() { return { release() {} } } }
      },
      createProviderAdmission(config) {
        return {
          async acquire() {
            return {
              async assertCurrent() { if (config.provider === 'seedream') events.push('permit') },
              release() { if (config.provider === 'seedream') providerReleases += 1 },
            }
          },
          async acquireGenerationRate() { if (config.provider === 'seedream') events.push('generation-rate') },
          snapshot() {
            return {
              active: 0, queued: 0, activeOwners: 0, queuedOwners: 0,
              maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2,
              oldestQueueMs: 0, closed: false,
              rate: { available: 120, queued: 0, rpm: config.requests_per_minute, queueMax: config.rate_queue_max },
            }
          },
        }
      },
    }
    let generation = 0
    const relay = createRelayFetch({
      env: {
        ...environment(),
        RELAY_ARK_KEY: 'seedream-permit-test-key',
        RELAY_ARK_BASE: 'https://seedream.example.test/v1',
      },
      admissionBackend,
      identityFetchImpl: identityFetch,
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) {
          expect(typeof init?.body).toBe('string')
          generation += 1
          events.push(`POST:${generation}`)
          return Response.json({ data: [{ url: `https://assets.example.test/result-${generation}.png` }] }, { headers: { 'x-tt-logid': `seedream-${generation}` } })
        }
        events.push(`GET:${url}`)
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      },
    })
    const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST', headers: requestHeaders('desktop-a', 'operation-seedream-asset-permits'),
      body: JSON.stringify({ mode: 'generate', model: 'doubao-seedream-4-5-251128', prompt: 'permit every asset', n: 2 }),
    }))
    const task = await submitted.json() as { task_id: string }
    let terminal = ''
    await waitFor(async () => {
      const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, { headers: { Authorization: 'Bearer desktop-a' } }))
      terminal = String((await response.json() as { status?: string }).status ?? '')
      return terminal === 'succeeded'
    }, 'Seedream URL task did not finish')
    expect(events).toEqual([
      'permit',
      'permit', 'generation-rate', 'permit', 'permit', 'POST:1', 'permit', 'GET:https://assets.example.test/result-1.png',
      'permit', 'generation-rate', 'permit', 'permit', 'POST:2', 'permit', 'GET:https://assets.example.test/result-2.png',
    ])
    expect(providerReleases).toBe(1)
  })

  test('Seedream n=2 保持一次任务并发 permit，但每个生成 POST 都扣独立 RPM', async () => {
    let concurrencyAcquires = 0
    let generationRateAttempts = 0
    let providerPosts = 0
    const admissionBackend: RelayAdmissionBackend = {
      createIdentityAdmission() {
        return { async acquire() { return { release() {} } } }
      },
      createProviderAdmission(config) {
        return {
          async acquire() {
            if (config.provider === 'seedream') concurrencyAcquires += 1
            return { async assertCurrent() {}, release() {} }
          },
          async acquireGenerationRate() {
            if (config.provider !== 'seedream') return
            generationRateAttempts += 1
            // RELAY_SEEDREAM_RPM=1: the second paid POST is refused before
            // fetch, without waiting a real minute in this regression test.
            if (generationRateAttempts > 1) throw new CapacityQueueError(429, '当前使用人数较多，请稍后重试')
          },
          snapshot() {
            return {
              active: 0, queued: 0, activeOwners: 0, queuedOwners: 0,
              maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2,
              oldestQueueMs: 0, closed: false,
              rate: { available: 0, queued: 0, rpm: config.requests_per_minute, queueMax: config.rate_queue_max },
            }
          },
        }
      },
    }
    const relay = createRelayFetch({
      env: {
        ...environment(),
        RELAY_ARK_KEY: 'seedream-rpm-test-key',
        RELAY_ARK_BASE: 'https://seedream.example.test/v1',
        RELAY_SEEDREAM_RPM: '1',
      },
      admissionBackend,
      identityFetchImpl: identityFetch,
      fetchImpl: async input => {
        if (!String(input).endsWith('/images/generations')) throw new Error('this regression does not download assets')
        providerPosts += 1
        return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }, { headers: { 'x-tt-logid': 'seedream-rpm-first' } })
      },
    })
    const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST', headers: requestHeaders('desktop-a', 'operation-seedream-rpm-per-post'),
      body: JSON.stringify({ mode: 'generate', model: 'doubao-seedream-4-5-251128', prompt: 'one rpm token only', n: 2 }),
    }))
    expect(submitted.status).toBe(202)
    const task = await submitted.json() as { task_id: string }
    let terminal: Record<string, unknown> = {}
    await waitFor(async () => {
      const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, { headers: { Authorization: 'Bearer desktop-a' } }))
      terminal = await response.json() as Record<string, unknown>
      return terminal.status === 'succeeded'
    }, 'Seedream RPM-limited task did not reach its partial terminal projection')
    expect(terminal).toMatchObject({ valid_count: 1, partial_outcome_unknown: true })
    expect(concurrencyAcquires).toBe(1)
    expect(generationRateAttempts).toBe(2)
    expect(providerPosts).toBe(1)
  })

  test('首次生成 RPM 准入失败会持久化回到 queued，保留输入且有限重试', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-image-relay-rate-retry-'))
    const dbPath = join(root, 'relay.db')
    const blobDir = join(root, 'blobs')
    let rateAttempts = 0
    let providerFetches = 0
    const admissionBackend: RelayAdmissionBackend = {
      createIdentityAdmission() {
        return { async acquire() { return { release() {} } } }
      },
      createProviderAdmission(config) {
        return {
          async acquire() { return { async assertCurrent() {}, release() {} } },
          async acquireGenerationRate() {
            if (config.provider !== 'openai') return
            rateAttempts += 1
            throw new CapacityQueueError(429, '生成 RPM 暂时无可用令牌')
          },
          snapshot() {
            return {
              active: 0, queued: 0, activeOwners: 0, queuedOwners: 0,
              maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2,
              oldestQueueMs: 0, closed: false,
              rate: { available: 0, queued: 0, rpm: config.requests_per_minute, queueMax: config.rate_queue_max },
            }
          },
        }
      },
    }
    try {
      const relay = createRelayFetch({
        env: { ...environment(), RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir, RELAY_RETRY_AFTER_SECONDS: '3600' },
        admissionBackend,
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerFetches += 1
          return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
        },
      })
      const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
        method: 'POST', headers: requestHeaders('desktop-a', 'operation-first-rate-admission-retry'),
        body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'retain before paid fetch', n: 1 }),
      }))
      const task = await submitted.json() as { task_id: string }
      await waitFor(async () => {
        if (rateAttempts !== 1) return false
        const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, {
          headers: { Authorization: 'Bearer desktop-a' },
        }))
        return (await response.json() as { status?: string }).status === 'queued'
      }, 'first RPM rejection did not return the durable task to queued')
      expect(providerFetches).toBe(0)
      expect(existsSync(join(blobDir, `${task.task_id}.in.json`))).toBeTrue()

      const database = new Database(dbPath)
      expect(database.query('SELECT status,admission_retry_count FROM tasks WHERE id=?').get(task.task_id))
        .toEqual({ status: 'queued', admission_retry_count: 1 })
      // Put the durable row at the retry ceiling, then simulate a process
      // restart. Recovery immediately makes one final attempt, proving that the
      // persisted counter (rather than an in-memory loop) bounds retries.
      database.query('UPDATE tasks SET admission_retry_count=? WHERE id=?')
        .run(MAX_PRE_PROVIDER_ADMISSION_RETRIES, task.task_id)
      database.close()

      const recoveredRelay = createRelayFetch({
        env: { ...environment(), RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir, RELAY_RETRY_AFTER_SECONDS: '3600' },
        admissionBackend,
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerFetches += 1
          return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
        },
      })
      let terminal: { status?: string } = {}
      await waitFor(async () => {
        const response = await recoveredRelay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, {
          headers: { Authorization: 'Bearer desktop-a' },
        }))
        terminal = await response.json() as { status?: string }
        return terminal.status === 'failed'
      }, 'persisted RPM retry ceiling did not stop the task')
      expect(providerFetches).toBe(0)
      expect(rateAttempts).toBe(2)
      expect(existsSync(join(blobDir, `${task.task_id}.in.json`))).toBeFalse()
      const exhausted = new Database(dbPath)
      expect(exhausted.query('SELECT status,admission_retry_count FROM tasks WHERE id=?').get(task.task_id))
        .toEqual({ status: 'failed', admission_retry_count: MAX_PRE_PROVIDER_ADMISSION_RETRIES + 1 })
      expect(exhausted.query('SELECT state FROM image_quota_reservations WHERE task_id=?').get(task.task_id))
        .toEqual({ state: 'released' })
      exhausted.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('OpenAI 生成与编辑都在完整 wire body 后执行最后 fence，然后立即 fetch', async () => {
    const events: string[] = []
    let operation = ''
    const admissionBackend: RelayAdmissionBackend = {
      createIdentityAdmission() {
        return { async acquire() { return { release() {} } } }
      },
      createProviderAdmission(config) {
        return {
          async acquire() {
            return {
              async assertCurrent() { if (config.provider === 'openai') events.push(`fence:${operation}`) },
              release() {},
            }
          },
          async acquireGenerationRate() { if (config.provider === 'openai') events.push(`rate:${operation}`) },
          snapshot() {
            return {
              active: 0, queued: 0, activeOwners: 0, queuedOwners: 0,
              maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2,
              oldestQueueMs: 0, closed: false,
              rate: { available: 120, queued: 0, rpm: config.requests_per_minute, queueMax: config.rate_queue_max },
            }
          },
        }
      },
    }
    const relay = createRelayFetch({
      env: environment(), admissionBackend, identityFetchImpl: identityFetch,
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname
        if (path.endsWith('/images/edits')) expect(init?.body).toBeInstanceOf(FormData)
        else expect(typeof init?.body).toBe('string')
        events.push(`fetch:${operation}`)
        return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
      },
    })
    const submitAndWait = async (body: Record<string, unknown>, key: string) => {
      operation = key
      const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
        method: 'POST', headers: requestHeaders('desktop-a', key), body: JSON.stringify(body),
      }))
      const task = await submitted.json() as { task_id: string }
      await waitFor(async () => {
        const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, {
          headers: { Authorization: 'Bearer desktop-a' },
        }))
        return (await response.json() as { status?: string }).status === 'succeeded'
      }, `${key} did not finish`)
    }
    await submitAndWait({ mode: 'generate', model: 'gpt-image-2', prompt: 'wire generate', n: 1 }, 'generate')
    await submitAndWait({
      mode: 'edit', model: 'gpt-image-2', prompt: 'wire edit', n: 1,
      images: ['data:image/png;base64,aGVsbG8='],
    }, 'edit')
    expect(events).toEqual([
      'fence:generate', 'fence:generate', 'rate:generate', 'fence:generate', 'fence:generate', 'fetch:generate',
      'fence:edit', 'fence:edit', 'rate:edit', 'fence:edit', 'fence:edit', 'fetch:edit',
    ])
  })

  test('uses Gateway-introspected owners for fair admission and never projects secrets', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const relay = createRelayFetch({
      env: environment(),
      identityFetchImpl: identityFetch,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { prompt: string }
        started.push(body.prompt)
        await new Promise<void>(resolve => releases.push(resolve))
        return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
      },
    })

    const submit = (desktopBearer: string, operation: string, prompt: string) => relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST',
      headers: requestHeaders(desktopBearer, operation),
      body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt, n: 1, size: '1024x1024' }),
    }))

    const firstSubmit = await submit('desktop-a', 'operation-owner-a-1', 'a-first')
    if (firstSubmit.status !== 202) throw new Error(`first submit failed: ${firstSubmit.status} ${await firstSubmit.text()}`)
    await waitFor(() => started.length === 1, 'first owner did not start')
    expect((await submit('desktop-a', 'operation-owner-a-2', 'a-second')).status).toBe(202)
    expect((await submit('desktop-b', 'operation-owner-b-1', 'b-first')).status).toBe(202)

    releases.shift()?.()
    await waitFor(() => started.length === 2, 'second owner did not receive the fair slot')
    expect(started).toEqual(['a-first', 'b-first'])
    releases.shift()?.()
    await waitFor(() => started.length === 3, 'original owner did not resume')
    expect(started).toEqual(['a-first', 'b-first', 'a-second'])
    releases.shift()?.()

    const health = await relay(new Request('https://relay.example.test/healthz'))
    const healthText = await health.text()
    expect(health.status).toBe(200)
    expect(healthText).toContain('relay-image-small-scale-v1')
    expect(healthText).toContain('gateway-introspection')
    expect(healthText).not.toContain('openai-secret-that-must-not-leak')
    expect(healthText).not.toContain('openai-primary-account')
    expect(healthText).not.toContain('openai-binding-test-v1')
    expect(healthText).not.toContain('seedream-primary-account')
    expect(healthText).not.toContain('seedream-binding-test-v1')
    expect(healthText).not.toContain(IMAGE_SERVICE_TOKEN)
    expect(healthText).not.toContain(RESULT_SIGNING_KEY)
    expect((await relay(new Request('https://relay.example.test/images/tasks'))).status).toBe(404)
  })

  test('cancelling a queued task introspects the caller and removes its admission waiter', async () => {
    let firstRelease: (() => void) | undefined
    const prompts: string[] = []
    const relay = createRelayFetch({
      env: environment('openai-test-key'),
      identityFetchImpl: identityFetch,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { prompt: string }
        prompts.push(body.prompt)
        if (body.prompt === 'blocking') await new Promise<void>(resolve => { firstRelease = resolve })
        return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
      },
    })

    const first = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST',
      headers: requestHeaders('desktop-a', 'operation-blocking'),
      body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'blocking', n: 1 }),
    }))
    if (first.status !== 202) throw new Error(`blocking submit failed: ${first.status} ${await first.text()}`)
    const firstTask = await first.json() as { task_id: string }
    await waitFor(() => prompts.length === 1, 'blocking task did not start')

    const queued = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST',
      headers: requestHeaders('desktop-b', 'operation-cancelled'),
      body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'cancel-me', n: 1 }),
    }))
    const queuedTask = await queued.json() as { task_id: string }
    const cancelled = await relay(new Request(`https://relay.example.test/v1/images/tasks/${queuedTask.task_id}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer desktop-b', 'X-Relay-Owner': 'desktop-a-forged' },
    }))
    expect(cancelled.status).toBe(200)
    expect((await cancelled.json() as { status: string }).status).toBe('cancelled')

    firstRelease?.()
    await waitFor(async () => {
      const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${firstTask.task_id}`, {
        headers: { Authorization: 'Bearer desktop-a' },
      }))
      return (await response.json() as { status: string }).status === 'succeeded'
    }, 'blocking task did not finish')
    expect(prompts).toEqual(['blocking'])
  })

  test('direct-v1 polls issue owner-bound result URLs that the Relay verifies itself', async () => {
    const relay = createRelayFetch({
      env: environment('openai-direct-result-key'),
      identityFetchImpl: identityFetch,
      fetchImpl: async () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }),
    })
    const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST',
      headers: requestHeaders('desktop-a', 'operation-direct-result'),
      body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'direct result', n: 1 }),
    }))
    const task = await submitted.json() as { task_id: string }
    let handoff: { result_url?: string; result_urls?: string[]; data?: unknown[] } = {}
    await waitFor(async () => {
      const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, {
        headers: { Authorization: 'Bearer desktop-a', 'X-BB-Media-Result-Handoff': 'direct-v1' },
      }))
      handoff = await response.json() as typeof handoff
      return Array.isArray(handoff.result_urls) && handoff.result_urls.length === 1
    }, 'direct result handoff was not issued')
    expect(handoff.data).toBeUndefined()
    expect(handoff.result_url).toBe(handoff.result_urls?.[0])
    expect(new URL(handoff.result_url!).pathname).toMatch(/\/0$/)

    // The public relay prefix is stripped by the reverse proxy before this Bun handler.
    const resultPath = new URL(handoff.result_urls![0]!).pathname.replace('/image-generation', '')
    const denied = await relay(new Request(`https://relay.example.test${resultPath}`, { headers: { Authorization: 'Bearer desktop-b' } }))
    expect(denied.status).toBe(403)
    const delivered = await relay(new Request(`https://relay.example.test${resultPath}`, { headers: { Authorization: 'Bearer desktop-a' } }))
    expect(delivered.status).toBe(200)
    expect((await delivered.json() as { data: unknown[] }).data).toHaveLength(1)
  })

  test('recovers a lost submit response by owner-bound idempotency lookup without creating work', async () => {
    let release: (() => void) | undefined
    let providerCalls = 0
    const relay = createRelayFetch({
      env: environment('openai-recovery-key'),
      identityFetchImpl: identityFetch,
      fetchImpl: async () => {
        providerCalls += 1
        await new Promise<void>(resolve => { release = resolve })
        return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
      },
    })
    const operation = 'operation/recovery with spaces'
    const submitted = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST',
      headers: requestHeaders('desktop-a', operation),
      body: JSON.stringify({ mode: 'generate', model: 'gpt-image-2', prompt: 'recover me', n: 1 }),
    }))
    expect(submitted.status).toBe(202)
    const firstTask = await submitted.json() as { task_id: string }
    await waitFor(() => providerCalls === 1, 'provider task did not start')

    const lookupPath = imageRelayIdempotencyLookupPath(operation)
    const recovered = await relay(new Request(`https://relay.example.test${lookupPath}`, {
      headers: { Authorization: 'Bearer desktop-a', 'X-Relay-Owner': 'forged-owner' },
    }))
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ task_id: firstTask.task_id, status: 'running', reused: true })
    expect(providerCalls).toBe(1)

    const hiddenFromAnotherOwner = await relay(new Request(`https://relay.example.test${lookupPath}`, {
      headers: { Authorization: 'Bearer desktop-b' },
    }))
    expect(hiddenFromAnotherOwner.status).toBe(404)
    const missing = await relay(new Request(`https://relay.example.test${imageRelayIdempotencyLookupPath('never-submitted')}`, {
      headers: { Authorization: 'Bearer desktop-a' },
    }))
    expect(missing.status).toBe(404)
    expect(providerCalls).toBe(1)

    release?.()
  })

  test('bounds a slow chunked submit body even when stream cancellation never resolves', async () => {
    let cancelled = false
    const relay = createRelayFetch({
      env: { ...environment(), RELAY_REQUEST_BODY_TIMEOUT_MS: '5' },
      identityFetchImpl: identityFetch,
      fetchImpl: async () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }),
    })
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
        return new Promise<void>(() => {})
      },
    })
    const response = await relay(new Request('https://relay.example.test/v1/images/tasks', {
      method: 'POST',
      headers: requestHeaders('desktop-a', 'operation-hanging-body'),
      body,
    }))
    expect(response.status).toBe(408)
    expect(cancelled).toBe(true)
  })
})
