import { afterEach, describe, expect, it, vi } from 'vitest'
import { productTaskCommandsApi } from './taskCommands'

const runtimeMocks = vi.hoisted(() => ({
  serverUrl: 'http://127.0.0.1:3456',
}))

vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => runtimeMocks.serverUrl,
}))

describe('productTaskCommandsApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    runtimeMocks.serverUrl = 'http://127.0.0.1:3456'
  })

  it('uses product routes, encodes the task work directory, and keeps discovery timeout generous', async () => {
    runtimeMocks.serverUrl = 'http://127.0.0.1:4567'
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        agents: [{ displayName: 'agent-guide', runtimeName: 'claude-code-guide' }],
      }))
      .mockResolvedValueOnce(Response.json({
        commands: [{
          runtimeName: 'venue-daily-review',
          displayName: '复盘今天经营',
          description: '把球房营业数据整理成经营复盘。',
        }],
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(productTaskCommandsApi.listAgents('/workspace/桌球厅')).resolves.toEqual({
      agents: [{ displayName: 'agent-guide', runtimeName: 'claude-code-guide' }],
    })
    await expect(productTaskCommandsApi.listSkills('/workspace/桌球厅')).resolves.toEqual({
      commands: [{
        runtimeName: 'venue-daily-review',
        displayName: '复盘今天经营',
        description: '把球房营业数据整理成经营复盘。',
      }],
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4567/api/product/task-commands/agents?cwd=%2Fworkspace%2F%E6%A1%8C%E7%90%83%E5%8E%85',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4567/api/product/task-commands/skills?cwd=%2Fworkspace%2F%E6%A1%8C%E7%90%83%E5%8E%85',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 120_000)
  })
})
