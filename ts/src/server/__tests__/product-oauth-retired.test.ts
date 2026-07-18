import { expect, test } from 'bun:test'
import { handleApiRequest } from '../router.js'

test('product Claude and ChatGPT login routes stay retired', async () => {
  for (const path of ['/api/bb-oauth', '/api/bb-openai-oauth']) {
    const url = new URL(`http://localhost${path}`)
    const response = await handleApiRequest(new Request(url), url)
    expect(response.status).toBe(404)
  }
})
