import { describe, expect, it } from 'bun:test'
import { ProductTaskRunProjection } from './taskRunProjection.js'

describe('ProductTaskRunProjection', () => {
  it('keeps a product-safe, stable activity tree through a tool result', () => {
    const runs = new ProductTaskRunProjection()
    const taskId = 'task-public-42'
    const sessionId = 'core-session-PRIVATE'
    const parentToolUseId = 'core-parent-PRIVATE'
    const toolUseId = 'core-tool-PRIVATE'
    const privatePath = '/Users/private/hall-ledger.csv'

    runs.beginRun(taskId, sessionId)
    runs.projectSessionMessage(sessionId, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Agent',
      toolUseId: parentToolUseId,
    })
    runs.projectSessionMessage(sessionId, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId,
      parentToolUseId,
    })
    runs.projectSessionMessage(sessionId, {
      type: 'tool_result',
      toolUseId,
      parentToolUseId,
      content: { path: privatePath, stdout: 'PRIVATE_OUTPUT' },
      isError: false,
    })

    const snapshot = runs.getSnapshot(taskId, sessionId)
    expect(snapshot).toMatchObject({ state: 'working' })
    expect(snapshot.activities).toHaveLength(2)
    const [parent, child] = snapshot.activities
    expect(parent).toMatchObject({
      id: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
      kind: 'subtask',
      phase: 'started',
      summary: '正在协同处理事项',
    })
    expect(child).toMatchObject({
      id: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
      parentId: parent?.id,
      kind: 'command',
      phase: 'completed',
      summary: '已完成任务操作',
    })

    const serialized = JSON.stringify(snapshot)
    for (const privateValue of [
      taskId,
      sessionId,
      parentToolUseId,
      toolUseId,
      privatePath,
      'PRIVATE_OUTPUT',
      'Agent',
      'Bash',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('resets only on an accepted new run and settles completed runs to idle', () => {
    const runs = new ProductTaskRunProjection()
    const taskId = 'task-public-reset'
    const sessionId = 'core-session-reset'

    runs.beginRun(taskId, sessionId)
    runs.projectSessionMessage(sessionId, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Read',
      toolUseId: 'old-tool',
    })
    expect(runs.getSnapshot(taskId, sessionId).activities).toHaveLength(1)

    runs.beginRun(taskId, sessionId)
    expect(runs.getSnapshot(taskId, sessionId)).toEqual({ state: 'working', activities: [] })

    runs.projectSessionMessage(sessionId, {
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(runs.getSnapshot(taskId, sessionId)).toEqual({ state: 'idle', activities: [] })
  })

  it('bounds snapshots and removes private session associations during cleanup', () => {
    const runs = new ProductTaskRunProjection()
    const taskId = 'task-public-boundary'
    const sessionId = 'core-session-boundary'
    runs.beginRun(taskId, sessionId)

    for (let index = 0; index < 257; index++) {
      runs.projectSessionMessage(sessionId, {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: `core-tool-${index}`,
      })
    }

    const snapshot = runs.getSnapshot(taskId, sessionId)
    expect(snapshot.activities).toHaveLength(256)
    expect(runs.hasActiveRunForSession(sessionId)).toBe(true)

    runs.removeSession(sessionId)
    expect(runs.hasActiveRunForSession(sessionId)).toBe(false)
    expect(runs.projectSessionMessage(sessionId, {
      type: 'status',
      state: 'thinking',
    })).toEqual(new Map())
  })
})
