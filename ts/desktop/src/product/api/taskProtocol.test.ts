import { describe, expect, it } from 'vitest'
import { parseProductAttachmentOperationResult, parseProductPublicComposerDraft, parseProductPublicConversationLineage, parseProductPublicWorkspace, parseProductTaskEvent, parseProductTaskThread } from './taskProtocol'

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

describe('product task protocol media draft entries', () => {
  const taskId = 'task-media-draft'
  const entry = {
    id: 'thread-media-draft',
    type: 'media_draft',
    draft: { projectId: 'img_12345678', kind: 'image', state: 'draft' },
    createdAt: '2026-07-20T00:00:00.000Z',
  } as const

  it('accepts only the narrow task-scoped media draft reference', () => {
    expect(parseProductTaskThread({ taskId, entries: [entry] }, taskId)).toEqual({
      taskId,
      entries: [entry],
    })
  })

  it('rejects media paths, prompts, non-draft state, and invalid project ids', () => {
    for (const draft of [
      { ...entry.draft, path: '/Users/private/project.json' },
      { ...entry.draft, prompt: 'PRIVATE_PROMPT' },
      { ...entry.draft, state: 'ready' },
      { ...entry.draft, projectId: '../private-project' },
    ]) {
      expect(parseProductTaskThread({
        taskId,
        entries: [{ ...entry, draft }],
      }, taskId)).toBeNull()
    }
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
  it('accepts only product-authored action scope and consequence fields', () => {
    const event = {
      type: 'approval_required' as const,
      requestId: 'approval-1',
      kind: 'action' as const,
      action: {
        what: '运行一条受限命令',
        scope: '当前任务工作区之外的本机资源或网络边界',
        consequence: '命令可能修改文件、启动进程或访问外部服务。',
      },
    }
    expect(parseProductTaskEvent(event)).toEqual(event)
    expect(parseProductTaskEvent({ ...event, action: { ...event.action, command: 'rm secret' } })).toBeNull()
  })

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


describe('public workspace capability protocol', () => {
  it('accepts only path-free exact workspace records', () => {
    const workspace = { workspace_id: 'workspace-1', revision: 2, availability: 'available', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z' }
    expect(parseProductPublicWorkspace(workspace)).toEqual(workspace)
    expect(parseProductPublicWorkspace({ ...workspace, canonical_root: '/private/project' })).toBeNull()
    expect(parseProductPublicWorkspace({ ...workspace, revision: 1.5 })).toBeNull()
  })

  it('rejects private draft and lineage data while accepting exact public projections', () => {
    expect(parseProductPublicComposerDraft({ draft_id: 'draft-1', target_task_id: 'task-1', revision: 0, last_activity: '2026-07-19T00:00:00.000Z', state: 'active', created_at: '2026-07-19T00:00:00.000Z', expires_at: '2026-07-20T00:00:00.000Z' })).not.toBeNull()
    expect(parseProductPublicComposerDraft({ draft_id: 'draft-1', target_task_id: 'task-1', revision: 0, last_activity: '2026-07-19T00:00:00.000Z', state: 'active', created_at: '2026-07-19T00:00:00.000Z', expires_at: '2026-07-20T00:00:00.000Z', workDir: '/private/project' })).toBeNull()
    expect(parseProductPublicConversationLineage({ lineage_id: 'lineage-1', product_task_id: 'task-1', revision: 1, compact_generation: 0, state: 'active', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z' })).not.toBeNull()
    expect(parseProductPublicConversationLineage({ lineage_id: 'lineage-1', product_task_id: 'task-1', revision: 1, compact_generation: 0, state: 'active', created_at: '2026-07-19T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', resume_binding_id: 'secret' })).toBeNull()
  })
})


describe('attachment operation protocol', () => {
  it('accepts exact opaque operation results and rejects private metadata', () => {
    expect(parseProductAttachmentOperationResult({ authority_revision: 1, attachment_revision: 2, outcome: 'accepted' })).toEqual({ authority_revision: 1, attachment_revision: 2, outcome: 'accepted' })
    expect(parseProductAttachmentOperationResult({ authority_revision: 1, attachment_revision: 2, outcome: 'accepted', content_hash: 'secret' })).toBeNull()
  })
})
