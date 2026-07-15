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
        return Response.json({ commands: [{ name: 'demo', description: 'Demo command', source: 'plugin', layer: 'plugin', kind: 'skill' }] })
      }
      if (url.pathname === '/api/v1/agent/skills') return Response.json({ skills: [{ name: 'demo', description: 'Demo skill', display_name: '演示技能', short_description: '演示界面元数据', source: 'skills', layer: 'workspace', user_invocable: true }] })
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
    expect(commands[0]).toMatchObject({ name: 'demo', source: 'plugin', layer: 'plugin', kind: 'skill' })
    expect(commandQuery).toContain('working_dir=%2Ftmp%2Fproject')
    expect(commandQuery).toContain('enabled_packs=billiards')

    const skills = await extensionApi.skills({ workspaceRoot: '/tmp/project' })
    expect(skills[0]).toMatchObject({ name: 'demo', display_name: '演示技能', short_description: '演示界面元数据', layer: 'workspace' })

    const plugins = await pluginApi.list()
    expect(plugins[0]).toMatchObject({ name: 'demo', enabled: false })
    expect('dir' in (plugins[0] as object)).toBe(false)
    expect(await pluginApi.toggle('demo', true)).toEqual({ ok: true, message: 'updated' })
  } finally {
    server.stop(true)
    setBaseUrl(previousBaseUrl)
  }
})
