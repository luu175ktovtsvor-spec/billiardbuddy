import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('unconsumed external open-target routes stay retired', async () => {
  const requests = [
    ['GET', '/api/open-targets'],
    ['POST', '/api/open-targets/open'],
    ['GET', '/api/open-targets/icons/editor'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
