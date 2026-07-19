import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('desktop doctor routes stay retired from the product API', async () => {
  const requests = [
    ['GET', '/api/doctor'],
    ['GET', '/api/doctor/report'],
    ['POST', '/api/doctor/repair'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
