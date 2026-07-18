import { expect, test } from 'bun:test'

import { handleApiRequest } from '../router.js'

test('raw memory file routes stay retired from the product API', async () => {
  for (const path of ['/api/memory/projects', '/api/memory/files', '/api/memory/file']) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url), url)

    expect(response.status).toBe(404)
  }
})
