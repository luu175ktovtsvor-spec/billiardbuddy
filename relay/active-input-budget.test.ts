import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayFetch } from './app'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-input-budget-'))
  dirs.push(dir)
  return dir
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    RELAY_TOKEN: 'relay-secret',
    RELAY_OPENAI_KEY: 'sk-real',
    RELAY_OPENAI_BASE: 'https://api.openai.example/v1',
    ...overrides,
  }
}

function health(fetch: (request: Request) => Promise<Response>) {
  return fetch(new Request('http://relay/healthz')).then(response => response.json()) as Promise<Record<string, number>>
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(message)
}

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(next) { controller = next } })
  return {
    body,
    write(bytes: Uint8Array) { controller.enqueue(bytes) },
    close() { controller.close() },
  }
}

function streamedSubmit(body: ReadableStream<Uint8Array>) {
  return new Request('http://relay/images/tasks', {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body,
  })
}

test('reserves chunked request bytes before task admission so concurrent uploads cannot overshoot the active input budget', async () => {
  const payload = new TextEncoder().encode(JSON.stringify({ mode: 'generate', prompt: 'x'.repeat(256) }))
  const fetch = createRelayFetch({
    env: env({ RELAY_ACTIVE_INPUT_BYTES_MAX: String(payload.byteLength * 2 - 1) }),
    fetchImpl: () => new Promise(() => {}),
  })
  const first = controlledStream()
  const firstResponse = fetch(streamedSubmit(first.body))
  first.write(payload)

  await waitFor(async () => (await health(fetch)).pending_input_bytes === payload.byteLength, 'first request did not reserve input bytes')
  expect(await health(fetch)).toMatchObject({
    active: 0,
    active_input_bytes: 0,
    pending_input_bytes: payload.byteLength,
    active_input_bytes_available: payload.byteLength - 1,
  })

  const second = controlledStream()
  const secondResponse = fetch(streamedSubmit(second.body))
  second.write(payload)
  second.close()
  const denied = await secondResponse
  expect(denied.status).toBe(429)
  expect(denied.headers.get('retry-after')).toBe('30')
  expect(await health(fetch)).toMatchObject({ pending_input_bytes: payload.byteLength })

  first.close()
  expect((await firstResponse).status).toBe(202)
  await waitFor(async () => (await health(fetch)).active === 1, 'admitted task was not persisted')
  expect(await health(fetch)).toMatchObject({
    active: 1,
    active_input_bytes: payload.byteLength,
    pending_input_bytes: 0,
  })
})

test('caps simultaneous chunked uploads below the larger durable queue budget', async () => {
  const payload = new TextEncoder().encode(JSON.stringify({ mode: 'generate', prompt: 'x'.repeat(256) }))
  const fetch = createRelayFetch({
    env: env({
      RELAY_ACTIVE_INPUT_BYTES_MAX: String(payload.byteLength * 4),
      RELAY_PENDING_INPUT_BYTES_MAX: String(payload.byteLength * 2 - 1),
    }),
    fetchImpl: () => new Promise(() => {}),
  })
  const first = controlledStream()
  const firstResponse = fetch(streamedSubmit(first.body))
  first.write(payload)
  await waitFor(async () => (await health(fetch)).pending_input_bytes === payload.byteLength, 'first upload did not reserve pending bytes')

  const second = controlledStream()
  const secondResponse = fetch(streamedSubmit(second.body))
  second.write(payload)
  second.close()
  const denied = await secondResponse
  expect(denied.status).toBe(429)
  expect((await denied.json() as { error?: string }).error).toContain('同时上传')
  expect(await health(fetch)).toMatchObject({
    pending_input_bytes: payload.byteLength,
    pending_input_bytes_max: payload.byteLength * 2 - 1,
  })

  first.close()
  expect((await firstResponse).status).toBe(202)
})

test('migrates a pre-budget queued task database and accounts its recovered input bytes', async () => {
  const dir = tempDir()
  const dbPath = join(dir, 'relay.db')
  const blobDir = join(dir, 'blobs')
  const db = new Database(dbPath)
  db.exec(
    'CREATE TABLE tasks(' +
    'id TEXT PRIMARY KEY, owner TEXT, idempotency_key TEXT, status TEXT NOT NULL, ' +
      'error TEXT, input_fidelity TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
  )
  const body = { mode: 'generate', prompt: 'migration payload' }
  const bytes = Buffer.byteLength(JSON.stringify(body))
  const taskId = 'legacy-queued'
  db.query('INSERT INTO tasks(id,owner,idempotency_key,status,error,input_fidelity,created,updated) VALUES(?,?,?,?,?,?,?,?)')
    .run(taskId, 'legacy-owner', 'legacy-key', 'queued', null, null, Date.now(), Date.now())
  db.close()
  mkdirSync(blobDir, { recursive: true })
  writeFileSync(join(blobDir, `${taskId}.in.json`), JSON.stringify(body))

  const recovered = createRelayFetch({
    env: env({ RELAY_DB: dbPath, RELAY_BLOB_DIR: blobDir }),
    fetchImpl: () => new Promise(() => {}),
  })
  await waitFor(async () => (await health(recovered)).active === 1, 'legacy queued task was not resumed')
  expect(await health(recovered)).toMatchObject({ active: 1, active_input_bytes: bytes })

  const migrated = new Database(dbPath)
  const columns = migrated.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  expect(columns.some(column => column.name === 'input_bytes')).toBe(true)
  const row = migrated.query("SELECT input_bytes FROM tasks WHERE id=?").get(taskId) as { input_bytes: number }
  expect(row.input_bytes).toBe(bytes)
  migrated.close()
})
