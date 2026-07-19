import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('unconsumed provider management routes stay retired', async () => {
  const requests = [
    ['GET', '/api/providers'],
    ['POST', '/api/providers'],
    ['GET', '/api/providers/presets'],
    ['GET', '/api/providers/auth-status'],
    ['PUT', '/api/providers/settings'],
    ['POST', '/api/providers/provider-1/activate'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
