import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('desktop activity statistics routes stay retired', async () => {
  for (const path of ['/api/activity-stats', '/api/activity-stats/7d']) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url), url)

    expect(response.status).toBe(404)
  }
})
