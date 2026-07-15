import { expect, test } from 'bun:test'
import { getBaseUrl, setBaseUrl } from './client'
import { brandPackApi, studioApi, workbenchApi } from './studio'

test('studio media requests preserve the active conversation and working directory', async () => {
  const previousBaseUrl = getBaseUrl()
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> })
      return Response.json({ job_id: `job-${requests.length}` })
    },
  })
  setBaseUrl(`http://127.0.0.1:${server.port}`)
  try {
    const scope = { conversation_id: 'conversation-1', working_dir: '/workspace/a' }
    await studioApi.generate({ prompt: '生成海报', ...scope })
    await studioApi.edit({ source_image_path: '/workspace/a/source.png', description: '调亮一点', ...scope })
    await studioApi.upscale({ source_image_path: '/workspace/a/source.png', scale: 4, ...scope })

    expect(requests).toEqual([
      expect.objectContaining({ path: '/api/v1/studio/generate', body: expect.objectContaining(scope) }),
      expect.objectContaining({ path: '/api/v1/studio/edit', body: expect.objectContaining(scope) }),
      expect.objectContaining({ path: '/api/v1/studio/upscale', body: expect.objectContaining(scope) }),
    ])
  } finally {
    server.stop(true)
    setBaseUrl(previousBaseUrl)
  }
})

test('workbench API scopes project discovery to the active working directory', async () => {
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
    expect(await workbenchApi.listProjects('/workspace/a')).toEqual([])
    expect(workingDir).toBe('/workspace/a')
  } finally {
    server.stop(true)
    setBaseUrl(previousBaseUrl)
  }
})

test('brand pack API parses legacy GET and persists PATCH fields', async () => {
  const previousBaseUrl = getBaseUrl()
  let store: Record<string, unknown> = {
    id: 'local-store',
    name: '旧门店',
    city: '上海',
    logo_url: null,
    qrcode_url: null,
  }
  let patchMethod = ''
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      const url = new URL(request.url)
      if (url.pathname !== '/api/v1/stores/me') return new Response('not found', { status: 404 })
      if (request.method === 'PATCH') {
        patchMethod = request.method
        store = { ...store, ...await request.json() as Record<string, unknown> }
      }
      return Response.json(store)
    },
  })

  setBaseUrl(`http://127.0.0.1:${server.port}`)
  try {
    const legacy = await brandPackApi.get()
    expect(legacy.brand_reference_images).toEqual([])
    expect(legacy.city).toBe('上海')

    const updated = await brandPackApi.update({
      logo_url: '/uploads/workbench/assets/reference/reference_logo.png',
      logo_asset_id: 'reference_logo',
      logo_width: 320,
      logo_height: 120,
    })
    expect(patchMethod).toBe('PATCH')
    expect(updated.logo_asset_id).toBe('reference_logo')
    expect(updated.logo_width).toBe(320)
    expect(updated.city).toBe('上海')
  } finally {
    server.stop(true)
    setBaseUrl(previousBaseUrl)
  }
})
