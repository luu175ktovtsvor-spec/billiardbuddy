import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('raw trace routes stay retired from the product API', async () => {
  const requests = [
    ['GET', '/api/traces'],
    ['GET', '/api/traces/settings'],
    ['PUT', '/api/traces/settings'],
    ['DELETE', '/api/traces/session-1'],
    ['GET', '/api/sessions/session-1/trace'],
    ['GET', '/api/sessions/session-1/trace/calls/call-1'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
