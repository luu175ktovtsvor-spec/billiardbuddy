import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('legacy workspace search route stays retired', async () => {
  const url = new URL('http://localhost/api/search')
  const response = await handleApiRequest(
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'legacy-workspace-search' }),
    }),
    url,
  )

  expect(response.status).toBe(404)
})
