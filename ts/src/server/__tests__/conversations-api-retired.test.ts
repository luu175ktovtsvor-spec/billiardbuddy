import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('legacy queued conversation routes stay retired from the product API', async () => {
  const requests = [
    ['POST', '/api/conversations/session-1'],
    ['GET', '/api/conversations/session-1/status'],
    ['POST', '/api/sessions/session-1/chat'],
    ['GET', '/api/sessions/session-1/chat/status'],
    ['POST', '/api/sessions/session-1/chat/stop'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
