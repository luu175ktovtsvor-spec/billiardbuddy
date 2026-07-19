import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('legacy Core-session REST routes stay retired', async () => {
  const requests = [
    ['GET', '/api/sessions'],
    ['POST', '/api/sessions'],
    ['GET', '/api/sessions/session-1'],
    ['PATCH', '/api/sessions/session-1'],
    ['DELETE', '/api/sessions/session-1'],
    ['GET', '/api/sessions/session-1/messages'],
    ['GET', '/api/sessions/session-1/workspace/status'],
    ['GET', '/api/sessions/session-1/turn-checkpoints'],
    ['POST', '/api/sessions/session-1/rewind'],
    ['GET', '/api/sessions/session-1/slash-commands'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)
    expect(response.status).toBe(404)
  }
})
