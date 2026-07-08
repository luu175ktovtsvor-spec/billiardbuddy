import { expect, test } from 'bun:test'
import { textBlock, toolUseBlock, type Message } from '../types/message'
import {
  buildChildMessage,
  buildForkedMessages,
  buildForkRunContext,
  buildWorktreeNotice,
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
  FORK_QUERY_SOURCE,
  isForkSubagentEnabled,
  isForkQuerySource,
  isInForkChild,
} from './forkSubagent'

test('buildForkedMessages keeps the full assistant message and adds placeholder tool results before directive', () => {
  const assistant: Message = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'plan' },
      textBlock('I will split this up.'),
      toolUseBlock({ id: 'call_a', name: 'agent_task', input: { task: 'A' } }),
      toolUseBlock({ id: 'call_b', name: 'agent_task', input: { task: 'B' } }),
    ],
  }

  const forked = buildForkedMessages('Inspect parser boundaries', assistant)

  expect(forked).toHaveLength(2)
  expect(forked[0]).toEqual(assistant)
  expect(forked[0]).not.toBe(assistant)
  expect(forked[0]!.content).not.toBe(assistant.content)
  expect(forked[1]?.role).toBe('user')
  expect(forked[1]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_a', content: 'Fork started - processing in background' })
  expect(forked[1]?.content[1]).toEqual({ type: 'tool_result', tool_use_id: 'call_b', content: 'Fork started - processing in background' })
  const directive = forked[1]!.content.at(-1)
  expect(directive).toMatchObject({ type: 'text' })
  expect(directive?.type === 'text' ? directive.text : '').toContain(`<${FORK_BOILERPLATE_TAG}>`)
  expect(directive?.type === 'text' ? directive.text : '').toContain(`${FORK_DIRECTIVE_PREFIX}Inspect parser boundaries`)
})

test('isForkSubagentEnabled is opt-in through explicit environment gates', () => {
  expect(isForkSubagentEnabled({})).toBe(false)
  expect(isForkSubagentEnabled({ DESKTOP_AGENT_FORK_SUBAGENT: '1' })).toBe(true)
  expect(isForkSubagentEnabled({ CC_HAHA_FORK_SUBAGENT: 'true' })).toBe(true)
  expect(isForkSubagentEnabled({ DESKTOP_AGENT_FORK_SUBAGENT: 'false' })).toBe(false)
})

test('isForkQuerySource detects the stable fork child runtime marker', () => {
  expect(isForkQuerySource(FORK_QUERY_SOURCE)).toBe(true)
  expect(isForkQuerySource('agent:builtin:researcher')).toBe(false)
  expect(isForkQuerySource(undefined)).toBe(false)
})

test('buildForkedMessages falls back to a directive-only user message without tool_use blocks', () => {
  const forked = buildForkedMessages('Read docs', { role: 'assistant', content: [textBlock('No tools here')] })
  expect(forked).toHaveLength(1)
  expect(forked[0]).toMatchObject({ role: 'user' })
  expect(forked[0]!.content[0]).toMatchObject({ type: 'text' })
  expect(forked[0]!.content[0]?.type === 'text' ? forked[0]!.content[0].text : '').toContain('Read docs')
})

test('buildForkRunContext inherits parent system, tools and prefixes the forked assistant exchange', () => {
  const parent: Message[] = [
    { role: 'user', content: [textBlock('Parent request')] },
    {
      role: 'assistant',
      content: [
        textBlock('I will fork this.'),
        toolUseBlock({ id: 'fork_call', name: 'agent_task', input: { fork_context: true, task: 'Audit runtime' } }),
      ],
    },
  ]
  const tool = { name: 'read_file', description: '', inputSchema: { type: 'object' as const }, isReadOnly: true, async execute() { return 'ok' } }

  const ctx = buildForkRunContext({
    workspace: {} as never,
    systemPrompt: 'PARENT SYS',
    messages: parent,
    registry: { list: () => [tool] } as never,
  }, 'Audit runtime')

  expect(ctx.systemPrompt).toBe('PARENT SYS')
  expect(ctx.querySource).toBe(FORK_QUERY_SOURCE)
  expect(ctx.tools).toEqual([tool])
  expect(ctx.initialMessages[0]).toEqual(parent[0])
  expect(ctx.initialMessages[1]).toEqual(parent[1])
  expect(ctx.initialMessages[2]).toMatchObject({
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'fork_call', content: 'Fork started - processing in background' },
      { type: 'text' },
    ],
  })
  const directive = ctx.initialMessages[2]!.content[1]
  expect(directive?.type === 'text' ? directive.text : '').toContain(`${FORK_DIRECTIVE_PREFIX}Audit runtime`)
})

test('isInForkChild detects the fork boilerplate tag in user messages', () => {
  expect(isInForkChild([{ role: 'user', content: [textBlock(buildChildMessage('Do work'))] }])).toBe(true)
  expect(isInForkChild([{ role: 'assistant', content: [textBlock(buildChildMessage('Do work'))] }])).toBe(false)
  expect(isInForkChild([{ role: 'user', content: [textBlock('ordinary request')] }])).toBe(false)
})

test('buildWorktreeNotice tells fork children to translate parent paths into the isolated worktree', () => {
  const notice = buildWorktreeNotice('/repo/main', '/repo/.worktrees/agent-1')
  expect(notice).toContain('/repo/main')
  expect(notice).toContain('/repo/.worktrees/agent-1')
  expect(notice).toContain('translate them to your worktree root')
  expect(notice).toContain('Re-read files before editing')
})
