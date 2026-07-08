import { expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { createReceiverFetch, gunzipBounded } from '../receiver/app'
import { safeComponent, type BatchItem } from '../receiver/db'

function gzipJson(body: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(body), 'utf8'))
}

function makeReceiver(env: Record<string, string | undefined> = { INGEST_TOKENS: 'tok-a,tok-b' }) {
  const calls: Array<[unknown, BatchItem[]]> = []
  const fetch = createReceiverFetch({
    env,
    insertBatch: async (machineId, batch) => {
      calls.push([machineId, batch])
      return [batch.length, 0]
    },
  })
  return { fetch, calls, env }
}

const gzipHeaders = {
  'Content-Encoding': 'gzip',
  'Content-Type': 'application/json',
}

test('health returns ok', async () => {
  const { fetch } = makeReceiver()
  const res = await fetch(new Request('http://local/health'))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
})

test('missing bearer returns 401 and skips storage', async () => {
  const { fetch, calls } = makeReceiver()
  const res = await fetch(new Request('http://local/ingest', {
    method: 'POST',
    headers: gzipHeaders,
    body: gzipJson({ machine_id: 'm1', batch: [] }),
  }))
  expect(res.status).toBe(401)
  expect(calls).toEqual([])
})

test('wrong token returns 401 and skips storage', async () => {
  const { fetch, calls } = makeReceiver()
  const res = await fetch(new Request('http://local/ingest', {
    method: 'POST',
    headers: { ...gzipHeaders, Authorization: 'Bearer nope' },
    body: gzipJson({ machine_id: 'm1', batch: [] }),
  }))
  expect(res.status).toBe(401)
  expect(calls).toEqual([])
})

test('revoked token stops working without recreating handler', async () => {
  const { fetch, env } = makeReceiver()
  env.INGEST_TOKENS = 'tok-b'
  const res = await fetch(new Request('http://local/ingest', {
    method: 'POST',
    headers: { ...gzipHeaders, Authorization: 'Bearer tok-a' },
    body: gzipJson({ machine_id: 'm1', batch: [] }),
  }))
  expect(res.status).toBe(401)
})

test('valid token gzip body returns accepted counts and forwards batch', async () => {
  const { fetch, calls } = makeReceiver()
  const batch = [
    { kind: 'event', ref_id: 'e1', payload: { id: 'e1', event: 'agent_chat', props: {}, created_at: null } },
    { kind: 'gen', ref_id: 'g1', payload: { id: 'g1', store_id: 's1', type: 'image', tokens_used: 100 } },
  ]
  const res = await fetch(new Request('http://local/ingest', {
    method: 'POST',
    headers: { ...gzipHeaders, Authorization: 'Bearer tok-a' },
    body: gzipJson({ machine_id: 'machine-abc', batch }),
  }))

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ accepted: 2, duplicated: 0 })
  expect(calls).toEqual([['machine-abc', batch]])
})

test('empty batch is valid', async () => {
  const { fetch } = makeReceiver()
  const res = await fetch(new Request('http://local/ingest', {
    method: 'POST',
    headers: { ...gzipHeaders, Authorization: 'Bearer tok-b' },
    body: gzipJson({ machine_id: 'm1', batch: [] }),
  }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ accepted: 0, duplicated: 0 })
})

test.each(['../etc/passwd', '..', 'a/b', 'a\\b', '', null, 'x/../y', 'foo/'])('safeComponent rejects %p', bad => {
  expect(() => safeComponent(bad, 'conversation_id')).toThrow()
})

test.each(['conv-1', 'abc_123', 'a.b-c', 'smoke-machine-1'])('safeComponent allows %p', good => {
  expect(safeComponent(good, 'x')).toBe(good)
})

test('gunzipBounded rejects decompressed bodies over limit', async () => {
  await expect(gunzipBounded(gzipSync(Buffer.alloc(10_000, 'A')), 100)).rejects.toMatchObject({ status: 413 })
})

test('gunzipBounded accepts bodies under limit', async () => {
  const data = Buffer.from('{"machine_id":"m","batch":[]}', 'utf8')
  expect(await gunzipBounded(gzipSync(data))).toEqual(data)
})

test('plain json body is accepted without gzip header', async () => {
  const { fetch } = makeReceiver()
  const res = await fetch(new Request('http://local/ingest', {
    method: 'POST',
    headers: { Authorization: 'Bearer tok-a', 'Content-Type': 'application/json' },
    body: JSON.stringify({ machine_id: 'm2', batch: [] }),
  }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ accepted: 0, duplicated: 0 })
})
