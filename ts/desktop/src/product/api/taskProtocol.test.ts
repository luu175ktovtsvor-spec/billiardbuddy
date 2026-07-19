import { describe, expect, it } from 'vitest'
import { parseProductTaskEvent, parseProductTaskThread } from './taskProtocol'

const safeAttachment = {
  type: 'image',
  name: '球桌截图.png',
  mimeType: 'image/png',
} as const

describe('product task protocol attachment summaries', () => {
  it('accepts a bounded safe attachment summary on replay and persisted user text', () => {
    expect(parseProductTaskEvent({
      type: 'user_text',
      text: '请查看附件',
      replayed: true,
      attachments: [safeAttachment],
    })).toEqual({
      type: 'user_text',
      text: '请查看附件',
      replayed: true,
      attachments: [safeAttachment],
    })

    expect(parseProductTaskThread({
      taskId: 'task-attachment',
      entries: [{
        id: 'thread-user-attachment',
        type: 'user_text',
        text: '请查看附件',
        attachments: [safeAttachment],
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }, 'task-attachment')).toEqual({
      taskId: 'task-attachment',
      entries: [{
        id: 'thread-user-attachment',
        type: 'user_text',
        text: '请查看附件',
        attachments: [safeAttachment],
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    })
  })

  it('rejects paths, raw source data, and unsupported attachment fields before they reach task state', () => {
    for (const value of [
      {
        type: 'user_text',
        text: '请查看附件',
        replayed: true,
        attachments: [{ type: 'file', name: 'report.pdf', path: '/private/report.pdf' }],
      },
      {
        type: 'user_text',
        text: '请查看附件',
        replayed: true,
        attachments: [{ type: 'image', name: 'table.png', data: 'data:image/png;base64,aGVsbG8=' }],
      },
      {
        type: 'user_text',
        text: '请查看附件',
        replayed: true,
        attachments: [{ type: 'file', name: 'report.pdf', mimeType: 'application/pdf' }],
      },
    ]) {
      expect(parseProductTaskEvent(value)).toBeNull()
    }

    expect(parseProductTaskThread({
      taskId: 'task-attachment',
      entries: [{
        id: 'thread-assistant-attachment',
        type: 'assistant_text',
        text: '不应携带附件',
        attachments: [safeAttachment],
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }, 'task-attachment')).toBeNull()
  })
})

describe('product task protocol run activities', () => {
  const activityId = `activity_${'a'.repeat(32)}`
  const parentId = `activity_${'b'.repeat(32)}`

  it('accepts the bounded opaque activity tree envelope', () => {
    expect(parseProductTaskEvent({
      type: 'activity',
      id: activityId,
      parentId,
      kind: 'subtask',
      phase: 'running',
      summary: '正在协同处理事项',
      progress: { completed: 1, total: 3 },
    })).toEqual({
      type: 'activity',
      id: activityId,
      parentId,
      kind: 'subtask',
      phase: 'running',
      summary: '正在协同处理事项',
      progress: { completed: 1, total: 3 },
    })

    // Live task activity is always a rich, opaque activity record.
    expect(parseProductTaskEvent({
      type: 'activity',
      kind: 'workspace',
      phase: 'completed',
    })).toBeNull()
  })

  it('rejects Core details and malformed identifiers before activity state is updated', () => {
    const privatePath = '/Users/private/.claude/task.json'
    for (const value of [
      {
        type: 'activity', id: activityId, kind: 'command', phase: 'running', summary: privatePath,
      },
      {
        type: 'activity', id: 'core-tool-use-id', kind: 'command', phase: 'running', summary: '正在处理任务操作',
      },
      {
        type: 'activity', id: activityId, parentId: activityId, kind: 'command', phase: 'running', summary: '正在处理任务操作',
      },
      {
        type: 'activity', id: activityId, kind: 'command', phase: 'running', summary: '正在处理任务操作', progress: { completed: 4, total: 3 },
      },
      {
        type: 'activity', id: activityId, kind: 'command', phase: 'running', summary: '正在处理任务操作', toolName: 'Bash',
      },
      {
        type: 'activity', kind: 'command', phase: 'running', summary: '正在处理任务操作',
      },
      {
        type: 'activity', id: activityId, kind: 'command', phase: 'running',
      },
    ]) {
      expect(parseProductTaskEvent(value)).toBeNull()
    }
  })
})

describe('product task protocol run snapshots', () => {
  const parentId = `activity_${'a'.repeat(32)}`
  const childId = `activity_${'b'.repeat(32)}`

  it('accepts a bounded task-scoped snapshot without Core identifiers', () => {
    expect(parseProductTaskEvent({
      type: 'run_snapshot',
      state: 'working',
      activities: [
        {
          id: parentId,
          kind: 'workspace',
          phase: 'running',
          summary: '正在整理任务计划',
        },
        {
          id: childId,
          parentId,
          kind: 'subtask',
          phase: 'running',
          summary: '正在协同处理事项',
          progress: { completed: 1, total: 2 },
        },
      ],
    })).toEqual({
      type: 'run_snapshot',
      state: 'working',
      activities: [
        {
          id: parentId,
          kind: 'workspace',
          phase: 'running',
          summary: '正在整理任务计划',
        },
        {
          id: childId,
          parentId,
          kind: 'subtask',
          phase: 'running',
          summary: '正在协同处理事项',
          progress: { completed: 1, total: 2 },
        },
      ],
    })
  })

  it('rejects unsafe, malformed, duplicate, and oversized snapshots', () => {
    const safeActivity = {
      id: parentId,
      kind: 'workspace',
      phase: 'running',
      summary: '正在整理任务计划',
    }
    const tooManyActivities = Array.from({ length: 257 }, (_, index) => ({
      id: `activity_${index.toString(16).padStart(32, '0')}`,
      kind: 'workspace',
      phase: 'completed',
      summary: '已整理任务计划',
    }))

    for (const value of [
      {
        type: 'run_snapshot',
        state: 'working',
        activities: [safeActivity],
        sessionId: 'private-core-session',
      },
      {
        type: 'run_snapshot',
        state: 'working',
        activities: [safeActivity, safeActivity],
      },
      {
        type: 'run_snapshot',
        state: 'working',
        activities: [{ ...safeActivity, summary: '/Users/private/task.json' }],
      },
      {
        type: 'run_snapshot',
        state: 'working',
        activities: [{
          ...safeActivity,
          parentId: 'core-parent-id',
        }],
      },
      {
        type: 'run_snapshot',
        state: 'working',
        activities: [{
          ...safeActivity,
          progress: { completed: 3, total: 2 },
        }],
      },
      {
        type: 'run_snapshot',
        state: 'working',
        activities: tooManyActivities,
      },
    ]) {
      expect(parseProductTaskEvent(value)).toBeNull()
    }
  })
})

describe('product task protocol Computer Use approvals', () => {
  it('accepts only the narrow Computer Use approval projection', () => {
    expect(parseProductTaskEvent({
      type: 'approval_required',
      requestId: 'computer-use-1',
      kind: 'computer_use',
      computerUse: {
        apps: [{ name: '记分牌', tier: 'click', alreadyAuthorized: false }],
        capabilities: ['clipboard_read', 'system_key_combos'],
        systemPermissions: {
          accessibilityRequired: true,
          screenRecordingRequired: false,
        },
      },
    })).toEqual({
      type: 'approval_required',
      requestId: 'computer-use-1',
      kind: 'computer_use',
      computerUse: {
        apps: [{ name: '记分牌', tier: 'click', alreadyAuthorized: false }],
        capabilities: ['clipboard_read', 'system_key_combos'],
        systemPermissions: {
          accessibilityRequired: true,
          screenRecordingRequired: false,
        },
      },
    })
  })

  it('rejects raw Computer Use implementation details before they reach product state', () => {
    for (const computerUse of [
      {
        apps: [{ name: 'com.example.private', tier: 'full', alreadyAuthorized: false }],
        capabilities: [],
      },
      {
        apps: [{ name: '/Applications/Private.app', tier: 'full', alreadyAuthorized: false }],
        capabilities: [],
      },
      {
        apps: [{ name: '记分牌', tier: 'full', alreadyAuthorized: false, bundleId: 'com.example.private' }],
        capabilities: [],
      },
      {
        apps: [],
        capabilities: ['clipboard_read'],
        rawToolInput: { private: true },
      },
    ]) {
      expect(parseProductTaskEvent({
        type: 'approval_required',
        requestId: 'computer-use-1',
        kind: 'computer_use',
        computerUse,
      })).toBeNull()
    }
  })
})
