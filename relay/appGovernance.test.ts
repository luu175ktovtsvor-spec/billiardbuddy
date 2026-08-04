import { describe, expect, test } from 'bun:test'

import { createRelayFetch } from './app'
import type { RelayAdmissionBackend, RelayProviderAdmissionConfig } from './capacityPolicy'
import { imageRelayIdempotencyLookupPath } from '../ts/shared/product/imageRelayProtocol'

const IMAGE_SERVICE_TOKEN = 'image-relay-service-token-123456789012345'
const RESULT_SIGNING_KEY = 'result-signing-key-that-is-longer-than-thirty-two-bytes'

function environment(openaiKey = 'openai-secret-that-must-not-leak'): Record<string, string> {
  return {
    RELAY_OPENAI_KEY: openaiKey,
    RELAY_OPENAI_BASE: 'https://provider.example.test/v1',
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

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 1_000
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
      provider: 'openai', requests_per_minute: 17, rate_queue_max: 4,
      concurrency: expect.objectContaining({ maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2 }),
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
