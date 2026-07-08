import { expect, test } from 'bun:test'
import { textBlock, toolUseBlock, type Message } from '../types/message'
import {
  buildChildMessage,
  buildForkedMessages,
  buildWorktreeNotice,
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
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

test('buildForkedMessages falls back to a directive-only user message without tool_use blocks', () => {
  const forked = buildForkedMessages('Read docs', { role: 'assistant', content: [textBlock('No tools here')] })
  expect(forked).toHaveLength(1)
  expect(forked[0]).toMatchObject({ role: 'user' })
  expect(forked[0]!.content[0]).toMatchObject({ type: 'text' })
  expect(forked[0]!.content[0]?.type === 'text' ? forked[0]!.content[0].text : '').toContain('Read docs')
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
