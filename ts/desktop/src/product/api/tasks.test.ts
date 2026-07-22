import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/desktopRuntime', () => ({ getServerBaseUrl: () => 'http://127.0.0.1:49237' }))

import { PRODUCT_MEDIA_RESULT_TIMEOUT_MS, productTasksApi } from './tasks'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const envelope = Object.freeze({ expected_revision: 7, client_operation_id: 'operation-0123456789abcdef' })
const result = { receipt: { ...envelope, outcome: 'accepted', revision: 8 }, authority: { revision: 8, event_sequence: 8, tasks: [] } }

describe('productTasksApi authoritative mutations', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('sends every mutation route its immutable envelope and parses authority receipts', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(result))
    vi.stubGlobal('fetch', fetchMock)
    await productTasksApi.create({ workDir: '/workspace/billiard', ...envelope })
    await productTasksApi.update('task 1', { title: '改名', ...envelope })
    await productTasksApi.pin('task 1', envelope)
    await productTasksApi.unpin('task 1', envelope)
    await productTasksApi.archive('task 1', envelope)
    await productTasksApi.restore('task 1', envelope)
    await productTasksApi.continue('task 1', { title: '继续', ...envelope })
    await productTasksApi.createSideTask('task 1', { sourceEntryId: 'thread-1', sideTaskId: 'side-1', ...envelope })
    await productTasksApi.closeSideTask('task 1', 'side 1', envelope)
    const calls = fetchMock.mock.calls
    expect(calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:49237/api/product/tasks',
      'http://127.0.0.1:49237/api/product/tasks/task%201',
      'http://127.0.0.1:49237/api/product/tasks/task%201/pin',
      'http://127.0.0.1:49237/api/product/tasks/task%201/unpin',
      'http://127.0.0.1:49237/api/product/tasks/task%201/archive',
      'http://127.0.0.1:49237/api/product/tasks/task%201/restore',
      'http://127.0.0.1:49237/api/product/tasks/task%201/continue',
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks',
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks/side%201/close',
    ])
    expect(calls[0]![1]!.body).toBe(JSON.stringify({ workDir: '/workspace/billiard', ...envelope }))
    expect(calls.slice(2).every(([, init]) => JSON.parse(String(init?.body)).client_operation_id === envelope.client_operation_id)).toBe(true)
  })

  it('queries durable operations and preserves server errors', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ receipt: result.receipt, authority: result.authority })).mockResolvedValueOnce(jsonResponse({ error: 'CONFLICT' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    await expect(productTasksApi.getOperation('task 1', envelope.client_operation_id)).resolves.toEqual({ receipt: result.receipt, authority: result.authority })
    await expect(productTasksApi.pin('task 1', envelope)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 })
  })

  it('retries the exact caller-built envelope without replacing its id or revision', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(result))
    vi.stubGlobal('fetch', fetchMock)
    await productTasksApi.archive('task 1', envelope)
    await productTasksApi.archive('task 1', envelope)
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body)
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(envelope))
  })

  it('uses product task index, thread, review and media routes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ tasks: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await productTasksApi.list(); await productTasksApi.getThread('task 1'); await productTasksApi.getReviewFile('task 1', 'src/main.ts'); await productTasksApi.getMedia('task 1')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:49237/api/product/tasks',
      'http://127.0.0.1:49237/api/product/tasks/task%201/thread',
      'http://127.0.0.1:49237/api/product/tasks/task%201/review/file?path=src%2Fmain.ts',
      'http://127.0.0.1:49237/api/product/tasks/task%201/media',
    ])
  })

  it('keeps task-scoped final image materialization open for five minutes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation((_input, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })))
    vi.stubGlobal('fetch', fetchMock)
    const pending = productTasksApi.getMedia('task 1').catch((error) => error as Error)
    await vi.advanceTimersByTimeAsync(PRODUCT_MEDIA_RESULT_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' })
  })
})
