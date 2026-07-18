import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import { isEnabledPluginSettingValue } from '../../utils/plugins/dependencyResolver.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache, loadAllPluginsCacheOnly } from '../../utils/plugins/pluginLoader.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { handlePluginsApi } from '../api/plugins.js'
import { conversationService } from '../services/conversationService.js'
import { __resetWebSocketHandlerStateForTests, getSlashCommands } from '../ws/handler.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalHasSession: typeof conversationService.hasSession
let originalRequestControl: typeof conversationService.requestControl

function makeRequest(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const req = new Request(url.toString(), init)
  return {
    req,
    url,
    segments: url.pathname.split('/').filter(Boolean),
  }
}

describe('Plugins API', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-plugins-api-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    clearInstalledPluginsCache()
    clearPluginCache('plugins-api-test-setup')
    resetSettingsCache()
    __resetWebSocketHandlerStateForTests()
    originalHasSession = conversationService.hasSession.bind(conversationService)
    originalRequestControl = conversationService.requestControl.bind(conversationService)
  })

  afterEach(async () => {
    conversationService.hasSession = originalHasSession
    conversationService.requestControl = originalRequestControl
    __resetWebSocketHandlerStateForTests()
    clearInstalledPluginsCache()
    clearPluginCache('plugins-api-test-teardown')
    resetSettingsCache()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('GET /api/plugins returns an empty plugin list for a clean config', async () => {
    const { req, url, segments } = makeRequest('GET', '/api/plugins')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      plugins: unknown[]
      summary: { total: number; enabled: number; attention: number }
    }

    expect(body.plugins).toEqual([])
    expect('marketplaces' in body).toBe(false)
    expect(body.summary.total).toBe(0)
    expect(body.summary.enabled).toBe(0)
    expect(body.summary.attention).toBe(0)
  })

  it('treats enabledPlugins version constraint arrays as enabled plugins', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'demo')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        description: 'Demo plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'demo',
            source: './plugins/demo',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: {
          'demo@test-market': ['^1.0.0'],
        },
      }),
      'utf-8',
    )

    expect(isEnabledPluginSettingValue(true)).toBe(true)
    expect(isEnabledPluginSettingValue(['^1.0.0'])).toBe(true)
    expect(isEnabledPluginSettingValue(false)).toBe(false)
    expect(isEnabledPluginSettingValue(undefined)).toBe(false)

    const cacheOnlyResult = await loadAllPluginsCacheOnly()
    expect(cacheOnlyResult.enabled).toContainEqual(
      expect.objectContaining({ source: 'demo@test-market', enabled: true }),
    )

    clearPluginCache('plugins-api-test-full-load')

    const { req, url, segments } = makeRequest('GET', '/api/plugins')
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      plugins: Array<{ id: string; enabled: boolean }>
      summary: { enabled: number }
    }
    expect(body.plugins).toContainEqual(
      expect.objectContaining({ id: 'demo@test-market', enabled: true }),
    )
    expect(body.summary.enabled).toBe(1)
  })

  it('keeps plugin implementation details out of list and detail responses', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'private-tools')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json')
    const hookCommand = 'DO_NOT_SEND_HOOK_COMMAND --token=top-secret'
    const mcpCommand = 'DO_NOT_SEND_MCP_COMMAND'
    const mcpUrl = 'https://private.example.test/mcp?token=top-secret'
    const commandDescription = 'DO_NOT_SEND_COMMAND_DESCRIPTION'
    const skillDescription = 'DO_NOT_SEND_SKILL_DESCRIPTION'

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'hooks'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'skills', 'private-skill'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'private-tools',
        version: '9.9.9',
        description: 'DO_NOT_SEND_MANIFEST_DESCRIPTION',
        author: { name: 'DO_NOT_SEND_AUTHOR' },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'commands', 'private-command.md'),
      `---\ndescription: ${commandDescription}\n---\nPrivate command instructions.`,
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand }],
          }],
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'private-skill', 'SKILL.md'),
      `---\ndescription: ${skillDescription}\n---\nPrivate skill instructions.`,
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          privateServer: {
            command: mcpCommand,
            args: ['--url', mcpUrl],
          },
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'safe-market',
        owner: { name: 'Test' },
        plugins: [{ name: 'private-tools', source: './plugins/private-tools', version: '9.9.9' }],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'safe-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(tmpDir, 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'private-tools@safe-market': true },
      }),
      'utf-8',
    )

    const listRequest = makeRequest('GET', '/api/plugins')
    const listResponse = await handlePluginsApi(
      listRequest.req,
      listRequest.url,
      listRequest.segments,
    )
    expect(listResponse.status).toBe(200)
    const list = await listResponse.json() as {
      plugins: Array<Record<string, unknown>>
    }
    const summary = list.plugins.find((plugin) => plugin.id === 'private-tools@safe-market')

    expect(summary).toEqual({
      id: 'private-tools@safe-market',
      name: 'private-tools',
      scope: 'user',
      enabled: true,
      status: 'enabled',
      canManage: true,
      descriptionKind: 'workspace_extension',
      componentCounts: {
        commands: 1,
        agents: 0,
        skills: 1,
        hooks: 1,
        mcpServers: 1,
        lspServers: 0,
      },
    })

    const detailRequest = makeRequest(
      'GET',
      '/api/plugins/detail?id=private-tools%40safe-market',
    )
    const detailResponse = await handlePluginsApi(
      detailRequest.req,
      detailRequest.url,
      detailRequest.segments,
    )
    const detailBody = await detailResponse.json() as { detail: Record<string, unknown> }

    expect(detailBody.detail).toEqual(summary)
    expect(JSON.stringify({ list, detailBody })).not.toContain(hookCommand)
    expect(JSON.stringify({ list, detailBody })).not.toContain(mcpCommand)
    expect(JSON.stringify({ list, detailBody })).not.toContain(mcpUrl)
    expect(JSON.stringify({ list, detailBody })).not.toContain(commandDescription)
    expect(JSON.stringify({ list, detailBody })).not.toContain(skillDescription)
    expect(JSON.stringify({ list, detailBody })).not.toContain('DO_NOT_SEND_MANIFEST_DESCRIPTION')
    expect(JSON.stringify({ list, detailBody })).not.toContain('DO_NOT_SEND_AUTHOR')
    expect(JSON.stringify({ list, detailBody })).not.toContain(marketplaceRoot)

    const disableRequest = makeRequest('POST', '/api/plugins/disable', {
      id: 'private-tools@safe-market',
      scope: 'user',
    })
    const disableResponse = await handlePluginsApi(
      disableRequest.req,
      disableRequest.url,
      disableRequest.segments,
    )
    expect(disableResponse.status).toBe(200)
    expect(await disableResponse.json()).toEqual({ ok: true, action: 'disabled' })

    const reloadRequest = makeRequest('POST', '/api/plugins/reload', {})
    const reloadResponse = await handlePluginsApi(
      reloadRequest.req,
      reloadRequest.url,
      reloadRequest.segments,
    )
    expect(reloadResponse.status).toBe(200)
    expect((await reloadResponse.json() as { summary: { enabled: number } }).summary.enabled).toBe(0)

    const enableRequest = makeRequest('POST', '/api/plugins/enable', {
      id: 'private-tools@safe-market',
      scope: 'user',
    })
    const enableResponse = await handlePluginsApi(
      enableRequest.req,
      enableRequest.url,
      enableRequest.segments,
    )
    expect(enableResponse.status).toBe(200)
    expect(await enableResponse.json()).toEqual({ ok: true, action: 'enabled' })
  })

  it('returns generic plugin error codes without messages', async () => {
    const request = makeRequest('POST', '/api/plugins/uninstall', {
      id: 'plugin@marketplace',
    })
    const response = await handlePluginsApi(request.req, request.url, request.segments)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'PLUGIN_ACTION_INVALID' })
  })

  it('POST /api/plugins/reload returns numeric counters', async () => {
    const { req, url, segments } = makeRequest('POST', '/api/plugins/reload', {})
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      ok: boolean
      summary: Record<string, number>
    }

    expect(body.ok).toBe(true)
    expect(typeof body.summary.enabled).toBe('number')
    expect(typeof body.summary.skills).toBe('number')
    expect(typeof body.summary.errors).toBe('number')
  })

  it('POST /api/plugins/reload hot-reloads an active CLI session and updates slash commands', async () => {
    const controlRequests: Array<{ sessionId: string; request: Record<string, unknown> }> = []
    conversationService.hasSession = ((sessionId: string) => sessionId === 'session-plugins') as typeof conversationService.hasSession
    conversationService.requestControl = (async (
      sessionId: string,
      request: Record<string, unknown>,
    ) => {
      controlRequests.push({ sessionId, request })
      return {
        commands: [
          {
            name: 'draw:render',
            description: 'Render a drawing.',
            argumentHint: '<prompt>',
          },
        ],
        agents: [{ name: 'draw-agent' }],
        plugins: [{ name: 'draw', path: '/tmp/draw', source: 'draw@test' }],
        mcpServers: [{ name: 'plugin:draw:server', type: 'connected' }],
        error_count: 0,
      }
    }) as typeof conversationService.requestControl

    const { req, url, segments } = makeRequest(
      'POST',
      '/api/plugins/reload?sessionId=session-plugins',
      {},
    )
    const res = await handlePluginsApi(req, url, segments)

    expect(res.status).toBe(200)
    const body = await res.json() as {
      session: {
        applied: boolean
        commands: number
        agents: number
        plugins: number
        mcpServers: number
        errors: number
      }
    }

    expect(controlRequests).toEqual([
      {
        sessionId: 'session-plugins',
        request: { subtype: 'reload_plugins' },
      },
    ])
    expect(body.session).toEqual({
      applied: true,
      commands: 1,
      agents: 1,
      plugins: 1,
      mcpServers: 1,
      errors: 0,
    })
    const slashCommands = getSlashCommands('session-plugins')
    expect(slashCommands).toEqual([{ name: 'draw:render' }])
    expect(JSON.stringify(slashCommands)).not.toContain('Render a drawing.')
    expect(JSON.stringify(slashCommands)).not.toContain('<prompt>')
  })

  it('refreshActivePlugins rereads settings after an external enable toggle', async () => {
    const marketplaceRoot = path.join(tmpDir, 'marketplace-root')
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'draw')
    const pluginsDir = path.join(tmpDir, 'plugins')
    const marketplaceFile = path.join(
      marketplaceRoot,
      '.claude-plugin',
      'marketplace.json',
    )

    await fs.mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'commands'), { recursive: true })
    await fs.mkdir(path.join(pluginRoot, 'skills', 'paint'), { recursive: true })
    await fs.mkdir(path.dirname(marketplaceFile), { recursive: true })
    await fs.mkdir(pluginsDir, { recursive: true })

    await fs.writeFile(
      path.join(pluginRoot, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'draw',
        version: '1.0.0',
        description: 'Drawing plugin',
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'commands', 'render.md'),
      '---\ndescription: Render a drawing.\n---\nRender this drawing.',
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginRoot, 'skills', 'paint', 'SKILL.md'),
      '---\ndescription: Paint with the drawing plugin.\n---\nPaint this drawing.',
      'utf-8',
    )
    await fs.writeFile(
      marketplaceFile,
      JSON.stringify({
        name: 'test-market',
        owner: { name: 'Test' },
        plugins: [
          {
            name: 'draw',
            source: './plugins/draw',
            version: '1.0.0',
          },
        ],
      }),
      'utf-8',
    )
    await fs.writeFile(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        'test-market': {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
          lastUpdated: new Date(0).toISOString(),
        },
      }),
      'utf-8',
    )

    const settingsPath = path.join(tmpDir, 'settings.json')
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': false,
        },
      }),
      'utf-8',
    )

    const disabledResult = await loadAllPluginsCacheOnly()
    expect(disabledResult.enabled).toEqual([])
    expect(disabledResult.disabled).toContainEqual(
      expect.objectContaining({ source: 'draw@test-market', enabled: false }),
    )

    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabledPlugins: {
          'draw@test-market': true,
        },
      }),
      'utf-8',
    )

    let appState = {
      plugins: {
        enabled: [],
        disabled: disabledResult.disabled,
        commands: [],
        errors: [],
        needsRefresh: true,
      },
      mcp: { pluginReconnectKey: 0 },
      agentDefinitions: { allAgents: [], errors: [] },
    } as unknown as AppState

    const result = await refreshActivePlugins(updater => {
      appState = updater(appState)
    })

    expect(result.enabled_count).toBe(1)
    expect(result.command_count).toBe(1)
    expect(result.skill_count).toBe(1)
    expect(result.pluginCommands).toContainEqual(
      expect.objectContaining({
        name: 'draw:render',
        description: 'Render a drawing.',
      }),
    )
    expect(result.pluginSkills).toContainEqual(
      expect.objectContaining({
        name: 'draw:paint',
        description: 'Paint with the drawing plugin.',
      }),
    )
    expect(appState.plugins.commands).toContainEqual(
      expect.objectContaining({ name: 'draw:render' }),
    )
    expect(appState.plugins.commands).toContainEqual(
      expect.objectContaining({ name: 'draw:paint' }),
    )
  })
})
