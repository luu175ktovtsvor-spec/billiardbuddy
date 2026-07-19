import { describe, expect, it } from 'bun:test'
import type { MessageEntry } from '../services/sessionService.js'
import { projectSessionTranscriptForProductTask } from '../product/taskThreadProjection.js'

describe('product task thread projection', () => {
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
})
