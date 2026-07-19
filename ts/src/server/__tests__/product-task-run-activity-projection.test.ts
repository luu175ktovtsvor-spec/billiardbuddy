import { describe, expect, it } from 'bun:test'
import type { ProductTaskEvent } from '../../../shared/product/taskEvents.js'
import type { ServerMessage } from '../ws/events.js'
import { ProductTaskRunActivityProjector } from '../product/taskEventProjection.js'

function onlyActivity(events: ProductTaskEvent[]): Extract<ProductTaskEvent, { type: 'activity' }> {
  expect(events).toHaveLength(1)
  const event = events[0]
  if (!event || event.type !== 'activity') {
    throw new Error('expected one product activity')
  }
  return event
}

describe('product task run activity projection', () => {
  it('uses stable opaque IDs for a tool tree without copying Core payloads', () => {
    const productTaskId = 'product-task-42'
    const parentToolUseId = 'core-agent-use-PRIVATE'
    const childToolUseId = 'core-command-use-PRIVATE'
    const privatePath = '/Users/private/ledger.csv'
    const privatePrompt = 'PRIVATE_PROMPT'
    const privateResult = 'PRIVATE_TOOL_RESULT'
    const projector = new ProductTaskRunActivityProjector(productTaskId)

    const parent = onlyActivity(projector.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Agent',
      toolUseId: parentToolUseId,
    }))
    const started = onlyActivity(projector.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId: childToolUseId,
      parentToolUseId,
    }))
    const running = onlyActivity(projector.project({
      type: 'tool_use_complete',
      toolName: 'Bash',
      toolUseId: childToolUseId,
      parentToolUseId,
      input: { command: `cat ${privatePath}`, prompt: privatePrompt },
    }))
    const completed = onlyActivity(projector.project({
      type: 'tool_result',
      toolUseId: childToolUseId,
      parentToolUseId,
      content: { stdout: privateResult, path: privatePath },
      isError: false,
    }))
    const connected = projector.project({ type: 'connected', sessionId: 'core-session-PRIVATE' })
    const parentId = parent.id
    const childId = started.id

    expect(parent).toMatchObject({
      id: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
      kind: 'subtask',
      phase: 'started',
      summary: '正在协同处理事项',
    })
    expect(started).toMatchObject({
      id: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
      parentId,
      kind: 'command',
      phase: 'started',
      summary: '正在处理任务操作',
    })
    expect(running).toMatchObject({
      id: childId,
      parentId,
      kind: 'command',
      phase: 'running',
      summary: '正在处理任务操作',
    })
    expect(completed).toMatchObject({
      id: childId,
      parentId,
      kind: 'command',
      phase: 'completed',
      summary: '已完成任务操作',
    })
    expect(connected).toEqual([{ type: 'connected' }])

    const afterReconnect = new ProductTaskRunActivityProjector(productTaskId)
    const reconnectedStart = onlyActivity(afterReconnect.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId: childToolUseId,
      parentToolUseId,
    }))
    const otherTask = new ProductTaskRunActivityProjector('product-task-43')
    const otherTaskStart = onlyActivity(otherTask.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId: childToolUseId,
      parentToolUseId,
    }))
    expect(reconnectedStart.id).toBe(childId)
    expect(otherTaskStart.id).not.toBe(childId)

    const serialized = JSON.stringify([parent, started, running, completed, connected])
    for (const secret of [
      productTaskId,
      parentToolUseId,
      childToolUseId,
      'core-session-PRIVATE',
      privatePath,
      privatePrompt,
      privateResult,
      'Agent',
      'Bash',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('projects structured background-task and team progress without raw descriptions', () => {
    const taskId = 'background-task-PRIVATE'
    const parentToolUseId = 'background-parent-PRIVATE'
    const teamName = 'team-PRIVATE'
    const privatePath = '/Users/private/output.txt'
    const projector = new ProductTaskRunActivityProjector('product-task-activity')

    const taskStarted = onlyActivity(projector.project({
      type: 'system_notification',
      subtype: 'task_started',
      message: `PRIVATE_DESCRIPTION ${privatePath}`,
      data: {
        task_id: taskId,
        tool_use_id: parentToolUseId,
        description: `PRIVATE_PROMPT ${privatePath}`,
        prompt: 'PRIVATE_PROMPT',
      },
    }))
    const taskProgress = onlyActivity(projector.project({
      type: 'system_notification',
      subtype: 'task_progress',
      message: 'PRIVATE_TASK_PROGRESS',
      data: {
        task_id: taskId,
        tool_use_id: parentToolUseId,
        summary: 'PRIVATE_SUMMARY',
        last_tool_name: 'PRIVATE_TOOL_NAME',
      },
    }))
    const taskCompleted = onlyActivity(projector.project({
      type: 'system_notification',
      subtype: 'task_notification',
      message: 'PRIVATE_TASK_NOTIFICATION',
      data: {
        task_id: taskId,
        tool_use_id: parentToolUseId,
        status: 'completed',
        output_file: privatePath,
        summary: 'PRIVATE_SUMMARY',
        result: 'PRIVATE_RESULT',
      },
    }))
    const teamCreated = onlyActivity(projector.project({ type: 'team_created', teamName }))
    const teamRunning = onlyActivity(projector.project({
      type: 'team_update',
      teamName,
      members: [
        { agentId: 'PRIVATE_AGENT_A', role: 'PRIVATE_ROLE', status: 'completed', currentTask: privatePath },
        { agentId: 'PRIVATE_AGENT_B', role: 'PRIVATE_ROLE', status: 'running', currentTask: 'PRIVATE_CURRENT_TASK' },
      ],
    }))
    const teamCompleted = onlyActivity(projector.project({
      type: 'team_update',
      teamName,
      members: [
        { agentId: 'PRIVATE_AGENT_A', role: 'PRIVATE_ROLE', status: 'completed' },
        { agentId: 'PRIVATE_AGENT_B', role: 'PRIVATE_ROLE', status: 'completed' },
      ],
    }))
    const legacyTask = onlyActivity(projector.project({
      type: 'task_update',
      taskId: 'legacy-task-PRIVATE',
      status: 'in_progress',
      progress: 'PRIVATE_LEGACY_PROGRESS',
    }))

    expect(taskStarted).toMatchObject({
      kind: 'subtask',
      phase: 'started',
      summary: '正在协同处理事项',
      parentId: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
    })
    expect(taskProgress).toMatchObject({ id: taskStarted.id, phase: 'running' })
    expect(taskCompleted).toMatchObject({ id: taskStarted.id, phase: 'completed' })
    expect(teamCreated).toMatchObject({ kind: 'subtask', phase: 'started' })
    expect(teamRunning).toMatchObject({
      id: teamCreated.id,
      phase: 'running',
      progress: { completed: 1, total: 2 },
    })
    expect(teamCompleted).toMatchObject({
      id: teamCreated.id,
      phase: 'completed',
      progress: { completed: 2, total: 2 },
    })
    expect(legacyTask).toMatchObject({
      kind: 'subtask',
      phase: 'running',
      summary: '正在协同处理事项',
    })

    const serialized = JSON.stringify([
      taskStarted,
      taskProgress,
      taskCompleted,
      teamCreated,
      teamRunning,
      teamCompleted,
      legacyTask,
    ])
    for (const secret of [
      taskId,
      parentToolUseId,
      teamName,
      privatePath,
      'PRIVATE_DESCRIPTION',
      'PRIVATE_PROMPT',
      'PRIVATE_TASK_PROGRESS',
      'PRIVATE_TASK_NOTIFICATION',
      'PRIVATE_SUMMARY',
      'PRIVATE_RESULT',
      'PRIVATE_TOOL_NAME',
      'PRIVATE_AGENT_A',
      'PRIVATE_ROLE',
      'PRIVATE_CURRENT_TASK',
      'PRIVATE_LEGACY_PROGRESS',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('keeps plan-related tool activity productized and omits signals without a reliable activity identity', () => {
    const projector = new ProductTaskRunActivityProjector('product-task-boundary', {
      maxTrackedActivities: 1,
    })
    const planned = onlyActivity(projector.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'TodoWrite',
      toolUseId: 'plan-tool-PRIVATE',
    }))
    const firstTool = onlyActivity(projector.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId: 'first-tool-PRIVATE',
    }))
    const secondTool = onlyActivity(projector.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'WebSearch',
      toolUseId: 'second-tool-PRIVATE',
    }))
    const evictedResult = onlyActivity(projector.project({
      type: 'tool_result',
      toolUseId: 'first-tool-PRIVATE',
      content: { private: 'PRIVATE_RESULT' },
      isError: false,
    }))
    const rememberedResult = onlyActivity(projector.project({
      type: 'tool_result',
      toolUseId: 'second-tool-PRIVATE',
      content: { private: 'PRIVATE_RESULT' },
      isError: false,
    }))

    expect(planned).toMatchObject({
      kind: 'workspace',
      phase: 'started',
      summary: '正在整理任务计划',
    })
    expect(evictedResult).toMatchObject({
      id: firstTool.id,
      kind: 'tool',
      phase: 'completed',
      summary: '已完成任务处理',
    })
    expect(rememberedResult).toMatchObject({
      id: secondTool.id,
      kind: 'research',
      phase: 'completed',
      summary: '已完成资料查询',
    })

    expect(projector.project({
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
    })).toEqual([])
    expect(projector.project({
      type: 'system_notification',
      subtype: 'task_progress',
      message: 'PRIVATE_MESSAGE',
      data: { task_id: ' task-id-with-whitespace ' },
    })).toEqual([])
    expect(projector.project({
      type: 'team_update',
      teamName: 'team-idle-PRIVATE',
      members: [{ agentId: 'PRIVATE_AGENT', role: 'PRIVATE_ROLE', status: 'idle' }],
    })).toEqual([])
    expect(projector.project({ type: 'team_deleted', teamName: 'team-idle-PRIVATE' })).toEqual([])
    expect(projector.project({
      type: 'task_update',
      taskId: 'task-stopped-PRIVATE',
      status: 'stopped',
      progress: 'PRIVATE_PROGRESS',
    })).toEqual([])
    expect(projector.project({
      type: 'system_notification',
      subtype: 'compact_boundary',
      message: 'PRIVATE_COMPACT_SUMMARY',
      data: { prompt: 'PRIVATE_PROMPT' },
    })).toEqual([{ type: 'status', state: 'working' }])
  })

  it('accepts only a bounded persistent product task identity', () => {
    expect(() => new ProductTaskRunActivityProjector('')).toThrow()
    expect(() => new ProductTaskRunActivityProjector('product-task', { maxTrackedActivities: 0 })).toThrow()
    expect(() => new ProductTaskRunActivityProjector('product-task', { maxTrackedActivities: 1_025 })).toThrow()
  })
})
