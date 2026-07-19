import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('unconsumed legacy team REST routes stay retired', async () => {
  const requests = [
    ['GET', '/api/teams'],
    ['GET', '/api/teams/old-team'],
    ['GET', '/api/teams/old-team/members/worker/transcript'],
    ['POST', '/api/teams/old-team/members/worker/messages'],
    ['DELETE', '/api/teams/old-team'],
  ] as const

  for (const [method, path] of requests) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url, { method }), url)

    expect(response.status).toBe(404)
  }
})
