import { expect, test } from 'bun:test'
import { createRelayFetch } from './app'

const B64 = Buffer.from('png-bytes').toString('base64')
const GEN = { mode: 'generate', model: 'gpt-image-2', prompt: 'HTTP burst poster' }

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    RELAY_TOKEN: 'relay-secret',
    RELAY_OPENAI_KEY: 'sk-real',
    RELAY_OPENAI_BASE: 'https://api.openai.example/v1',
    RELAY_QUEUE_MAX: '500',
    RELAY_USER_MAX: '5',
    RELAY_IMG_CONC: '6',
    RELAY_ACTIVE_INPUT_BYTES_MAX: String(1024 * 1024),
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(message)
}

async function mapWithClientConcurrency<T, R>(
  values: readonly T[],
  work: (value: T, index: number) => Promise<R>,
  // Bun's test-client pool drops a full 500-connect SYN burst on macOS before the
  // relay handler runs. Keep the transport test at a reliable 64 connections; the
  // companion hardening test calls the handler with all 500 logical tasks at once.
  limit = 64,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      results[index] = await work(values[index]!, index)
    }
  }))
  return results
}

test('local Bun HTTP relay accepts and polls a 500-task burst over 64 HTTP client connections without exceeding six fake upstream calls', async () => {
  let upstreamCalls = 0
  let releaseUpstream: (() => void) | undefined
  const upstreamGate = new Promise<void>(resolve => { releaseUpstream = resolve })
  const handler = createRelayFetch({
    env: env(),
    fetchImpl: async () => {
      upstreamCalls++
      await upstreamGate
      return Response.json({ data: [{ b64_json: B64 }] })
    },
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  const base = `http://127.0.0.1:${server.port}`

  try {
    const submitted = await mapWithClientConcurrency(Array.from({ length: 500 }), async (_value, index) => {
      const owner = `owner-${Math.floor(index / 5)}`
      const response = await fetch(`${base}/images/tasks`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer relay-secret',
          'content-type': 'application/json',
          'x-relay-owner': owner,
          'idempotency-key': `window-${index % 5}`,
          'x-relay-data-egress-consent': 'a'.repeat(64),
        },
        body: JSON.stringify(GEN),
      })
      expect(response.status).toBe(202)
      const body = await response.json() as { task_id?: string }
      expect(body.task_id).toBeTruthy()
      return { owner, taskId: body.task_id! }
    })

    await waitFor(() => upstreamCalls === 6, 'upstream semaphore did not reach six active calls')
    const beforePoll = await (await fetch(`${base}/healthz`)).json() as Record<string, number>
    expect(beforePoll).toMatchObject({ active: 500, queued: 494, running: 6, img_conc: 6, queue_max: 500, user_max: 5 })

    const polls = await mapWithClientConcurrency(submitted, async task => {
      const response = await fetch(`${base}/images/tasks/${task.taskId}`, {
        headers: { authorization: 'Bearer relay-secret', 'x-relay-owner': task.owner },
      })
      expect(response.status).toBe(200)
      return await response.json() as { status?: string }
    })
    expect(polls.filter(task => task.status === 'running')).toHaveLength(6)
    expect(polls.filter(task => task.status === 'queued')).toHaveLength(494)
  } finally {
    releaseUpstream?.()
    await waitFor(async () => {
      const health = await (await fetch(`${base}/healthz`)).json() as Record<string, number>
      return health.active === 0
    }, 'relay did not drain fake upstream work')
    server.stop(true)
  }
})
