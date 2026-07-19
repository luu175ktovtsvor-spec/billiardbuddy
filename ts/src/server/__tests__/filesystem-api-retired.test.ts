import { expect, test } from 'bun:test'
import { handleApiRequest } from '../router.js'

test('legacy filesystem browsing routes stay retired', async () => {
  for (const path of [
    '/api/filesystem/browse?path=%2Ftmp',
    '/api/filesystem/file?path=%2Ftmp%2Fpreview.png',
  ]) {
    const url = new URL(`http://127.0.0.1${path}`)
    const response = await handleApiRequest(new Request(url), url)

    expect(response.status).toBe(404)
  }
})
