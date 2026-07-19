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
