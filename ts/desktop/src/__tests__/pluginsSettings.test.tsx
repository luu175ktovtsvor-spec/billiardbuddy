import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { ApiError } from '../api/client'
import { usePluginStore } from '../stores/pluginStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { PRODUCT_TASK_TAB_PREFIX, useTabStore } from '../stores/tabStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../product/stores/productTaskStore'
import type { PluginDetail, PluginSummary } from '../types/plugin'

const noop = vi.fn()

function makePlugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  const {
    descriptionKind = 'workspace_extension',
    ...otherOverrides
  } = overrides

  return {
    id: 'github@safe-market',
    name: 'github',
    scope: 'user',
    enabled: true,
    status: 'enabled',
    canManage: true,
    descriptionKind,
    componentCounts: {
      commands: 1,
      agents: 1,
      skills: 2,
      hooks: 1,
      mcpServers: 1,
      lspServers: 0,
    },
    ...otherOverrides,
  }
}

function makeTaskReload(overrides: Partial<{
  applied: boolean
  reason: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
}> = {}) {
  return {
    applied: true,
    commands: 1,
    agents: 1,
    plugins: 1,
    mcpServers: 1,
    errors: 0,
    ...overrides,
  }
}

function makeReloadResult(overrides: Partial<{
  task: ReturnType<typeof makeTaskReload>
}> = {}) {
  return {
    summary: {
      enabled: 1,
      disabled: 0,
      skills: 2,
      agents: 1,
      hooks: 0,
      mcpServers: 1,
      lspServers: 0,
      errors: 0,
    },
    task: makeTaskReload(),
    ...overrides,
  }
}

function switchToPluginsTab() {
  fireEvent.click(screen.getByText('Plugins'))
}

describe('Settings > Plugins tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'plugins', pendingSettingsTab: null, toasts: [] })
    useTabStore.setState({
      activeTabId: '__settings__',
      lastActiveProductTaskId: 'task-1',
      tabs: [
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: 'Active task',
          type: 'product-task',
          status: 'idle',
          taskId: 'task-1',
        },
        {
          sessionId: '__settings__',
          title: 'Settings',
          type: 'settings',
          status: 'idle',
        },
      ],
    })
    useProductTaskStore.setState({
      index: {
        ...EMPTY_PRODUCT_TASK_INDEX,
        tasks: [{
          id: 'task-1',
          projectId: 'project-1',
          workDir: '/workspace/project',
          title: 'Active task',
          lifecycle: 'active',
          kind: 'main',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: ['rename'],
        }],
        total: 1,
      },
    })
    usePluginStore.setState({
      plugins: [],
      summary: { total: 0, enabled: 0, attention: 0 },
      selectedPlugin: null,
      lastReloadSummary: null,
      lastTaskReloadSummary: null,
      isLoading: false,
      isDetailLoading: false,
      isApplying: false,
      error: null,
      fetchPlugins: noop,
      fetchPluginDetail: noop,
      reloadPlugins: vi.fn().mockResolvedValue(makeReloadResult()),
      enablePlugin: vi.fn().mockResolvedValue({ action: 'enabled', task: makeTaskReload() }),
      disablePlugin: vi.fn().mockResolvedValue({ action: 'disabled', task: makeTaskReload() }),
      bulkEnablePlugins: vi.fn().mockResolvedValue({ changed: 0, task: makeTaskReload() }),
      bulkDisablePlugins: vi.fn().mockResolvedValue({ changed: 0, task: makeTaskReload() }),
      updatePlugin: vi.fn().mockResolvedValue({ action: 'updated', task: makeTaskReload() }),
      uninstallPlugin: vi.fn().mockResolvedValue({ action: 'uninstalled', task: makeTaskReload() }),
      clearSelection: vi.fn(),
    })
  })

  it('renders only product-safe plugin summaries in the list', () => {
    const pluginWithPrivateExtras = {
      ...makePlugin(),
      description: 'DO_NOT_RENDER_MANIFEST_DESCRIPTION',
      installPath: '/Users/test/.claude/plugins/private',
      projectPath: '/workspace/private-project',
      errors: ['DO_NOT_RENDER_RAW_ERROR'],
      marketplace: 'https://private.example.test/marketplace',
    } as PluginSummary
    const attentionPlugin = makePlugin({
      id: 'pyright@safe-market',
      name: 'pyright',
      enabled: false,
      status: 'attention',
      componentCounts: {
        commands: 0,
        agents: 0,
        skills: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 1,
      },
    })

    usePluginStore.setState({
      plugins: [pluginWithPrivateExtras, attentionPlugin],
      summary: { total: 2, enabled: 1, attention: 1 },
    })

    render(<Settings />)
    switchToPluginsTab()

    expect(screen.getByText('Browse installed plugins')).toBeInTheDocument()
    expect(screen.getByText('Plugin Manager')).toBeInTheDocument()
    expect(screen.getAllByText('Needs attention').length).toBeGreaterThan(0)
    expect(screen.getByText('github')).toBeInTheDocument()
    expect(screen.getByText('pyright')).toBeInTheDocument()
    expect(screen.getAllByText('Adds optional capabilities to the desktop assistant. Configuration details remain private.')).toHaveLength(2)
    expect(screen.queryByText('DO_NOT_RENDER_MANIFEST_DESCRIPTION')).not.toBeInTheDocument()
    expect(screen.queryByText('/Users/test/.claude/plugins/private')).not.toBeInTheDocument()
    expect(screen.queryByText('DO_NOT_RENDER_RAW_ERROR')).not.toBeInTheDocument()
    expect(screen.queryByText('https://private.example.test/marketplace')).not.toBeInTheDocument()
    expect(screen.queryByText('Known marketplaces')).not.toBeInTheDocument()
  })

  it('bulk enables selected editable plugins and preserves real action targets', async () => {
    const bulkEnablePlugins = vi.fn().mockResolvedValue({ changed: 2, task: makeTaskReload() })
    usePluginStore.setState({
      plugins: [
        makePlugin({
          id: 'drawing@safe-market',
          name: 'drawing',
          enabled: false,
          status: 'disabled',
          componentCounts: { commands: 0, agents: 0, skills: 1, hooks: 0, mcpServers: 0, lspServers: 0 },
        }),
        makePlugin({
          id: 'review@safe-market',
          name: 'review',
          scope: 'project',
          enabled: false,
          status: 'disabled',
          componentCounts: { commands: 0, agents: 1, skills: 0, hooks: 0, mcpServers: 0, lspServers: 0 },
        }),
      ],
      summary: { total: 2, enabled: 0, attention: 0 },
      bulkEnablePlugins,
    })

    render(<Settings />)
    switchToPluginsTab()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select drawing' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable selected' }))

    expect(screen.getByText('Enable 2 selected plugins?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))

    await waitFor(() => {
      expect(bulkEnablePlugins).toHaveBeenCalledWith(
        [
          { id: 'drawing@safe-market', scope: 'user' },
          { id: 'review@safe-market', scope: 'project' },
        ],
        '/workspace/project',
        'task-1',
      )
    })
  })

  it('shows capability counts and controls without rendering implementation details or cross-page links', () => {
    const selectedPlugin = {
      ...makePlugin(),
      commandEntries: [{ name: 'private-command', description: 'DO_NOT_RENDER_COMMAND' }],
      hookEntries: [{ event: 'PreToolUse', actions: ['DO_NOT_RENDER_HOOK --secret'] }],
      mcpServerEntries: [{ name: 'private-server', summary: 'https://private.example.test/mcp?secret=1' }],
      skillEntries: [{ name: 'private-skill', description: 'DO_NOT_RENDER_SKILL' }],
      installPath: '/Users/test/.claude/plugins/private',
      errors: ['DO_NOT_RENDER_RAW_ERROR'],
    } as PluginDetail
    usePluginStore.setState({ selectedPlugin })

    render(<Settings />)
    switchToPluginsTab()

    expect(screen.getByText('Plugin Detail')).toBeInTheDocument()
    expect(screen.getByText('Capability summary')).toBeInTheDocument()
    expect(screen.getByText('Adds optional capabilities to the desktop assistant. Configuration details remain private.')).toBeInTheDocument()
    expect(screen.getAllByText('Skills').length).toBeGreaterThan(0)
    expect(screen.getByText('Apply changes')).toBeInTheDocument()
    expect(screen.getByText('Uninstall')).toBeInTheDocument()
    expect(screen.queryByText('DO_NOT_RENDER_COMMAND')).not.toBeInTheDocument()
    expect(screen.queryByText('DO_NOT_RENDER_HOOK --secret')).not.toBeInTheDocument()
    expect(screen.queryByText('https://private.example.test/mcp?secret=1')).not.toBeInTheDocument()
    expect(screen.queryByText('DO_NOT_RENDER_SKILL')).not.toBeInTheDocument()
    expect(screen.queryByText('/Users/test/.claude/plugins/private')).not.toBeInTheDocument()
    expect(screen.queryByText('DO_NOT_RENDER_RAW_ERROR')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /private-command/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /private-skill/i })).not.toBeInTheDocument()
  })

  it('uses a localized generic error message instead of a server error string', () => {
    usePluginStore.setState({ error: 'PLUGIN_ACTION_FAILED' })

    render(<Settings />)
    switchToPluginsTab()

    expect(screen.getByText('The plugin action could not be completed. Try again after applying changes.')).toBeInTheDocument()
  })

  it('warns when saved plugin configuration cannot be applied because the current task is not running', async () => {
    const reloadPlugins = vi.fn().mockResolvedValue(makeReloadResult({
      task: makeTaskReload({ applied: false, reason: 'not_running', commands: 0, agents: 0, plugins: 0, mcpServers: 0 }),
    }))
    usePluginStore.setState({
      plugins: [makePlugin()],
      summary: { total: 1, enabled: 1, attention: 0 },
      reloadPlugins,
    })

    render(<Settings />)
    switchToPluginsTab()
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }))

    await waitFor(() => {
      expect(reloadPlugins).toHaveBeenCalledWith('/workspace/project', 'task-1')
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        type: 'warning',
        message: 'Plugin configuration was saved, but the current task was not updated. It will take effect the next time the task runs.',
      })
    })
  })

  it('warns instead of claiming success when a plugin action cannot sync to the current task', async () => {
    const disablePlugin = vi.fn().mockResolvedValue({
      action: 'disabled',
      task: makeTaskReload({ applied: false, reason: 'failed', commands: 0, agents: 0, plugins: 0, mcpServers: 0 }),
    })
    usePluginStore.setState({
      selectedPlugin: makePlugin(),
      disablePlugin,
    })

    render(<Settings />)
    switchToPluginsTab()
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))

    await waitFor(() => {
      expect(disablePlugin).toHaveBeenCalledWith(
        'github@safe-market',
        'user',
        '/workspace/project',
        'task-1',
      )
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        type: 'warning',
        message: 'Plugin configuration was saved, but it could not be applied to the current task. Try again or it will take effect the next time the task runs.',
      })
    })
  })

  it('shows a safe task-unavailable error instead of a successful apply message', async () => {
    const reloadPlugins = vi.fn().mockRejectedValue(new ApiError(503, {
      error: 'PRODUCT_TASK_UNAVAILABLE',
    }))
    usePluginStore.setState({
      plugins: [makePlugin()],
      summary: { total: 1, enabled: 1, attention: 0 },
      reloadPlugins,
    })

    render(<Settings />)
    switchToPluginsTab()
    fireEvent.click(screen.getByRole('button', { name: /Apply changes/ }))

    await waitFor(() => {
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        type: 'error',
        message: 'The current task is unavailable. Plugin changes were not applied to it.',
      })
    })
  })
})
