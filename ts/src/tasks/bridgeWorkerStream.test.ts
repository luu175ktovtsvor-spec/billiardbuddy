import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeRemoteState } from './bridgeRemoteState'
import { BridgeWorkerStream, buildBridgeWorkerStreamUrl, parseBridgeSseFrames } from './bridgeWorkerStream'

function sseStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('parseBridgeSseFrames parses comments, ids, events and multiline data', () => {
  const parsed = parseBridgeSseFrames(':keepalive\n\nid: 7\nevent: client_event\ndata: {\"a\":1}\ndata: {\"b\":2}\n\npartial')
  expect(parsed.frames).toEqual([
    { comment: true },
    { id: '7', event: 'client_event', data: '{"a":1}\n{"b":2}' },
  ])
  expect(parsed.remaining).toBe('partial')
})

test('BridgeWorkerStream consumes client_event SSE frames into remote state and delivery acks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-worker-stream-'))
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const deliveries: Array<{ eventId: string; status: string }> = []
  try {
    const state = new BridgeRemoteState(root)
    const frame = {
      event_id: 'evt_1',
      sequence_num: 7,
      event_type: 'assistant',
      source: 'remote',
      created_at: new Date().toISOString(),
      payload: { type: 'assistant', uuid: 'msg_1', message: { content: [] } },
    }
    const stream = new BridgeWorkerStream({
      sessionId: 'cse_stream',
      apiBaseUrl: 'https://session-ingress.example',
      workerJwt: 'worker.jwt',
      initialSequenceNum: 6,
      reconnectGiveUpMs: 0,
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
        return new Response(sseStream(`id: 7\nevent: client_event\ndata: ${JSON.stringify(frame)}\n\n`), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    }, {
      state,
      worker: { reportDelivery: (eventId, status) => deliveries.push({ eventId, status }) },
    })

    stream.connect()
    const events = await waitFor(async () => {
      const current = await state.listEvents('cse_stream')
      return current.length === 1 ? current : null
    })
    stream.close()
    expect(calls[0]!.url).toBe('https://session-ingress.example/v1/code/sessions/cse_stream/worker/events/stream?from_sequence_num=6')
    expect(calls[0]!.headers).toMatchObject({
      authorization: 'Bearer worker.jwt',
      accept: 'text/event-stream',
      'last-event-id': '6',
    })
    expect(events[0]).toMatchObject({ type: 'assistant', seq: 1 })
    expect(deliveries).toEqual([
      { eventId: 'evt_1', status: 'received' },
      { eventId: 'evt_1', status: 'processed' },
    ])
    expect(stream.getLastSequenceNum()).toBe(7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeWorkerStream closes on permanent auth errors without reconnecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-worker-stream-401-'))
  try {
    const closed: Array<number | undefined> = []
    const stream = new BridgeWorkerStream({
      sessionId: 'cse_stream',
      apiBaseUrl: 'https://session-ingress.example',
      workerJwt: 'worker.jwt',
      reconnectBaseDelayMs: 1,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    }, { state: new BridgeRemoteState(root) }, { onClose: code => closed.push(code) })
    stream.connect()
    await waitFor(async () => closed.length ? closed : null)
    expect(closed).toEqual([401])
    expect(stream.getState()).toBe('closed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildBridgeWorkerStreamUrl mirrors CCR worker events stream URL', () => {
  expect(buildBridgeWorkerStreamUrl('http://127.0.0.1:8850/', 'bridge:cse_1')).toBe('http://127.0.0.1:8850/v1/code/sessions/cse_1/worker/events/stream')
})
