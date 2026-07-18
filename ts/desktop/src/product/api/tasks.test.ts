import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({
  getAuthToken: () => 'desktop-token',
}))

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
        headers: expect.objectContaining({ Authorization: 'Bearer desktop-token' }),
      }),
    )
  })

  it('sends lifecycle actions to their real task endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ task: { id: 'task 1' } })))
    vi.stubGlobal('fetch', fetchMock)

    await productTasksApi.create({ workDir: '/workspace/billiard' })
    await productTasksApi.continue('task 1', { title: '继续修复' })

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
        body: JSON.stringify({ title: '继续修复' }),
      }),
    )
  })
})
