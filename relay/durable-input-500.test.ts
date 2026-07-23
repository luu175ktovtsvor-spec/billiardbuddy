import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayFetch } from './app'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-durable-input-'))
  dirs.push(dir)
  return dir
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(message)
}

test('100 users × 5 moderate edit uploads persist as bounded disk queue input instead of retained request memory', async () => {
  const dir = tempDir()
  const blobDir = join(dir, 'blobs')
  const image = Buffer.alloc(48 * 1024, 7).toString('base64')
  const body = {
    mode: 'edit',
    model: 'gpt-image-2',
    prompt: 'bounded queue image edit',
    images: [`data:image/png;base64,${image}`],
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify(body))
  let upstreamCalls = 0
  let release: (() => void) | undefined
  const upstreamGate = new Promise<void>(resolve => { release = resolve })
  const fetch = createRelayFetch({
    env: {
      RELAY_TOKEN: 'relay-secret',
      RELAY_OPENAI_KEY: 'sk-real',
      RELAY_OPENAI_BASE: 'https://api.openai.example/v1',
      RELAY_DB: join(dir, 'relay.db'),
      RELAY_BLOB_DIR: blobDir,
      RELAY_QUEUE_MAX: '500',
      RELAY_USER_MAX: '5',
      RELAY_IMG_CONC: '6',
    },
    fetchImpl: async () => {
      upstreamCalls++
      await upstreamGate
      return Response.json({ data: [{ b64_json: 'cG5n' }] })
    },
  })

  const submitted = await Promise.all(Array.from({ length: 500 }, async (_value, index) => {
    const owner = `owner-${Math.floor(index / 5)}`
    const response = await fetch(new Request('http://relay/images/tasks', {
      method: 'POST',
      headers: {
        authorization: 'Bearer relay-secret',
        'content-type': 'application/json',
        'x-relay-owner': owner,
        'idempotency-key': `window-${index % 5}`,
        'x-relay-data-egress-consent': 'a'.repeat(64),
      },
      body: JSON.stringify(body),
    }))
    expect(response.status).toBe(202)
    return { owner, taskId: (await response.json() as { task_id: string }).task_id }
  }))

  await waitFor(() => upstreamCalls === 6, 'six upstream image slots did not start')
  const health = await (await fetch(new Request('http://relay/healthz'))).json() as Record<string, number>
  expect(health).toMatchObject({
    active: 500,
    queued: 494,
    running: 6,
    active_input_bytes: bodyBytes * 500,
    pending_input_bytes: 0,
  })

  const queued = await Promise.all(submitted.map(async task => {
    const response = await fetch(new Request(`http://relay/images/tasks/${task.taskId}`, {
      headers: { authorization: 'Bearer relay-secret', 'x-relay-owner': task.owner },
    }))
    const record = await response.json() as { status: string }
    return { ...task, status: record.status }
  }))
  await Promise.all(queued.filter(task => task.status === 'queued').map(task => fetch(new Request(
    `http://relay/images/tasks/${task.taskId}/cancel`,
    { method: 'POST', headers: { authorization: 'Bearer relay-secret', 'x-relay-owner': task.owner } },
  ))))

  release?.()
  await waitFor(async () => (await (await fetch(new Request('http://relay/healthz'))).json() as { active: number }).active === 0, 'relay did not drain the disk-backed burst')
})
