import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({
  getAuthToken: () => 'desktop-token',
}))

vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => 'http://127.0.0.1:49237',
}))

import { productSideTasksApi } from './sideTasks'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('productSideTasksApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses dedicated side-task endpoints instead of the normal task index', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ sideTask: { id: 'side 1' } })))
    vi.stubGlobal('fetch', fetchMock)

    await productSideTasksApi.list('task 1')
    await productSideTasksApi.create('task 1', { sourceTurnId: 'message-42' })
    await productSideTasksApi.close('task 1', 'side 1')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer desktop-token' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sourceTurnId: 'message-42' }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://127.0.0.1:49237/api/product/tasks/task%201/side-tasks/side%201/close',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )
  })
})
