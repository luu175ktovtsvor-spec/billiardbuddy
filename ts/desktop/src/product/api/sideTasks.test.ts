import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../lib/desktopRuntime', () => ({ getServerBaseUrl: () => 'http://127.0.0.1:49237' }))
import { productSideTasksApi } from './sideTasks'

function response(body: unknown) { return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }) }
const envelope = Object.freeze({ expected_revision: 4, client_operation_id: 'side-operation-1' })
const authoritative = { receipt: { ...envelope, outcome: 'accepted', revision: 5 }, authority: { revision: 5, event_sequence: 5, tasks: [] } }

describe('productSideTasksApi', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('uses the sole authoritative side routes with caller-built envelopes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => response(authoritative))
    vi.stubGlobal('fetch', fetchMock)
    await productSideTasksApi.list('task 1')
    await productSideTasksApi.create('task 1', { sourceEntryId: 'thread-1', sideTaskId: 'side-1', ...envelope })
    await productSideTasksApi.close('task 1', 'side 1', envelope)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks',
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks',
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks/side%201/close',
    ])
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ sourceEntryId: 'thread-1', sideTaskId: 'side-1', ...envelope }))
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify(envelope))
  })
})
