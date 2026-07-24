import { describe, expect, it } from 'bun:test'
import type { MessageEntry } from '../services/sessionService.js'
import {
  projectSessionTranscriptForProductTask,
  resolveCoreMessageIdForProductThreadEntry,
} from '../product/taskThreadProjection.js'

describe('product task thread projection', () => {
  it('keeps MediaWorkbench activity but does not create chat media drafts', () => {
    const privateToolId = 'private-media-tool-use-id'
    const privatePrompt = 'PRIVATE_POSTER_PROMPT'
    const privatePath = '/Users/private/media-workspace'
    const source: MessageEntry[] = [
      {
        id: 'core-assistant-media-create',
        type: 'assistant',
        timestamp: '2026-07-20T08:00:00.000Z',
        content: [{
          type: 'tool_use',
          id: privateToolId,
          name: 'MediaWorkbench',
          input: { action: 'create_image_project', prompt: privatePrompt, workspace_root: privatePath },
        }, {
          type: 'tool_use',
          id: 'private-media-read-tool-use-id',
          name: 'MediaWorkbench',
          input: { action: 'get_project', project_id: 'img_unmatched' },
        }],
      },
      {
        id: 'core-media-result',
        type: 'tool_result',
        timestamp: '2026-07-20T08:00:01.000Z',
        content: [{
          type: 'tool_result',
          tool_use_id: privateToolId,
          is_error: false,
          content: JSON.stringify({
            project: {
              id: 'img_12345678',
              kind: 'image',
              state: 'draft',
              title: 'PRIVATE_TITLE',
              prompt: privatePrompt,
              workspace_root: privatePath,
            },
          }),
        }],
      },
      {
        id: 'core-media-read-result',
        type: 'tool_result',
        timestamp: '2026-07-20T08:00:02.000Z',
        content: [{
          type: 'tool_result',
          tool_use_id: 'private-media-read-tool-use-id',
          is_error: false,
          content: JSON.stringify({
            project: { id: 'img_unmatched', kind: 'image', state: 'draft' },
          }),
        }],
      },
    ]

    const projected = projectSessionTranscriptForProductTask('task-visible-media', source)
    const drafts = projected.entries.filter((entry) => entry.type === 'media_draft')

    expect(drafts).toEqual([])
    expect(projected.entries.filter(entry => entry.type === 'activity')).toHaveLength(4)

    const serialized = JSON.stringify(projected)
    for (const secret of [
      privateToolId,
      'MediaWorkbench',
      privatePrompt,
      privatePath,
      'PRIVATE_TITLE',
      'private-media-read-tool-use-id',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('keeps task conversation and completed activity without leaking Core transcript payloads', () => {
    const privateThinking = 'PRIVATE_THINKING_CHAIN'
    const privateToolInput = 'PRIVATE_TOOL_INPUT'
    const privateToolResult = 'PRIVATE_TOOL_RESULT'
    const privateSystemPrompt = 'PRIVATE_SYSTEM_PROMPT'
    const source: MessageEntry[] = [
      {
        id: 'core-user-1',
        type: 'user',
        timestamp: '2026-07-19T08:00:00.000Z',
        content: '帮我整理今天的球房订单。',
      },
      {
        id: 'core-assistant-1',
        type: 'assistant',
        timestamp: '2026-07-19T08:00:01.000Z',
        model: 'PRIVATE_MODEL',
        usage: { input_tokens: 999, output_tokens: 888 },
        content: [
          { type: 'thinking', thinking: privateThinking },
          { type: 'text', text: '我先核对订单记录。' },
          { type: 'tool_use', id: 'private-tool', name: 'Bash', input: { command: privateToolInput } },
        ],
      },
      {
        id: 'core-result-1',
        type: 'tool_result',
        timestamp: '2026-07-19T08:00:02.000Z',
        content: [{ type: 'tool_result', tool_use_id: 'private-tool', content: privateToolResult, is_error: false }],
      },
      {
        id: 'core-system-1',
        type: 'system',
        timestamp: '2026-07-19T08:00:03.000Z',
        content: privateSystemPrompt,
      },
      {
        id: 'core-internal-user-1',
        type: 'user',
        timestamp: '2026-07-19T08:00:04.000Z',
        content: `<teammate-message teammate_id="private">${privateSystemPrompt}</teammate-message>`,
      },
    ]

    const projected = projectSessionTranscriptForProductTask('task-visible-1', source)

    expect(projected).toEqual({
      taskId: 'task-visible-1',
      entries: [
        {
          id: expect.stringMatching(/^thread_/),
          type: 'user_text',
          text: '帮我整理今天的球房订单。',
          createdAt: '2026-07-19T08:00:00.000Z',
        },
        {
          id: expect.stringMatching(/^thread_/),
          type: 'assistant_text',
          text: '我先核对订单记录。',
          createdAt: '2026-07-19T08:00:01.000Z',
        },
        {
          id: expect.stringMatching(/^thread_/),
          type: 'activity',
          kind: 'command',
          phase: 'completed',
          createdAt: '2026-07-19T08:00:01.000Z',
        },
        {
          id: expect.stringMatching(/^thread_/),
          type: 'activity',
          kind: 'tool',
          phase: 'completed',
          createdAt: '2026-07-19T08:00:02.000Z',
        },
      ],
    })

    const serialized = JSON.stringify(projected)
    for (const secret of [
      'core-user-1',
      'core-assistant-1',
      'core-result-1',
      privateThinking,
      privateToolInput,
      privateToolResult,
      privateSystemPrompt,
      'PRIVATE_MODEL',
      'private-tool',
      'Bash',
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(serialized).not.toContain('"usage"')
  })

  it('resolves only visible text entries back to a Core message on the server', () => {
    const messages: MessageEntry[] = [
      {
        id: 'core-user-private-42',
        type: 'user',
        timestamp: '2026-07-19T08:05:00.000Z',
        content: '从这一条继续核对优惠规则。',
      },
      {
        id: 'core-assistant-private-42',
        type: 'assistant',
        timestamp: '2026-07-19T08:05:01.000Z',
        content: [
          { type: 'text', text: '我会先列出需要核对的规则。' },
          {
            type: 'tool_use',
            id: 'private-tool-call',
            name: 'Bash',
            input: { command: 'PRIVATE_COMMAND' },
          },
        ],
      },
    ]
    const projected = projectSessionTranscriptForProductTask('task-visible-lookup', messages)
    const userEntryId = projected.entries.find((entry) => entry.type === 'user_text')?.id
    const assistantEntryId = projected.entries.find((entry) => entry.type === 'assistant_text')?.id
    const activityEntryId = projected.entries.find((entry) => entry.type === 'activity')?.id

    expect(userEntryId).toMatch(/^thread_[a-f0-9]{20}$/)
    expect(assistantEntryId).toMatch(/^thread_[a-f0-9]{20}$/)
    expect(activityEntryId).toMatch(/^thread_[a-f0-9]{20}$/)
    expect(resolveCoreMessageIdForProductThreadEntry(messages, userEntryId!))
      .toBe('core-user-private-42')
    expect(resolveCoreMessageIdForProductThreadEntry(messages, assistantEntryId!))
      .toBe('core-assistant-private-42')

    // Activity entries describe progress only; they can never become a branch anchor.
    expect(resolveCoreMessageIdForProductThreadEntry(messages, activityEntryId!)).toBeNull()
    expect(resolveCoreMessageIdForProductThreadEntry(
      messages,
      'thread_0123456789abcdef0123',
    )).toBeNull()
    expect(JSON.stringify(projected)).not.toContain('core-user-private-42')
    expect(JSON.stringify(projected)).not.toContain('core-assistant-private-42')
  })

  it('replaces persisted upload transport with safe attachment summaries', () => {
    const uploadRoot = '/Users/private-user/.claude/uploads/core-session-secret'
    const rawImageData = 'data:image/png;base64,PRIVATE_IMAGE_BASE64'
    const source: MessageEntry[] = [
      {
        id: 'core-user-attachment',
        type: 'user',
        timestamp: '2026-07-19T08:10:00.000Z',
        content: [
          {
            type: 'text',
            text: `@"${uploadRoot}/3b8c78a3-7d07-4f0a-9d4b-b8bc5a44e8b4-daily-report.pdf" 请核对今天的台账。 ${rawImageData}`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'PRIVATE_IMAGE_BYTES',
            },
          },
          {
            type: 'text',
            text: `[Image: source: ${uploadRoot}/1f32d6d7-8ae6-4c3d-a16f-913db5926f14-table.png, original 3000x2000, displayed at 1500x1000]`,
          },
        ],
      },
      {
        id: 'core-assistant-attachment',
        type: 'assistant',
        timestamp: '2026-07-19T08:10:01.000Z',
        content: `已处理 @"${uploadRoot}/internal-result.json" ${rawImageData}`,
      },
      {
        id: 'core-user-attachment-only',
        type: 'user',
        timestamp: '2026-07-19T08:10:02.000Z',
        content: `@"${uploadRoot}/f2c8cd99-c0bc-4b1e-8f11-6d2c1ec7f4d0-score-sheet.csv" Please analyze the attached files.`,
      },
    ]

    const projected = projectSessionTranscriptForProductTask('task-visible-attachments', source)

    expect(projected.entries).toEqual([
      {
        id: expect.stringMatching(/^thread_/),
        type: 'user_text',
        text: '请核对今天的台账。',
        attachments: [
          { type: 'file', name: 'daily-report.pdf' },
          { type: 'image', name: 'table.png', mimeType: 'image/png' },
        ],
        createdAt: '2026-07-19T08:10:00.000Z',
      },
      {
        id: expect.stringMatching(/^thread_/),
        type: 'assistant_text',
        text: '已处理',
        createdAt: '2026-07-19T08:10:01.000Z',
      },
      {
        id: expect.stringMatching(/^thread_/),
        type: 'user_text',
        text: '已添加附件',
        attachments: [{ type: 'file', name: 'score-sheet.csv' }],
        createdAt: '2026-07-19T08:10:02.000Z',
      },
    ])

    const serialized = JSON.stringify(projected)
    for (const secret of [
      uploadRoot,
      'core-session-secret',
      rawImageData,
      'PRIVATE_IMAGE_BYTES',
      'internal-result.json',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })
})
