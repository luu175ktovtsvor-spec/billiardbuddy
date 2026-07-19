/**
 * Regression coverage for retired background-task REST routes.
 */

import { describe, it, expect } from 'bun:test'
import { handleApiRequest } from '../router.js'

describe('Retired background tasks API', () => {
  it('does not expose Agent Core task lists through the old REST surface', async () => {
    for (const [method, path] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['GET', '/api/tasks/lists/default-list'],
      ['POST', '/api/tasks/lists/default-list/reset'],
    ] as const) {
      const url = new URL(`http://localhost${path}`)
      const response = await handleApiRequest(new Request(url, { method }), url)
      expect(response.status).toBe(404)
    }
  })
})
