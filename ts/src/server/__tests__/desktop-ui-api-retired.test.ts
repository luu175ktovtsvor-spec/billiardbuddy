import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('unconsumed desktop profile routes stay retired', async () => {
  const requests = [
    ['GET', '/api/desktop-ui/preferences'],
    ['PUT', '/api/desktop-ui/preferences/profile'],
    ['GET', '/api/desktop-ui/preferences/profile/avatar'],
    ['PUT', '/api/desktop-ui/preferences/profile/avatar'],
    ['DELETE', '/api/desktop-ui/preferences/profile/avatar'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
