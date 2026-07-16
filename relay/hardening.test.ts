// 私测版加固的假 upstream 证据:幂等、归属绑定+越权 403、队列上限、超大 payload、重启恢复语义。
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayFetch } from './app'

const B64 = Buffer.from('png-bytes').toString('base64')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), 'relay-hard-')); dirs.push(d); return d }

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return { RELAY_TOKEN: 'relay-secret', RELAY_OPENAI_KEY: 'sk-real', RELAY_OPENAI_BASE: 'https://api.openai.example/v1', ...overrides }
}

function submit(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
function poll(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://relay/images/tasks/${id}`, { headers: { authorization: 'Bearer relay-secret', ...headers } })
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))
const GEN = { mode: 'generate', model: 'gpt-image-2', prompt: '海报' }

test('same (owner, Idempotency-Key) resubmit returns the original task_id and runs upstream only once', async () => {
  let calls = 0
  const fetch = createRelayFetch({ env: baseEnv(), fetchImpl: async () => { calls++; return Response.json({ data: [{ b64_json: B64 }] }) } })
  const h = { 'x-relay-owner': 'beta#install-1', 'idempotency-key': 'idem-key-1' }
  const first = await (await fetch(submit(GEN, h))).json()
  await tick()
  const second = await (await fetch(submit(GEN, h))).json()
  expect(second.task_id).toBe(first.task_id)
  expect(second.reused).toBe(true)
  expect(calls).toBe(1) // 重复提交只跑一次真实上游、只扣一次费
})

test('a task bound to an owner rejects cross-owner polling with 403, allows the same owner', async () => {
  const fetch = createRelayFetch({ env: baseEnv(), fetchImpl: async () => Response.json({ data: [{ b64_json: B64 }] }) })
  const { task_id } = await (await fetch(submit(GEN, { 'x-relay-owner': 'ownerA' }))).json()
  expect((await fetch(poll(task_id, { 'x-relay-owner': 'ownerB' }))).status).toBe(403)
  expect((await fetch(poll(task_id))).status).toBe(403) // no owner asserted → can't prove ownership
  expect((await fetch(poll(task_id, { 'x-relay-owner': 'ownerA' }))).status).toBe(200)
})

test('a legacy task (no owner) stays pollable by anyone during the compat window', async () => {
  const fetch = createRelayFetch({ env: baseEnv(), fetchImpl: async () => Response.json({ data: [{ b64_json: B64 }] }) })
  const { task_id } = await (await fetch(submit(GEN))).json() // old gateway: no X-Relay-Owner
  expect((await fetch(poll(task_id))).status).toBe(200)
  expect((await fetch(poll(task_id, { 'x-relay-owner': 'anyone' }))).status).toBe(200)
})

test('global queue cap rejects excess submissions with 429', async () => {
  const fetch = createRelayFetch({ env: baseEnv({ RELAY_QUEUE_MAX: '2' }), fetchImpl: () => new Promise(() => {}) }) // hang → stay active
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'a' }))).status).toBe(202)
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'b' }))).status).toBe(202)
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'c' }))).status).toBe(429)
})

test('per-owner cap rejects a single owner hogging the queue, but other owners still get in', async () => {
  const fetch = createRelayFetch({ env: baseEnv({ RELAY_USER_MAX: '1', RELAY_QUEUE_MAX: '50' }), fetchImpl: () => new Promise(() => {}) })
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'hog' }))).status).toBe(202)
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'hog' }))).status).toBe(429)
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'other' }))).status).toBe(202)
})

test('oversized submit body is rejected with 413 before any work', async () => {
  let calls = 0
  const fetch = createRelayFetch({ env: baseEnv({ RELAY_MAX_BODY_BYTES: '80' }), fetchImpl: async () => { calls++; return Response.json({}) } })
  const big = { mode: 'generate', model: 'gpt-image-2', prompt: 'x'.repeat(500) }
  expect((await fetch(submit(big, { 'x-relay-owner': 'a' }))).status).toBe(413)
  expect(calls).toBe(0)
})

test('restart recovery: running → failed_unknown (no auto-resubmit); queued → resumes and succeeds', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'relay.db')
  const blobDir = join(dir, 'blobs')
  const env = baseEnv({ RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir })

  // Instance 1: upstream hangs → submitted tasks stay 'running' and persist their input blob.
  const hang = createRelayFetch({ env, fetchImpl: () => new Promise(() => {}) })
  const running = await (await hang(submit(GEN, { 'x-relay-owner': 'o' }))).json()
  const willQueue = await (await hang(submit(GEN, { 'x-relay-owner': 'o' }))).json()
  await tick()
  // Simulate a task that was accepted but hadn't started upstream yet at crash time.
  const raw = new Database(dbPath)
  raw.query('UPDATE tasks SET status=? WHERE id=?').run('queued', willQueue.task_id)
  raw.close()

  // "Crash + restart": a fresh instance on the SAME db + blob dir, now with a working upstream.
  const restarted = createRelayFetch({ env, fetchImpl: async () => Response.json({ data: [{ b64_json: B64 }] }) })
  await tick(15) // let the resumed 'queued' task run

  const runningRec = await (await restarted(poll(running.task_id, { 'x-relay-owner': 'o' }))).json()
  expect(runningRec.status).toBe('failed_unknown') // in-flight at crash → not auto-resubmitted (no double charge)

  const resumedRec = await (await restarted(poll(willQueue.task_id, { 'x-relay-owner': 'o' }))).json()
  expect(resumedRec.status).toBe('succeeded') // queued at crash → resumed and completed
  expect(resumedRec.data?.[0]?.b64_json).toBe(B64)
})
