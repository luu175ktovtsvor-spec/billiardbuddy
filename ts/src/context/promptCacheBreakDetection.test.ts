import { beforeEach, expect, test } from 'bun:test'
import { resetPromptCacheBreakDetection, checkPromptCacheBreak, formatPromptCacheBreak, notifyPromptCacheCompaction, recordPromptCacheState } from './promptCacheBreakDetection'
import { textBlock, type Message } from '../types/message'
import type { ToolSpec } from '../tools/Tool'

const tools: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]
const messages: Message[] = [{ role: 'user', content: [textBlock('hello')] }]

beforeEach(() => {
  resetPromptCacheBreakDetection()
})

test('detects cache read drops and explains changed tool schemas', () => {
  recordPromptCacheState({ trackingKey: 'conv-a', system: 'SYS', tools, model: 'mimo' })
  expect(checkPromptCacheBreak('conv-a', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20_000 }, messages)).toBeNull()

  recordPromptCacheState({
    trackingKey: 'conv-a',
    system: 'SYS',
    tools: [{ ...tools[0]!, description: 'Read a file safely' }],
    model: 'mimo',
  })
  const event = checkPromptCacheBreak('conv-a', {
    input_tokens: 10,
    output_tokens: 1,
    cache_read_input_tokens: 10_000,
    cache_creation_input_tokens: 7_000,
  }, messages)

  expect(event).toMatchObject({
    reason: 'tools changed (tool prompt/schema changed, same tool set)',
    previousCacheReadTokens: 20_000,
    cacheReadTokens: 10_000,
    tokenDrop: 10_000,
    toolSchemasChanged: true,
    changedToolSchemas: ['read_file'],
  })
  expect(formatPromptCacheBreak(event!)).toContain('[PROMPT CACHE BREAK]')
})

test('ignores small drops and resets baseline after compaction', () => {
  recordPromptCacheState({ trackingKey: 'conv-b', system: 'SYS', tools, model: 'mimo' })
  expect(checkPromptCacheBreak('conv-b', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20_000 }, messages)).toBeNull()
  recordPromptCacheState({ trackingKey: 'conv-b', system: 'SYS changed', tools, model: 'mimo' })
  expect(checkPromptCacheBreak('conv-b', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 19_200 }, messages)).toBeNull()

  notifyPromptCacheCompaction('conv-b')
  recordPromptCacheState({ trackingKey: 'conv-b', system: 'SYS changed again', tools, model: 'mimo' })
  expect(checkPromptCacheBreak('conv-b', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5_000 }, messages)).toBeNull()
})

test('sanitizes mcp tool names in changed schema diagnostics', () => {
  const mcpTools: ToolSpec[] = [
    { name: 'mcp__private/path/tool', description: 'one', parameters: { type: 'object' } },
  ]
  recordPromptCacheState({ trackingKey: 'conv-c', system: 'SYS', tools: mcpTools, model: 'mimo' })
  expect(checkPromptCacheBreak('conv-c', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20_000 }, messages)).toBeNull()
  recordPromptCacheState({
    trackingKey: 'conv-c',
    system: 'SYS',
    tools: [{ ...mcpTools[0]!, description: 'two' }],
    model: 'mimo',
  })
  const event = checkPromptCacheBreak('conv-c', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1_000 }, messages)
  expect(event?.changedToolSchemas).toEqual(['mcp'])
})
