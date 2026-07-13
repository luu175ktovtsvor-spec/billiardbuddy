import { expect, test } from 'bun:test'
import { getBaseUrl, setBaseUrl } from './client'
import { extensionApi, pluginApi } from './extensions'

test('extension API parses plugin sources and keeps local plugin paths out of renderer data', async () => {
  const previousBaseUrl = getBaseUrl()
  let commandQuery = ''
  const server = Bun.serve({
    port: 0,
    fetch: request => {
      const url = new URL(request.url)
      if (url.pathname === '/api/v1/agent/commands') {
        commandQuery = url.search
        return Response.json({ commands: [{ name: 'demo', description: 'Demo command', source: 'plugin', layer: 'plugin' }] })
      }
      if (url.pathname === '/api/v1/agent/plugins/toggle') return Response.json({ ok: true, message: 'updated' })
      if (url.pathname === '/api/v1/agent/plugins') {
        return Response.json({
          plugins: [{
            name: 'demo',
            enabled: false,
            dir: '/private/plugin/path',
            description: 'Demo plugin',
            components: { skills: 1, commands: 1, hooks: 1, 'output-styles': 0, mcp: 1 },
          }],
        })
      }
      return new Response('not found', { status: 404 })
    },
  })

  setBaseUrl(`http://127.0.0.1:${server.port}`)
  try {
    const commands = await extensionApi.commands({ workspaceRoot: '/tmp/project', enabledPacks: ['billiards'] })
    expect(commands[0]).toMatchObject({ name: 'demo', source: 'plugin', layer: 'plugin' })
    expect(commandQuery).toContain('working_dir=%2Ftmp%2Fproject')
    expect(commandQuery).toContain('enabled_packs=billiards')

    const plugins = await pluginApi.list()
    expect(plugins[0]).toMatchObject({ name: 'demo', enabled: false })
    expect('dir' in (plugins[0] as object)).toBe(false)
    expect(await pluginApi.toggle('demo', true)).toEqual({ ok: true, message: 'updated' })
  } finally {
    server.stop(true)
    setBaseUrl(previousBaseUrl)
  }
})
