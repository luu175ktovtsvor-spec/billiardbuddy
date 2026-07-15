import { expect, test } from 'bun:test'
import { getBaseUrl, setBaseUrl } from './client'
import { videoApi } from './video'

test('video API scopes project discovery to the active working directory', async () => {
  const previousBaseUrl = getBaseUrl()
  let workingDir = ''
  const server = Bun.serve({
    port: 0,
    fetch: request => {
      const url = new URL(request.url)
      workingDir = url.searchParams.get('working_dir') ?? ''
      return Response.json({ projects: [] })
    },
  })
  setBaseUrl(`http://127.0.0.1:${server.port}`)
  try {
    expect(await videoApi.listProjects('/workspace/a')).toEqual([])
    expect(workingDir).toBe('/workspace/a')
  } finally {
    server.stop(true)
    setBaseUrl(previousBaseUrl)
  }
})
