import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { createProductUserMessage } from './productMessages.js'
import { buildProductTool } from './productTool.js'
import { runProductTools } from './productToolExecution.js'

const assistant = {
  type: 'assistant' as const,
  uuid: 'assistant-1',
  timestamp: '2026-07-26T00:00:00.000Z',
  message: {
    id: 'model-1', role: 'assistant' as const, model: 'test', stop_reason: 'tool_call',
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'tool_call' as const, id: 'call-1', name: 'Bounded', arguments: {} }],
  },
}

function context(tool: ReturnType<typeof buildProductTool>) {
  return {
    options: { commands: [], mainLoopModel: 'test', tools: [tool], thinkingConfig: { type: 'disabled' as const } },
    abortController: new AbortController(),
    permissionContext: { mode: 'default' as const, isBypassPermissionsModeAvailable: false },
    messages: [createProductUserMessage({ content: 'test' })],
  }
}

describe('product tool execution boundary', () => {
  test('enforces the declared model-result limit without retaining a second raw result copy', async () => {
    const tool = buildProductTool({
      name: 'Bounded',
      maxResultSizeChars: 120,
      inputSchema: z.strictObject({}),
      description: async () => 'bounded test',
      call: async () => ({ data: 'x'.repeat(2_000) }),
      mapToolResultToToolResultBlockParam: (data, toolUseID) => ({ type: 'tool_result', tool_use_id: toolUseID, content: data }),
    })
    const updates = []
    for await (const update of runProductTools(
      assistant.message.content,
      [assistant],
      async (_tool, input) => ({ behavior: 'allow', updatedInput: input, reason: 'test' }),
      context(tool),
    )) updates.push(update)

    const message = updates[0]?.message
    expect(message?.message.content[0]).toMatchObject({ type: 'tool_result', tool_call_id: 'call-1' })
    const content = (message?.message.content[0] as { content: string }).content
    expect(content.length).toBeLessThanOrEqual(120)
    expect(content).toContain('[tool result truncated]')
    expect('toolUseResult' in (message ?? {})).toBe(false)
  })
})
