import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('unconsumed model and effort management routes stay retired', async () => {
  const requests = [
    ['GET', '/api/models'],
    ['PUT', '/api/models'],
    ['GET', '/api/models/current'],
    ['PUT', '/api/models/current'],
    ['GET', '/api/effort'],
    ['PUT', '/api/effort'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
