import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:49237',
}))

import { productTasksApi } from './tasks'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('productTasksApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the product task index endpoint as its list source', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      schemaVersion: 1,
      projects: [],
      tasks: [],
      total: 0,
      capabilities: { createTask: true },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.list()

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/product/tasks',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })

  it('sends lifecycle actions to their real task endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ task: { id: 'task 1' } })))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.create({ workDir: '/workspace/billiard' })
    await productTasksApi.continue('task 1', {
      title: '继续修复',
      sourceEntryId: 'thread_0123456789abcdef0123',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49237/api/product/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ workDir: '/workspace/billiard' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49237/api/product/tasks/task%201/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: '继续修复',
          sourceEntryId: 'thread_0123456789abcdef0123',
        }),
      }),
    )
  })

  it('loads thread history through the task-scoped product endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ taskId: 'task 1', entries: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.getThread('task 1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/product/tasks/task%201/thread',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('uses task-scoped review endpoints and sends only a relative review path', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ taskId: 'task 1', state: 'ready', changedFiles: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.getReviewStatus('task 1')
    await productTasksApi.getReviewTree('task 1', 'src')
    await productTasksApi.getReviewFile('task 1', 'src/main.ts')
    await productTasksApi.getReviewDiff('task 1', 'src/main.ts')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49237/api/product/tasks/task%201/review/status',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49237/api/product/tasks/task%201/review/tree?path=src',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:49237/api/product/tasks/task%201/review/file?path=src%2Fmain.ts',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://127.0.0.1:49237/api/product/tasks/task%201/review/diff?path=src%2Fmain.ts',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('loads media artifacts through the public task-scoped endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ taskId: 'task 1', projects: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.getMedia('task 1')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:49237/api/product/tasks/task%201/media',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('uses task-scoped attach discovery and explicit attach endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ taskId: 'task 1', projects: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.getAttachableMedia('task 1')
    await productTasksApi.attachMediaProject('task 1', 'img_12345678')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49237/api/product/tasks/task%201/media/attachable-projects',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49237/api/product/tasks/task%201/media/projects/img_12345678/attach',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
  })
})
