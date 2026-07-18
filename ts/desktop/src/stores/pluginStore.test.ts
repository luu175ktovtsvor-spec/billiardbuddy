import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginStore } from './pluginStore'
import { pluginsApi } from '../api/plugins'

vi.mock('../api/plugins', () => ({
  getPluginRequestErrorCode: vi.fn(() => 'PLUGIN_REQUEST_FAILED'),
  pluginsApi: {
    list: vi.fn(),
    detail: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    reload: vi.fn(),
  },
}))

const mockedPluginsApi = vi.mocked(pluginsApi)

describe('pluginStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedPluginsApi.list.mockResolvedValue({
      plugins: [],
      summary: { total: 0, enabled: 0, attention: 0 },
    })
    mockedPluginsApi.reload.mockResolvedValue({
      ok: true,
      summary: {
        enabled: 1,
        disabled: 0,
        skills: 1,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
        errors: 0,
      },
      session: {
        applied: true,
        commands: 1,
        agents: 0,
        plugins: 1,
        mcpServers: 0,
        errors: 0,
      },
    })
    usePluginStore.setState({
      plugins: [],
      summary: null,
      selectedPlugin: null,
      lastReloadSummary: null,
      isLoading: false,
      isDetailLoading: false,
      isApplying: false,
      error: null,
    })
  })

  it('reloads the active CLI session after enabling a plugin', async () => {
    mockedPluginsApi.enable.mockResolvedValue({
      ok: true,
      action: 'enabled',
    })

    const action = await usePluginStore
      .getState()
      .enablePlugin('draw@test', 'user', '/workspace/project', 'session-1')

    expect(action).toBe('enabled')
    expect(mockedPluginsApi.enable).toHaveBeenCalledWith({
      id: 'draw@test',
      scope: 'user',
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'session-1',
    )
    expect(usePluginStore.getState().lastReloadSummary).toEqual({
      enabled: 1,
      disabled: 0,
      skills: 1,
      agents: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
      errors: 0,
    })
  })

  it('reloads and refreshes once after bulk enabling plugins', async () => {
    mockedPluginsApi.enable.mockResolvedValue({
      ok: true,
      action: 'enabled',
    })

    const changed = await usePluginStore.getState().bulkEnablePlugins(
      [
        { id: 'draw@test', scope: 'user' },
        { id: 'review@test', scope: 'project' },
      ],
      '/workspace/project',
      'session-1',
    )

    expect(changed).toBe(2)
    expect(mockedPluginsApi.enable).toHaveBeenCalledTimes(2)
    expect(mockedPluginsApi.enable).toHaveBeenNthCalledWith(1, {
      id: 'draw@test',
      scope: 'user',
    })
    expect(mockedPluginsApi.enable).toHaveBeenNthCalledWith(2, {
      id: 'review@test',
      scope: 'project',
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'session-1',
    )
    expect(mockedPluginsApi.list).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
  })

  it('reloads and refreshes once after bulk disabling plugins', async () => {
    mockedPluginsApi.disable.mockResolvedValue({
      ok: true,
      action: 'disabled',
    })

    const changed = await usePluginStore.getState().bulkDisablePlugins(
      [
        { id: 'github@test', scope: 'user' },
        { id: 'review@test', scope: 'project' },
      ],
      '/workspace/project',
      'session-1',
    )

    expect(changed).toBe(2)
    expect(mockedPluginsApi.disable).toHaveBeenCalledTimes(2)
    expect(mockedPluginsApi.disable).toHaveBeenNthCalledWith(1, {
      id: 'github@test',
      scope: 'user',
    })
    expect(mockedPluginsApi.disable).toHaveBeenNthCalledWith(2, {
      id: 'review@test',
      scope: 'project',
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'session-1',
    )
    expect(mockedPluginsApi.list).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
  })

  it('clears stale detail when the refreshed plugin is no longer available', async () => {
    mockedPluginsApi.detail.mockRejectedValue(new Error('DO_NOT_RENDER_SERVER_ERROR'))
    usePluginStore.setState({ selectedPlugin: { id: 'stale-plugin' } as never })

    await usePluginStore.getState().fetchPluginDetail('stale-plugin', '/workspace/project')

    expect(usePluginStore.getState().selectedPlugin).toBeNull()
    expect(usePluginStore.getState().error).toBe('PLUGIN_REQUEST_FAILED')
  })
})
