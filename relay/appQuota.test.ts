import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRelayFetch } from './app'

const serviceToken = 'image-relay-service-token-123456789012345'
const signingKey = 'result-signing-key-that-is-longer-than-thirty-two-bytes'

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    RELAY_OPENAI_KEY: 'openai-key',
    RELAY_ARK_KEY: 'seedream-key',
    RELAY_OPENAI_BASE: 'https://openai.example.test/v1',
    RELAY_ARK_BASE: 'https://seedream.example.test/v1',
    RELAY_IMG_CONC: '1', RELAY_IMG_USER_CONC: '1', RELAY_OPENAI_RPM: '120',
    RELAY_SEEDREAM_CONC: '1', RELAY_SEEDREAM_USER_CONC: '1', RELAY_SEEDREAM_RPM: '120',
    RELAY_QUEUE_MAX: '8', RELAY_USER_MAX: '4',
    IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
    IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: serviceToken,
    IMAGE_RELAY_PUBLIC_BASE: 'https://relay.example.test/image-generation',
    IMAGE_RELAY_RESULT_SIGNING_KEY: signingKey,
    RELAY_QUOTA_POLICY_REVISION: 'quota-test-v1',
    RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '100',
    RELAY_OPENAI_DAILY_USD_MINOR_LIMIT: '100',
    RELAY_SEEDREAM_DAILY_USD_MINOR_LIMIT: '100',
    ...overrides,
  }
}

function identityFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init)
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const marker = bearer === 'desktop-b' ? 'b' : 'a'
  const principal = `installation:${marker.repeat(32)}`
  const installation = `desktop-installation-${marker}`
  return Promise.resolve(Response.json({
    active: true, principal_id: principal, installation_id: installation,
    session_id: marker.repeat(24), expires_at: Date.now() + 60_000, owner: `${principal}:${installation}`,
  }))
}

function request(owner: 'desktop-a' | 'desktop-b', key: string, model = 'gpt-image-2', n = 1): Request {
  return new Request('https://relay.example.test/v1/images/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ mode: 'generate', model, prompt: key, n }),
  })
}

async function waitTerminal(relay: ReturnType<typeof createRelayFetch>, taskId: string, owner = 'desktop-a'): Promise<{ status?: string }> {
  const until = Date.now() + 1_000
  while (Date.now() < until) {
    const response = await relay(new Request(`https://relay.example.test/v1/images/tasks/${taskId}`, { headers: { Authorization: `Bearer ${owner}` } }))
    const body = await response.json() as { status?: string }
    if (!['queued', 'running'].includes(body.status ?? '')) return body
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error('task did not finish')
}

describe('Image Relay paid task reservations', () => {
  test('enforces physical account and owner-across-provider daily caps from a persisted reservation', async () => {
    const relay = createRelayFetch({
      env: env({ RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '20', RELAY_OPENAI_DAILY_USD_MINOR_LIMIT: '14' }),
      identityFetchImpl: identityFetch,
      fetchImpl: async () => Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }),
    })
    const accepted = await relay(request('desktop-a', 'openai-first'))
    const first = await accepted.json() as { task_id: string }
    expect((await waitTerminal(relay, first.task_id)).status).toBe('succeeded')
    expect((await relay(request('desktop-b', 'openai-account-cap'))).status).toBe(429)
    expect((await relay(request('desktop-a', 'seedream-owner-cap', 'doubao-seedream-4-5-251128'))).status).toBe(429)
  })

  test('releases an explicit rejected request but preserves an indeterminate upstream outcome', async () => {
    let calls = 0
    const relay = createRelayFetch({
      env: env({ RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '14' }),
      identityFetchImpl: identityFetch,
      fetchImpl: async () => {
        calls += 1
        if (calls === 1) return new Response('{"error":"bad request"}', { status: 400 })
        if (calls === 3) throw new Error('connection lost')
        return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
      },
    })
    const rejected = await relay(request('desktop-a', 'known-rejected'))
    expect((await waitTerminal(relay, (await rejected.json() as { task_id: string }).task_id)).status).toBe('failed')
    expect((await relay(request('desktop-a', 'released-retry'))).status).toBe(202)
    const unknown = await relay(request('desktop-b', 'unknown-outcome'))
    expect((await waitTerminal(relay, (await unknown.json() as { task_id: string }).task_id, 'desktop-b')).status).toBe('failed_unknown')
    expect((await relay(request('desktop-b', 'must-remain-reserved'))).status).toBe(429)
  })

  test('stores three direct candidates separately and rejects a saturated delivery gate before another output read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-image-relay-quota-'))
    try {
      let providerCalls = 0
      const relay = createRelayFetch({
        env: env({
          RELAY_DB: join(root, 'relay.db'),
          RELAY_BLOB_DIR: join(root, 'blobs'),
          RELAY_RESULT_GLOBAL_CONC: '1',
          RELAY_RESULT_OWNER_CONC: '1',
        }),
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerCalls += 1
          return Response.json({ data: ['aGVsbG8=', 'aGVsbG8h', 'aGVsbG8i'].map(b64_json => ({ b64_json })) })
        },
      })
      const submitted = await relay(request('desktop-a', 'three-output-direct', 'gpt-image-2', 3))
      const task = await submitted.json() as { task_id: string }
      await waitTerminal(relay, task.task_id)
      const plainPoll = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, { headers: { Authorization: 'Bearer desktop-a' } }))
      expect(await plainPoll.json()).toMatchObject({ metadata_only: true, result_available: true, output_count: 3 })
      const handoff = await relay(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, {
        headers: { Authorization: 'Bearer desktop-a', 'X-BB-Media-Result-Handoff': 'direct-v1' },
      }))
      const body = await handoff.json() as { result_urls: string[] }
      expect(body.result_urls).toHaveLength(3)
      expect(existsSync(join(root, 'blobs', `${task.task_id}.out.manifest.json`))).toBe(true)
      expect(existsSync(join(root, 'blobs', `${task.task_id}.out.0.json`))).toBe(true)
      expect(existsSync(join(root, 'blobs', `${task.task_id}.out.json`))).toBe(false)
      const manifest = readFileSync(join(root, 'blobs', `${task.task_id}.out.manifest.json`), 'utf8')
      const path = (url: string) => new URL(url).pathname.replace('/image-generation', '')
      const first = await relay(new Request(`https://relay.example.test${path(body.result_urls[0]!)}`, { headers: { Authorization: 'Bearer desktop-a' } }))
      expect(first.status).toBe(200)
      // Corrupting an unread candidate after the first response holds the sole
      // permit proves the fast 429 occurs before outputAt/readFileSync.
      rmSync(join(root, 'blobs', `${task.task_id}.out.1.json`), { force: true })
      const saturated = await relay(new Request(`https://relay.example.test${path(body.result_urls[1]!)}`, { headers: { Authorization: 'Bearer desktop-a' } }))
      expect(saturated.status).toBe(429)
      await first.text()
      const next = await relay(new Request(`https://relay.example.test${path(body.result_urls[2]!)}`, { headers: { Authorization: 'Bearer desktop-a' } }))
      expect(next.status).toBe(200)
      await next.text()
      const replay = await relay(request('desktop-a', 'three-output-direct', 'gpt-image-2', 3))
      expect(await replay.json()).toMatchObject({ task_id: task.task_id, status: 'succeeded', reused: true })
      expect(providerCalls).toBe(1)
      expect(readFileSync(join(root, 'blobs', `${task.task_id}.out.manifest.json`), 'utf8')).toBe(manifest)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps an earlier Seedream candidate when a later paid call becomes unknown, without replaying the Round', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-image-relay-seedream-partial-'))
    try {
      let providerCalls = 0
      const dbPath = join(root, 'relay.db')
      const relay = createRelayFetch({
        env: env({
          RELAY_DB: dbPath,
          RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '30',
          RELAY_SEEDREAM_DAILY_USD_MINOR_LIMIT: '30',
        }),
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerCalls += 1
          if (providerCalls === 1) return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }, { headers: { 'x-tt-logid': 'seedream-first' } })
          throw new Error('connection dropped after second Seedream request')
        },
      })
      const submitted = await relay(request('desktop-a', 'seedream-partial-unknown', 'doubao-seedream-4-5-251128', 3))
      const task = await submitted.json() as { task_id: string }
      const terminal = await waitTerminal(relay, task.task_id) as {
        status?: string; expected_count?: number; valid_count?: number; invalid?: Array<{ index: number; safe_error_code: string }>; partial_outcome_unknown?: boolean
      }
      expect(terminal).toMatchObject({ status: 'succeeded', expected_count: 3, valid_count: 1, partial_outcome_unknown: true })
      expect(terminal.invalid).toEqual([
        { index: 1, safe_error_code: 'IMAGE_RESULT_OUTCOME_UNKNOWN' },
        { index: 2, safe_error_code: 'IMAGE_PROVIDER_NOT_ATTEMPTED' },
      ])
      expect(providerCalls).toBe(2)
      const replay = await relay(request('desktop-a', 'seedream-partial-unknown', 'doubao-seedream-4-5-251128', 3))
      expect(await replay.json()).toMatchObject({ task_id: task.task_id, reused: true, status: 'succeeded' })
      expect(providerCalls).toBe(2)
      const db = new Database(dbPath)
      try {
        expect(db.query('SELECT state FROM image_quota_reservations WHERE task_id=?').get(task.task_id)).toEqual({ state: 'outcome_unknown' })
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('recovers a manifest-last result after a crash before the terminal SQLite projection without resubmitting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-image-relay-manifest-recovery-'))
    try {
      const dbPath = join(root, 'relay.db')
      const blobDir = join(root, 'blobs')
      let providerCalls = 0
      const first = createRelayFetch({
        env: env({ RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir }),
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerCalls += 1
          return Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }, { headers: { 'x-request-id': 'manifest-first' } })
        },
      })
      const submitted = await first(request('desktop-a', 'manifest-crash-before-sqlite', 'gpt-image-2', 2))
      const task = await submitted.json() as { task_id: string }
      expect(await waitTerminal(first, task.task_id)).toMatchObject({ status: 'succeeded' })
      const manifestPath = join(blobDir, `${task.task_id}.out.manifest.json`)
      const manifest = readFileSync(manifestPath, 'utf8')

      // This is the exact durable state left by a process death between the
      // manifest commit and markSucceeded: provider receipt + input + result,
      // but task metadata still says running.
      const db = new Database(dbPath)
      try {
        db.query('UPDATE tasks SET status=?, error=NULL, result_summary=NULL, acknowledged_at=NULL WHERE id=?').run('running', task.task_id)
      } finally {
        db.close()
      }
      writeFileSync(join(blobDir, `${task.task_id}.in.json`), JSON.stringify({
        mode: 'generate', model: 'gpt-image-2', prompt: 'manifest-crash-before-sqlite', n: 2,
      }), { mode: 0o600 })

      const resumed = createRelayFetch({
        env: env({ RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir }),
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerCalls += 1
          throw new Error('recovery must not resubmit a manifest-backed task')
        },
      })
      const recovered = await resumed(new Request(`https://relay.example.test/v1/images/tasks/${task.task_id}`, {
        headers: { Authorization: 'Bearer desktop-a' },
      }))
      expect(await recovered.json()).toMatchObject({
        status: 'succeeded', expected_count: 2, valid_count: 1, observed_count: 1, partial_outcome_unknown: true,
        invalid: [{ index: 1, safe_error_code: 'IMAGE_RESULT_RECOVERED_UNKNOWN' }],
      })
      expect(providerCalls).toBe(1)
      const replay = await resumed(request('desktop-a', 'manifest-crash-before-sqlite', 'gpt-image-2', 2))
      expect(await replay.json()).toMatchObject({ task_id: task.task_id, status: 'succeeded', reused: true })
      expect(providerCalls).toBe(1)
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps the quota ledger unknown when a later Seedream request is explicitly rejected after a prior receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bb-image-relay-seedream-rejected-'))
    try {
      let providerCalls = 0
      const dbPath = join(root, 'relay.db')
      const relay = createRelayFetch({
        env: env({ RELAY_DB: dbPath }),
        identityFetchImpl: identityFetch,
        fetchImpl: async () => {
          providerCalls += 1
          return providerCalls === 1
            ? Response.json({ data: [{ b64_json: 'aGVsbG8=' }] }, { headers: { 'x-tt-logid': 'seedream-first' } })
            : new Response('{"error":"rejected"}', { status: 400 })
        },
      })
      const submitted = await relay(request('desktop-a', 'seedream-partial-rejected', 'doubao-seedream-4-5-251128', 2))
      const task = await submitted.json() as { task_id: string }
      expect(await waitTerminal(relay, task.task_id)).toMatchObject({ status: 'succeeded', valid_count: 1, partial_outcome_unknown: true })
      expect(providerCalls).toBe(2)
      const db = new Database(dbPath)
      try {
        expect(db.query('SELECT state FROM image_quota_reservations WHERE task_id=?').get(task.task_id)).toEqual({ state: 'outcome_unknown' })
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports OpenAI missing or malformed candidates as a partial succeeded subset, but never succeeds with zero valid bytes', async () => {
    let providerCalls = 0
    const relay = createRelayFetch({
      env: env(),
      identityFetchImpl: identityFetch,
      fetchImpl: async () => {
        providerCalls += 1
        if (providerCalls === 1) return Response.json({
          data: [{ b64_json: 'aGVsbG8=' }, { b64_json: 'not=base64' }],
        }, { headers: { 'x-request-id': 'openai-partial' } })
        return Response.json({ data: [{ b64_json: 'not=base64' }] }, { headers: { 'x-request-id': 'openai-zero' } })
      },
    })
    const partial = await relay(request('desktop-a', 'openai-partial', 'gpt-image-2', 3))
    const partialTask = await partial.json() as { task_id: string }
    const partialTerminal = await waitTerminal(relay, partialTask.task_id) as {
      status?: string; expected_count?: number; valid_count?: number; invalid?: Array<{ index: number; safe_error_code: string }>; partial_outcome_unknown?: boolean
    }
    expect(partialTerminal).toMatchObject({ status: 'succeeded', expected_count: 3, valid_count: 1, partial_outcome_unknown: true })
    expect(partialTerminal.invalid).toEqual([
      { index: 1, safe_error_code: 'IMAGE_RESULT_INVALID' },
      { index: 2, safe_error_code: 'IMAGE_RESULT_MISSING' },
    ])
    const zero = await relay(request('desktop-b', 'openai-zero-valid', 'gpt-image-2', 1))
    const zeroTask = await zero.json() as { task_id: string }
    expect(await waitTerminal(relay, zeroTask.task_id, 'desktop-b')).toMatchObject({ status: 'failed_unknown' })
    expect(providerCalls).toBe(2)
  })

  test('records extra Provider outputs without invalidating a verified requested candidate', async () => {
    const relay = createRelayFetch({
      env: env(),
      identityFetchImpl: identityFetch,
      fetchImpl: async () => Response.json({
        data: [{ b64_json: 'aGVsbG8=' }, { b64_json: 'aGVsbG8h' }],
      }, { headers: { 'x-request-id': 'openai-extra' } }),
    })
    const submitted = await relay(request('desktop-a', 'openai-extra-output', 'gpt-image-2', 1))
    const task = await submitted.json() as { task_id: string }
    const terminal = await waitTerminal(relay, task.task_id) as {
      status?: string; expected_count?: number; valid_count?: number; observed_count?: number; invalid?: unknown[]; partial_outcome_unknown?: boolean
    }
    expect(terminal).toMatchObject({
      status: 'succeeded', expected_count: 1, valid_count: 1, observed_count: 2, invalid: [], partial_outcome_unknown: true,
    })
  })
})
