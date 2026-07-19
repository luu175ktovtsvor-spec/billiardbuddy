// 私测版加固的假 upstream 证据:幂等、归属绑定+越权 403、队列上限、超大 payload、重启恢复语义。
import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayFetch, loadRelayConfig } from './app'

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

function chunkedSubmit(raw: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(raw)
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(bytes.byteLength, offset + 7)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
  return new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json', ...headers },
    body,
  })
}
function poll(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://relay/images/tasks/${id}`, { headers: { authorization: 'Bearer relay-secret', ...headers } })
}
function cancel(id: string, headers: Record<string, string> = {}) {
  return new Request(`http://relay/images/tasks/${id}/cancel`, {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', ...headers },
  })
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))
const GEN = { mode: 'generate', model: 'gpt-image-2', prompt: '海报' }

async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return
    await tick(2)
  }
  throw new Error(message)
}

test('capacity defaults admit the 100 users × 5 windows burst without increasing paid upstream concurrency', () => {
  const config = loadRelayConfig(baseEnv())
  expect(config.queueMax).toBe(600)
  expect(config.userMax).toBe(5)
  expect(config.imgConc).toBe(6)
  expect(config.imgUserConc).toBe(1)
  expect(config.retryAfterSeconds).toBe(30)
  expect(config.activeInputBytesMax).toBe(512 * 1024 * 1024)
  expect(config.pendingInputBytesMax).toBe(64 * 1024 * 1024)

  const malformed = loadRelayConfig(baseEnv({
    RELAY_IMG_CONC: 'not-a-number',
    RELAY_IMG_USER_CONC: 'not-a-number',
    RELAY_RETRY_AFTER_SECONDS: '-1',
    RELAY_PENDING_INPUT_BYTES_MAX: 'not-a-number',
  }))
  expect(malformed.imgConc).toBe(6)
  expect(malformed.imgUserConc).toBe(1)
  expect(malformed.retryAfterSeconds).toBe(1)
  expect(malformed.pendingInputBytesMax).toBe(64 * 1024 * 1024)
})

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

test('concurrent same-key submits dedup to one task and one upstream call — even with no owner', async () => {
  let calls = 0
  const fetch = createRelayFetch({ env: baseEnv(), fetchImpl: async () => { calls++; return Response.json({ data: [{ b64_json: B64 }] }) } })
  // Legacy path: NO X-Relay-Owner (owner='' sentinel) + same Idempotency-Key, fired truly concurrently.
  const h = { 'idempotency-key': 'concurrent-key' }
  const [r1, r2] = await Promise.all([
    fetch(submit(GEN, h)).then(r => r.json()),
    fetch(submit(GEN, h)).then(r => r.json()),
  ])
  expect(r1.task_id).toBe(r2.task_id) // both callers get the same task
  await tick(10)
  expect(calls).toBe(1) // only one real upstream task despite concurrent duplicate submits
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
  const capped = await fetch(submit(GEN, { 'x-relay-owner': 'hog' }))
  expect(capped.status).toBe(429)
  expect(capped.headers.get('retry-after')).toBe('30')
  expect((await fetch(submit(GEN, { 'x-relay-owner': 'other' }))).status).toBe(202)
})

test('running image slots stay fair across owners while each owner keeps five queued windows', async () => {
  const started: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_IMG_CONC: '2', RELAY_IMG_USER_CONC: '1', RELAY_USER_MAX: '5' }),
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { prompt?: string }
      started.push(payload.prompt ?? '')
      await gate
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })

  for (let index = 0; index < 5; index++) {
    expect((await fetch(submit({ ...GEN, prompt: `owner-a-window-${index}` }, { 'x-relay-owner': 'owner-a' }))).status).toBe(202)
  }
  expect((await fetch(submit({ ...GEN, prompt: 'owner-b-window-0' }, { 'x-relay-owner': 'owner-b' }))).status).toBe(202)

  await waitFor(() => started.length === 2, 'two paid image slots did not start')
  expect(started).toContain('owner-a-window-0')
  expect(started).toContain('owner-b-window-0')

  release?.()
  await waitFor(async () => (await (await fetch(new Request('http://relay/healthz'))).json() as { active: number }).active === 0, 'fair queue did not drain')
})

test('cancels only queued work before the upstream request starts', async () => {
  let upstreamCalls = 0
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_IMG_CONC: '1' }),
    fetchImpl: () => {
      upstreamCalls++
      return new Promise(() => {})
    },
  })
  const owner = { 'x-relay-owner': 'cancel-owner' }
  const running = await (await fetch(submit(GEN, owner))).json()
  const queued = await (await fetch(submit(GEN, owner))).json()
  await tick()

  expect((await fetch(cancel(running.task_id, owner))).status).toBe(409)
  const cancelled = await (await fetch(cancel(queued.task_id, owner))).json()
  expect(cancelled.status).toBe('cancelled')
  expect((await (await fetch(poll(queued.task_id, owner))).json()).status).toBe('cancelled')
  expect(upstreamCalls).toBe(1)
})

test('oversized submit body is rejected with 413 before any work', async () => {
  let calls = 0
  const fetch = createRelayFetch({ env: baseEnv({ RELAY_MAX_BODY_BYTES: '80' }), fetchImpl: async () => { calls++; return Response.json({}) } })
  const big = { mode: 'generate', model: 'gpt-image-2', prompt: 'x'.repeat(500) }
  expect((await fetch(submit(big, { 'x-relay-owner': 'a' }))).status).toBe(413)
  expect(calls).toBe(0)
})

test('active image input byte budget rejects a second large queued payload with Retry-After', async () => {
  const body = { ...GEN, prompt: 'x'.repeat(80) }
  const bytes = Buffer.byteLength(JSON.stringify(body))
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_QUEUE_MAX: '10', RELAY_ACTIVE_INPUT_BYTES_MAX: String(bytes * 2 - 1) }),
    fetchImpl: () => new Promise(() => {}),
  })
  expect((await fetch(submit(body, { 'x-relay-owner': 'first' }))).status).toBe(202)
  const denied = await fetch(submit(body, { 'x-relay-owner': 'second' }))
  expect(denied.status).toBe(429)
  expect(denied.headers.get('retry-after')).toBe('30')
  const health = await (await fetch(new Request('http://relay/healthz'))).json() as Record<string, number>
  expect(health).toMatchObject({
    active: 1,
    active_input_bytes: bytes,
    pending_input_bytes: 0,
    active_input_bytes_max: bytes * 2 - 1,
  })
})

test('chunked submit reservations release after malformed and idempotent early-return paths', async () => {
  const body = { ...GEN, prompt: 'x'.repeat(80) }
  const raw = JSON.stringify(body)
  const bytes = Buffer.byteLength(raw)
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_QUEUE_MAX: '10', RELAY_ACTIVE_INPUT_BYTES_MAX: String(bytes * 3) }),
    fetchImpl: () => new Promise(() => {}),
  })
  const headers = { 'x-relay-owner': 'chunked-owner', 'idempotency-key': 'chunked-key' }
  expect((await fetch(chunkedSubmit(raw, headers))).status).toBe(202)
  const duplicate = await fetch(chunkedSubmit(raw, headers))
  expect(duplicate.status).toBe(202)
  expect((await duplicate.json() as { reused?: boolean }).reused).toBe(true)
  expect((await fetch(chunkedSubmit('{not json', { 'x-relay-owner': 'bad-body' }))).status).toBe(400)

  const health = await (await fetch(new Request('http://relay/healthz'))).json() as Record<string, number>
  expect(health).toMatchObject({ active: 1, active_input_bytes: bytes, pending_input_bytes: 0 })
})

test('TTL cleanup keeps active work and only removes old terminal results', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'relay.db')
  let now = 1_000
  const env = baseEnv({ RELAY_DB: dbPath, RELAY_TASK_TTL_MS: '100' })
  const fetch = createRelayFetch({
    env,
    now: () => now,
    fetchImpl: () => new Promise(() => {}),
  })
  const active = await (await fetch(submit(GEN))).json()
  await tick()

  const db = new Database(dbPath)
  db.query("INSERT INTO tasks(id,owner,idempotency_key,status,error,input_fidelity,created,updated) VALUES(?,?,?,?,?,?,?,?)")
    .run('old-terminal', '', null, 'succeeded', null, null, 1_000, 1_000)
  db.close()
  now = 1_500

  expect((await fetch(poll(active.task_id))).status).toBe(200)
  expect((await fetch(poll('old-terminal'))).status).toBe(404)
})

test('terminal tasks delete sensitive input blobs while retaining pollable output', async () => {
  const dir = tempDir()
  const blobDir = join(dir, 'blobs')
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_BLOB_DIR: blobDir }),
    fetchImpl: async () => Response.json({ data: [{ b64_json: B64 }] }),
  })
  const { task_id } = await (await fetch(submit({ ...GEN, images: [`data:image/png;base64,${B64}`] }))).json()
  await tick(10)
  const record = await (await fetch(poll(task_id))).json()
  expect(record.status).toBe('succeeded')
  expect(readdirSync(blobDir).sort()).toEqual([`${task_id}.out.json`])
})

test('a queued disk input is read only after it obtains an upstream slot', async () => {
  const dir = tempDir()
  const blobDir = join(dir, 'blobs')
  const started: string[] = []
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_BLOB_DIR: blobDir, RELAY_IMG_CONC: '1' }),
    fetchImpl: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { prompt?: string }
      started.push(payload.prompt ?? '')
      await gate
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })

  expect((await fetch(submit({ ...GEN, prompt: 'first' }, { 'x-relay-owner': 'first-owner' }))).status).toBe(202)
  const queued = await (await fetch(submit({ ...GEN, prompt: 'stale-in-memory-copy' }, { 'x-relay-owner': 'second-owner' }))).json() as { task_id: string }
  await waitFor(() => started.length === 1, 'first task did not occupy the only upstream slot')

  writeFileSync(join(blobDir, `${queued.task_id}.in.json`), JSON.stringify({ ...GEN, prompt: 'loaded-at-execution' }))
  release?.()
  await waitFor(() => started.length === 2, 'queued task did not start after the slot freed')
  expect(started).toEqual(['first', 'loaded-at-execution'])
})

test('a successful provider result that cannot be persisted remains failed_unknown, never retry-safe failed', async () => {
  const dir = tempDir()
  const blobDir = join(dir, 'blobs')
  let started = false
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetch = createRelayFetch({
    env: baseEnv({ RELAY_BLOB_DIR: blobDir }),
    fetchImpl: async () => {
      started = true
      await gate
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  const submitted = await (await fetch(submit(GEN, { 'x-relay-owner': 'storage-owner' }))).json() as { task_id: string }
  await waitFor(() => started, 'upstream did not start')
  rmSync(blobDir, { recursive: true, force: true })
  release?.()

  await waitFor(async () => {
    const response = await fetch(poll(submitted.task_id, { 'x-relay-owner': 'storage-owner' }))
    const body = await response.json() as { status?: string }
    return body.status === 'failed_unknown'
  }, 'storage failure was not recorded as failed_unknown')
  const record = await (await fetch(poll(submitted.task_id, { 'x-relay-owner': 'storage-owner' }))).json() as { status?: string; error?: string }
  expect(record.status).toBe('failed_unknown')
  expect(record.error).toContain('无法持久化结果')
})

test('restart recovery: running → failed_unknown (no auto-resubmit); queued → resumes and succeeds', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'relay.db')
  const blobDir = join(dir, 'blobs')
  const env = baseEnv({ RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir, RELAY_IMG_CONC: '1' })

  // Instance 1: the first real upstream call occupies the only concurrency slot.
  let hangingCalls = 0
  const hang = createRelayFetch({
    env,
    fetchImpl: () => {
      hangingCalls++
      return new Promise(() => {})
    },
  })
  const running = await (await hang(submit(GEN, { 'x-relay-owner': 'o' }))).json()
  const willQueue = await (await hang(submit(GEN, { 'x-relay-owner': 'o' }))).json()
  await tick()

  const beforeRestartRunning = await (await hang(poll(running.task_id, { 'x-relay-owner': 'o' }))).json()
  const beforeRestartQueued = await (await hang(poll(willQueue.task_id, { 'x-relay-owner': 'o' }))).json()
  expect(beforeRestartRunning.status).toBe('running')
  expect(beforeRestartQueued.status).toBe('queued')
  expect(hangingCalls).toBe(1)

  const completedBeforeCrash = 'completed-before-status'
  const db = new Database(dbPath)
  db.query("INSERT INTO tasks(id,owner,idempotency_key,status,error,input_fidelity,created,updated) VALUES(?,?,?,?,?,?,?,?)")
    .run(completedBeforeCrash, 'o', null, 'running', null, null, Date.now(), Date.now())
  db.close()
  writeFileSync(join(blobDir, `${completedBeforeCrash}.out.json`), JSON.stringify({ data: [{ b64_json: B64 }] }))

  // "Crash + restart": a fresh instance on the SAME db + blob dir, now with a working upstream.
  let resumedCalls = 0
  const restarted = createRelayFetch({
    env,
    fetchImpl: async () => {
      resumedCalls++
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  await tick(15) // let the resumed 'queued' task run

  const runningRec = await (await restarted(poll(running.task_id, { 'x-relay-owner': 'o' }))).json()
  expect(runningRec.status).toBe('failed_unknown') // in-flight at crash → not auto-resubmitted (no double charge)

  const completedRec = await (await restarted(poll(completedBeforeCrash, { 'x-relay-owner': 'o' }))).json()
  expect(completedRec.status).toBe('succeeded')
  expect(completedRec.data?.[0]?.b64_json).toBe(B64)

  const resumedRec = await (await restarted(poll(willQueue.task_id, { 'x-relay-owner': 'o' }))).json()
  expect(resumedRec.status).toBe('succeeded') // queued at crash → resumed and completed
  expect(resumedRec.data?.[0]?.b64_json).toBe(B64)
  expect(resumedCalls).toBe(1)
})

test('500 concurrent image submissions and polls stay bounded, dedup retries, shed overflow, cancel queued work, and drain cleanly', async () => {
  let upstreamCalls = 0
  let releaseUpstream: (() => void) | undefined
  const upstreamGate = new Promise<void>(resolve => { releaseUpstream = resolve })
  const fetch = createRelayFetch({
    env: baseEnv({
      RELAY_QUEUE_MAX: '500',
      RELAY_USER_MAX: '5',
      RELAY_IMG_CONC: '6',
      RELAY_RETRY_AFTER_SECONDS: '17',
      RELAY_ACTIVE_INPUT_BYTES_MAX: '1048576',
    }),
    fetchImpl: async () => {
      upstreamCalls++
      await upstreamGate
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })

  const windows = Array.from({ length: 500 }, (_, index) => ({
    owner: `owner-${Math.floor(index / 5)}`,
    key: `window-${index % 5}`,
  }))
  const submitted = await Promise.all(windows.map(async window => {
    const response = await fetch(submit(GEN, {
      'x-relay-owner': window.owner,
      'idempotency-key': window.key,
    }))
    expect(response.status).toBe(202)
    const body = await response.json() as { task_id?: string }
    expect(body.task_id).toBeTruthy()
    return { ...window, taskId: body.task_id! }
  }))

  await waitFor(() => upstreamCalls === 6, 'upstream semaphore did not reach its configured limit')
  const initialHealth = await (await fetch(new Request('http://relay/healthz'))).json() as Record<string, number>
  expect(initialHealth).toMatchObject({
    active: 500,
    queued: 494,
    running: 6,
    queue_available: 0,
    pending_input_bytes: 0,
    active_input_bytes_max: 1048576,
    img_conc: 6,
    queue_max: 500,
    user_max: 5,
    retry_after_seconds: 17,
  })

  const polled = await Promise.all(submitted.map(async submittedTask => {
    const response = await fetch(poll(submittedTask.taskId, { 'x-relay-owner': submittedTask.owner }))
    expect(response.status).toBe(200)
    const body = await response.json() as { status?: string }
    return { ...submittedTask, status: body.status }
  }))
  expect(polled.filter(task => task.status === 'running')).toHaveLength(6)
  expect(polled.filter(task => task.status === 'queued')).toHaveLength(494)

  // A duplicate retry stays admissible even when the queue is full: it returns the persisted task
  // rather than consuming a new slot or a second paid upstream request.
  const reused = await Promise.all(submitted.map(async submittedTask => {
    const response = await fetch(submit(GEN, {
      'x-relay-owner': submittedTask.owner,
      'idempotency-key': submittedTask.key,
    }))
    expect(response.status).toBe(202)
    const body = await response.json() as { task_id?: string; reused?: boolean }
    return { ...body, expectedTaskId: submittedTask.taskId }
  }))
  expect(reused.every(task => task.reused && task.task_id === task.expectedTaskId)).toBe(true)
  expect(upstreamCalls).toBe(6)

  const overflow = await fetch(submit(GEN, {
    'x-relay-owner': 'owner-overflow',
    'idempotency-key': 'overflow-window',
  }))
  expect(overflow.status).toBe(429)
  expect(overflow.headers.get('retry-after')).toBe('17')
  expect(overflow.headers.get('cache-control')).toBe('no-store')

  const queued = polled.filter(task => task.status === 'queued')
  const cancelled = await Promise.all(queued.map(async queuedTask => {
    const response = await fetch(cancel(queuedTask.taskId, { 'x-relay-owner': queuedTask.owner }))
    expect(response.status).toBe(200)
    return await response.json() as { status?: string }
  }))
  expect(cancelled.every(task => task.status === 'cancelled')).toBe(true)

  releaseUpstream?.()
  await waitFor(async () => {
    const health = await (await fetch(new Request('http://relay/healthz'))).json() as Record<string, number>
    return health.active === 0 && health.queued === 0 && health.running === 0 && health.active_input_bytes === 0 && health.pending_input_bytes === 0
  }, 'terminal tasks were left in the active queue')
  expect(upstreamCalls).toBe(6)

  const terminal = await Promise.all(submitted.map(async submittedTask => {
    const response = await fetch(poll(submittedTask.taskId, { 'x-relay-owner': submittedTask.owner }))
    return await response.json() as { status?: string }
  }))
  expect(terminal.filter(task => task.status === 'succeeded')).toHaveLength(6)
  expect(terminal.filter(task => task.status === 'cancelled')).toHaveLength(494)
})
