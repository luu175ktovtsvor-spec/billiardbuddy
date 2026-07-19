import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { McpSettings } from '../pages/McpSettings'
import { useMcpStore } from '../stores/mcpStore'
import { useSettingsStore } from '../stores/settingsStore'
import { PRODUCT_TASK_TAB_PREFIX, useTabStore } from '../stores/tabStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../product/stores/productTaskStore'
import type { McpServerRecord } from '../types/mcp'

function makeServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    name: 'context7',
    scope: 'local',
    transport: 'stdio',
    enabled: true,
    status: 'connected',
    canEdit: true,
    canRemove: true,
    canReconnect: true,
    canToggle: true,
    projectPath: '/workspace/project',
    ...overrides,
  }
}

async function renderLoadedMcpSettings() {
  const result = render(<McpSettings />)
  await waitFor(() => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
  return result
}

describe('McpSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: '__settings__',
      lastActiveProductTaskId: 'task-1',
      tabs: [
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: 'Test task',
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
        projects: [{
          id: 'project-selected',
          title: 'selected-project',
          workDir: '/workspace/selected-project',
          taskCount: 1,
          archivedTaskCount: 0,
          updatedAt: '2026-05-25T00:00:00.000Z',
        }],
        tasks: [{
          id: 'task-1',
          projectId: 'project-current',
          workDir: '/workspace/project',
          title: 'Test task',
          lifecycle: 'active',
          kind: 'main',
          createdAt: '2026-05-25T00:00:00.000Z',
          updatedAt: '2026-05-25T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: ['rename'],
        }],
        total: 1,
      },
    })
    useMcpStore.setState({
      servers: [],
      selectedServer: null,
      isLoading: false,
      error: null,
      fetchServers: vi.fn().mockResolvedValue(undefined),
      createServer: vi.fn(),
      updateServer: vi.fn(),
      deleteServer: vi.fn(),
      toggleServer: vi.fn(),
      reconnectServer: vi.fn(),
      refreshServerStatus: vi.fn(),
      selectServer: vi.fn(),
    })
  })

  it('loads only the active product task and indexed project contexts', async () => {
    const fetchServers = vi.fn().mockResolvedValue(undefined)
    useMcpStore.setState({ fetchServers })

    render(<McpSettings />)

    await waitFor(() => {
      expect(fetchServers).toHaveBeenCalledWith(
        ['/workspace/project', '/workspace/selected-project'],
        '/workspace/project',
      )
    })
  })

  it('shows safe names and states without rendering forged legacy configuration fields', async () => {
    const legacyServer = {
      ...makeServer(),
      summary: 'npx context7 --api-key MCP_SUMMARY_SECRET',
      statusDetail: 'MCP_STATUS_SECRET',
      configLocation: '/private/MCP_CONFIG_PATH_SECRET',
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['--api-key', 'MCP_ARGUMENT_SECRET'],
        env: { TOKEN: 'MCP_ENV_SECRET' },
      },
    } as unknown as McpServerRecord
    useMcpStore.setState({ servers: [legacyServer] })

    await renderLoadedMcpSettings()

    expect(screen.getByText('context7')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    for (const privateValue of [
      'MCP_SUMMARY_SECRET',
      'MCP_STATUS_SECRET',
      'MCP_CONFIG_PATH_SECRET',
      'MCP_ARGUMENT_SECRET',
      'MCP_ENV_SECRET',
    ]) {
      expect(document.body.textContent).not.toContain(privateValue)
    }
  })

  it('replaces an editable connection without pre-filling its saved configuration', async () => {
    const server = makeServer()
    const updateServer = vi.fn().mockResolvedValue(server)
    useMcpStore.setState({ servers: [server], updateServer })

    await renderLoadedMcpSettings()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manage context7' }))
    })

    expect(screen.getByText('Existing connection settings are not displayed. Saving this form replaces the connection with the values you provide.')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('npx')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'npx' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(updateServer).toHaveBeenCalledWith(
      server,
      {
        scope: 'local',
        config: { type: 'stdio', command: 'npx', args: [], env: {} },
      },
      '/workspace/project',
    )
  })

  it('keeps provider-managed connections inspectable and reconnectable without implementation details', async () => {
    const server = makeServer({
      name: 'provider-managed',
      scope: 'dynamic',
      transport: 'stdio',
      canEdit: false,
      canRemove: false,
      projectPath: undefined,
    })
    const reconnectServer = vi.fn().mockResolvedValue({ ...server, status: 'connected' as const })
    useMcpStore.setState({ servers: [server], reconnectServer })

    await renderLoadedMcpSettings()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Manage provider-managed' }))
    })

    expect(screen.getByText('This connection is managed outside the app. Its implementation details are not shown here.')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Reconnect/ }))
    })
    expect(reconnectServer).toHaveBeenCalledWith(server, '/workspace/project')
  })

  it('uses the active product task when toggling a connection', async () => {
    const server = makeServer()
    const toggleServer = vi.fn().mockResolvedValue({ ...server, enabled: false })
    useMcpStore.setState({ servers: [server], toggleServer })

    await renderLoadedMcpSettings()
    await act(async () => {
      fireEvent.click(screen.getByRole('switch'))
    })

    expect(toggleServer).toHaveBeenCalledWith(server, '/workspace/project', 'task-1')
  })

  it('creates a connection only after the user supplies the required advanced fields', async () => {
    const created = makeServer({ name: 'new-connection' })
    const createServer = vi.fn().mockResolvedValue(created)
    useMcpStore.setState({ createServer })

    await renderLoadedMcpSettings()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Add connection/ }))
    })

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'new-connection' } })
    fireEvent.change(screen.getByLabelText(/Command to launch/), { target: { value: 'npx' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(createServer).toHaveBeenCalledWith(
      'new-connection',
      {
        scope: 'local',
        config: { type: 'stdio', command: 'npx', args: [], env: {} },
      },
      '/workspace/project',
    )
  })

  it('uses a generic load error instead of a transport error message', async () => {
    useMcpStore.setState({ error: 'https://private.example/MCP_ERROR_SECRET' })

    await renderLoadedMcpSettings()

    expect(screen.getByText('Connections could not be loaded right now.')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('MCP_ERROR_SECRET')
  })
})
