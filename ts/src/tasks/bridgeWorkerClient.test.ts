import { expect, test } from 'bun:test'
import { BridgeWorkerClient, buildBridgeWorkerSessionUrl } from './bridgeWorkerClient'

function makeClient(calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }>, responseFor?: (url: string, init?: RequestInit) => Response) {
  return new BridgeWorkerClient({
    sessionId: 'cse_worker',
    credentials: {
      workerJwt: 'worker.jwt',
      apiBaseUrl: 'https://session-ingress.example',
      workerEpoch: 11,
    },
    heartbeatIntervalMs: 60_000,
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return responseFor?.(String(input), init) ?? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
}

test('buildBridgeWorkerSessionUrl mirrors CCR v2 code-session URL shape', () => {
  expect(buildBridgeWorkerSessionUrl('https://session-ingress.example/', 'bridge:cse_123')).toBe('https://session-ingress.example/v1/code/sessions/cse_123')
})

test('BridgeWorkerClient initializes worker, sends heartbeat, state, events and delivery updates', async () => {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  const client = makeClient(calls)

  expect(await client.initialize()).toMatchObject({ ok: true, status: 200 })
  await client.sendHeartbeatNow()
  client.reportState('requires_action', {
    tool_name: 'Write',
    action_description: 'Editing src/app.ts',
    tool_use_id: 'toolu_1',
    request_id: 'req_1',
    input: { file_path: 'src/app.ts' },
  })
  client.reportMetadata({ model: 'kimi-k2' })
  await client.writeEvent({ type: 'assistant', session_id: 'cse_worker', parent_tool_use_id: null, message: { id: 'msg_1' } })
  await client.writeInternalEvent('transcript_entry', { uuid: 'int_1', role: 'assistant' }, { agentId: 'agent_1' })
  client.reportDelivery('evt_1', 'processed')
  await client.flush()
  client.close()

  expect(calls[0]).toMatchObject({
    url: 'https://session-ingress.example/v1/code/sessions/cse_worker/worker',
    method: 'PUT',
    body: {
      worker_status: 'idle',
      worker_epoch: 11,
      external_metadata: { pending_action: null, task_summary: null },
    },
    headers: expect.objectContaining({
      authorization: 'Bearer worker.jwt',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
  })
  expect(calls.some(call => call.url.endsWith('/worker/heartbeat') && call.body.worker_epoch === 11 && call.body.session_id === 'cse_worker')).toBe(true)
  expect(calls.some(call => call.url.endsWith('/worker') && call.body.worker_status === 'requires_action' && call.body.requires_action_details.request_id === 'req_1')).toBe(true)
  expect(calls.some(call => call.url.endsWith('/worker') && call.body.external_metadata.model === 'kimi-k2')).toBe(true)
  expect(calls.some(call => call.url.endsWith('/worker/events') && call.body.events[0].payload.type === 'assistant' && call.body.events[0].payload.uuid)).toBe(true)
  expect(calls.some(call => call.url.endsWith('/worker/internal-events') && call.body.events[0].agent_id === 'agent_1')).toBe(true)
  expect(calls.some(call => call.url.endsWith('/worker/events/delivery') && call.body.updates[0].event_id === 'evt_1' && call.body.updates[0].status === 'processed')).toBe(true)
})

test('BridgeWorkerClient coalesces stream text deltas into full snapshots before upload', async () => {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  const client = makeClient(calls)
  await client.initialize()
  await client.writeEvent({
    type: 'stream_event',
    uuid: 'start_1',
    session_id: 'cse_worker',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_stream' } },
  })
  await client.writeEvent({
    type: 'stream_event',
    uuid: 'delta_1',
    session_id: 'cse_worker',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
  })
  await client.writeEvent({
    type: 'stream_event',
    uuid: 'delta_2',
    session_id: 'cse_worker',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
  })
  await client.writeEvent({ type: 'assistant', session_id: 'cse_worker', parent_tool_use_id: null, message: { id: 'msg_stream' } })
  await client.flush()
  client.close()

  const eventsCall = calls.find(call => call.url.endsWith('/worker/events') && call.body.events.some((event: any) => event.payload.type === 'stream_event'))!
  const streamEvents = eventsCall.body.events.filter((event: any) => event.payload.type === 'stream_event')
  expect(streamEvents.map((event: any) => event.payload.event.type)).toEqual(['message_start', 'content_block_delta'])
  expect(streamEvents[1].payload.event.delta.text).toBe('你好')
})

test('BridgeWorkerClient reports epoch mismatch on 409 responses', async () => {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = []
  let mismatches = 0
  const client = new BridgeWorkerClient({
    sessionId: 'cse_worker',
    credentials: {
      workerJwt: 'worker.jwt',
      apiBaseUrl: 'https://session-ingress.example',
      workerEpoch: 11,
    },
    heartbeatIntervalMs: 60_000,
    onEpochMismatch: () => { mismatches++ },
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      })
      return new Response('superseded', { status: 409 })
    },
  })

  expect(await client.initialize()).toMatchObject({ ok: false, status: 409 })
  expect(mismatches).toBe(1)
  client.close()
})
