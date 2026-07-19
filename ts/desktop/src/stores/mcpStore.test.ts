import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApi } from '../api/mcp'
import { useMcpStore } from './mcpStore'
import type { McpServerRecord } from '../types/mcp'

vi.mock('../api/mcp', () => ({
  mcpApi: {
    toggle: vi.fn(),
  },
}))

const mockedMcpApi = vi.mocked(mcpApi)

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

describe('mcpStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const server = makeServer()
    useMcpStore.setState({
      servers: [server],
      selectedServer: server,
      isLoading: false,
      error: null,
    })
  })

  it('keeps the server update and task sync result from a task-aware toggle', async () => {
    const server = makeServer()
    const taskSync = { applied: false as const, reason: 'not_running' as const }
    mockedMcpApi.toggle.mockResolvedValue({
      server: { ...server, enabled: false },
      taskSync,
    })

    const result = await useMcpStore.getState().toggleServer(
      server,
      '/workspace/project',
      'task-1',
    )

    expect(mockedMcpApi.toggle).toHaveBeenCalledWith(
      'context7',
      '/workspace/project',
      'task-1',
    )
    expect(result).toEqual({
      server: { ...server, enabled: false },
      taskSync,
    })
    expect(useMcpStore.getState().servers).toEqual([{ ...server, enabled: false }])
    expect(useMcpStore.getState().selectedServer).toEqual({ ...server, enabled: false })
  })
})
