import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('legacy settings routes stay retired outside the product API', async () => {
  const requests = [
    ['GET', '/api/settings'],
    ['GET', '/api/settings/user'],
    ['PUT', '/api/settings/user'],
    ['GET', '/api/settings/runtime'],
    ['PUT', '/api/settings/runtime'],
    ['GET', '/api/settings/desktop'],
    ['PUT', '/api/settings/desktop'],
    ['GET', '/api/settings/output-styles'],
    ['PUT', '/api/settings/output-style'],
    ['GET', '/api/settings/project'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
