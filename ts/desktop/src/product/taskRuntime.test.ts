import { describe, expect, it } from 'vitest'
import {
  getProductTaskRuntimeStateFromStream,
  type ProductTaskStreamRuntime,
} from './taskRuntime'

function makeStreamRuntime(
  overrides: Partial<ProductTaskStreamRuntime> = {},
): ProductTaskStreamRuntime {
  return {
    connectionState: 'connected',
    runState: 'idle',
    pendingApproval: null,
    error: null,
    ...overrides,
  }
}

describe('getProductTaskRuntimeStateFromStream', () => {
  it('uses the product task stream rather than a generic Agent Core session', () => {
    expect(getProductTaskRuntimeStateFromStream(undefined)).toBe('not_connected')
    expect(getProductTaskRuntimeStateFromStream(makeStreamRuntime({ connectionState: 'connecting' }))).toBe('connecting')
    expect(getProductTaskRuntimeStateFromStream(makeStreamRuntime({ runState: 'working' }))).toBe('running')
    expect(getProductTaskRuntimeStateFromStream(makeStreamRuntime({
      runState: 'awaiting_approval',
      pendingApproval: { requestId: 'approval-1' },
    }))).toBe('awaiting_approval')
    expect(getProductTaskRuntimeStateFromStream(makeStreamRuntime({ error: { code: 'task_failed' } }))).toBe('needs_attention')
    expect(getProductTaskRuntimeStateFromStream(makeStreamRuntime())).toBe('idle')
  })
})
