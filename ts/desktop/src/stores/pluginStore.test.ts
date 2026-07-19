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
      task: {
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
      lastTaskReloadSummary: null,
      isLoading: false,
      isDetailLoading: false,
      isApplying: false,
      error: null,
    })
  })

  it('reloads the active product task after enabling a plugin', async () => {
    mockedPluginsApi.enable.mockResolvedValue({
      ok: true,
      action: 'enabled',
    })

    const result = await usePluginStore
      .getState()
      .enablePlugin('draw@test', 'user', '/workspace/project', 'task-1')

    expect(result).toEqual({
      action: 'enabled',
      task: {
        applied: true,
        commands: 1,
        agents: 0,
        plugins: 1,
        mcpServers: 0,
        errors: 0,
      },
    })
    expect(mockedPluginsApi.enable).toHaveBeenCalledWith({
      id: 'draw@test',
      scope: 'user',
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'task-1',
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
    expect(usePluginStore.getState().lastTaskReloadSummary).toEqual({
      applied: true,
      commands: 1,
      agents: 0,
      plugins: 1,
      mcpServers: 0,
      errors: 0,
    })
  })

  it('reloads and refreshes once after bulk enabling plugins', async () => {
    mockedPluginsApi.enable.mockResolvedValue({
      ok: true,
      action: 'enabled',
    })

    const result = await usePluginStore.getState().bulkEnablePlugins(
      [
        { id: 'draw@test', scope: 'user' },
        { id: 'review@test', scope: 'project' },
      ],
      '/workspace/project',
      'task-1',
    )

    expect(result).toMatchObject({ changed: 2, task: { applied: true } })
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
      'task-1',
    )
    expect(mockedPluginsApi.list).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
  })

  it('reloads and refreshes once after bulk disabling plugins', async () => {
    mockedPluginsApi.disable.mockResolvedValue({
      ok: true,
      action: 'disabled',
    })

    const result = await usePluginStore.getState().bulkDisablePlugins(
      [
        { id: 'github@test', scope: 'user' },
        { id: 'review@test', scope: 'project' },
      ],
      '/workspace/project',
      'task-1',
    )

    expect(result).toMatchObject({ changed: 2, task: { applied: true } })
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
      'task-1',
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

  it('preserves a task sync result when plugin configuration is not applied to a running task', async () => {
    const task = {
      applied: false,
      reason: 'not_running' as const,
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
    }
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
      task,
    })

    const result = await usePluginStore.getState().reloadPlugins('/workspace/project', 'task-1')

    expect(result).toMatchObject({ task })
    expect(usePluginStore.getState().lastTaskReloadSummary).toEqual(task)
  })
})
