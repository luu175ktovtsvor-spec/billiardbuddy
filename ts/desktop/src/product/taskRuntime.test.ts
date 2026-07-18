import { describe, expect, it } from 'vitest'
import {
  getProductTaskRuntimeState,
  type ProductTaskSessionRuntime,
} from './taskRuntime'

function makeSession(
  overrides: Partial<ProductTaskSessionRuntime> = {},
): ProductTaskSessionRuntime {
  return {
    chatState: 'idle',
    connectionState: 'connected',
    pendingPermission: null,
    pendingComputerUsePermission: null,
    backgroundAgentTasks: {},
    ...overrides,
  }
}

describe('getProductTaskRuntimeState', () => {
  it('does not invent a run outcome when this desktop has no live Agent Core session', () => {
    expect(getProductTaskRuntimeState(undefined)).toBe('not_connected')
  })

  it('projects connection and idle states from the actual session', () => {
    expect(getProductTaskRuntimeState(makeSession({ connectionState: 'connecting' }))).toBe('connecting')
    expect(getProductTaskRuntimeState(makeSession({ connectionState: 'reconnecting' }))).toBe('connecting')
    expect(getProductTaskRuntimeState(makeSession({ connectionState: 'disconnected' }))).toBe('not_connected')
    expect(getProductTaskRuntimeState(makeSession())).toBe('idle')
  })

  it('projects every active chat state as running', () => {
    for (const chatState of ['thinking', 'compacting', 'tool_executing', 'streaming'] as const) {
      expect(getProductTaskRuntimeState(makeSession({ chatState }))).toBe('running')
    }
  })

  it('keeps a running background Agent visible after the foreground chat becomes idle', () => {
    expect(getProductTaskRuntimeState(makeSession({
      backgroundAgentTasks: {
        'agent-1': {
          taskId: 'agent-1',
          status: 'running',
          description: '核对台球厅库存',
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    }))).toBe('running')
  })

  it('gives real approval requests priority over the underlying chat activity', () => {
    expect(getProductTaskRuntimeState(makeSession({
      chatState: 'tool_executing',
      pendingPermission: {
        requestId: 'permission-1',
        toolName: 'Bash',
        input: { command: 'git status' },
      },
    }))).toBe('awaiting_approval')

    expect(getProductTaskRuntimeState(makeSession({
      chatState: 'permission_pending',
    }))).toBe('awaiting_approval')
  })

  it('surfaces the existing tab error state when no newer Agent activity has replaced it', () => {
    expect(getProductTaskRuntimeState(makeSession(), 'error')).toBe('needs_attention')
    expect(getProductTaskRuntimeState(undefined, 'running')).toBe('running')
  })
})
