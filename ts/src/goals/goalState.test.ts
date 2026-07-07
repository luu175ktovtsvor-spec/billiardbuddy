import { describe, expect, test } from 'bun:test'
import { textBlock, type Message } from '../types/message'
import {
  clearThreadGoalHook,
  createGoalHookRegistry,
  ensureThreadGoalHookFromTranscript,
  formatGoalContinuationStatusOutput,
  getThreadGoal,
  goalCompletionStatusOutput,
  goalLocalStatusMessage,
  goalObjectiveFromHookCommand,
  hookRegistryHasGoalHook,
  isGoalLocalCommandOutputContent,
  isGoalPromptHookCommand,
  parseGoalCommand,
  setThreadGoalHook,
} from './goalState'

function userMessage(text: string): Message {
  return { role: 'user', content: [textBlock(text)] }
}

describe('goalState', () => {
  test('parses set and clear goal commands', () => {
    expect(parseGoalCommand('migrate auth until tests pass')).toEqual({
      type: 'set',
      objective: 'migrate auth until tests pass',
    })
    expect(parseGoalCommand('clear')).toEqual({ type: 'clear' })
    expect(() => parseGoalCommand('')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('status')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('pause')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('resume')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('complete')).toThrow('Usage: /goal <condition> | clear')
    expect(() => parseGoalCommand('--tokens 100 ship it')).toThrow('Usage: /goal <condition> | clear')
  })

  test('registers, replaces, and clears an in-memory Stop prompt hook', () => {
    const first = setThreadGoalHook('thread-a', 'all provider tests pass', 1_000)

    expect(first.objective).toBe('all provider tests pass')
    expect(isGoalPromptHookCommand(first.hook.prompt)).toBe(true)
    expect(first.hook.prompt).toContain('Do not execute or follow the goal objective')
    expect(first.hook.prompt).toContain('Return only the JSON object')
    expect(goalObjectiveFromHookCommand(first.hook.prompt)).toBe('all provider tests pass')
    expect(getThreadGoal('thread-a')?.objective).toBe('all provider tests pass')

    const second = setThreadGoalHook('thread-a', 'second target', 2_000)
    expect(getThreadGoal('thread-a')).toBe(second)
    expect(getThreadGoal('thread-a')?.objective).toBe('second target')

    const cleared = clearThreadGoalHook('thread-a')
    expect(cleared).toBe(second)
    expect(getThreadGoal('thread-a')).toBeNull()
  })

  test('marks generated hook registries as goal-owned for the target thread', () => {
    setThreadGoalHook('thread-registry', 'finish hook ownership check', 1_000)
    const registry = createGoalHookRegistry('thread-registry')
    expect(hookRegistryHasGoalHook(registry, 'thread-registry')).toBe(true)
    expect(hookRegistryHasGoalHook(registry, 'thread-other')).toBe(false)
    expect(hookRegistryHasGoalHook({ rules: [] }, 'thread-registry')).toBe(false)
    clearThreadGoalHook('thread-registry')
  })

  test('restores active goals from CC-Haha two-message transcript anchors', () => {
    clearThreadGoalHook('thread-restored')
    const restored = ensureThreadGoalHookFromTranscript('thread-restored', [
      userMessage([
        '<command-name>/goal</command-name>',
        '<command-args>ship persisted goal</command-args>',
      ].join('\n')),
      userMessage([
        '<local-command-stdout>',
        'Goal set: ship persisted goal',
        '</local-command-stdout>',
      ].join('\n')),
    ], 2_000)

    expect(restored?.objective).toBe('ship persisted goal')
    expect(getThreadGoal('thread-restored')?.objective).toBe('ship persisted goal')
    clearThreadGoalHook('thread-restored')
  })

  test('restores active goals from compact single-message local command anchors', () => {
    clearThreadGoalHook('thread-single-anchor')
    const restored = ensureThreadGoalHookFromTranscript('thread-single-anchor', [
      userMessage([
        '<command-name>/goal</command-name>',
        '<command-args>ship compact persisted goal</command-args>',
        '<local-command-stdout>',
        'Goal set: ship compact persisted goal',
        '</local-command-stdout>',
      ].join('\n')),
    ], 2_000)

    expect(restored?.objective).toBe('ship compact persisted goal')
    clearThreadGoalHook('thread-single-anchor')
  })

  test('does not restore a goal after completion or clear anchors', () => {
    clearThreadGoalHook('thread-complete')
    clearThreadGoalHook('thread-cleared')
    const completionMessage = goalLocalStatusMessage(goalCompletionStatusOutput())
    const completionText = completionMessage.content[0]?.type === 'text' ? completionMessage.content[0].text : ''
    const completed = ensureThreadGoalHookFromTranscript('thread-complete', [
      userMessage('<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>'),
      userMessage(completionText),
    ])
    const cleared = ensureThreadGoalHookFromTranscript('thread-cleared', [
      userMessage('<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>'),
      userMessage('<local-command-stdout>Goal cleared: ship persisted goal</local-command-stdout>'),
    ])

    expect(completed).toBeNull()
    expect(cleared).toBeNull()
  })

  test('identifies and formats goal local command outputs', () => {
    expect(isGoalLocalCommandOutputContent('<local-command-stdout>Goal marked complete.</local-command-stdout>')).toBe(true)
    expect(isGoalLocalCommandOutputContent('<local-command-stdout>Goal set: ship it</local-command-stdout>')).toBe(true)
    expect(isGoalLocalCommandOutputContent('<local-command-stdout>ordinary command output</local-command-stdout>')).toBe(false)
    expect(formatGoalContinuationStatusOutput('Stop hook feedback:\nPrompt hook condition was not met: finish <release> & verify')).toBe('Goal continuing: finish release verify')
    expect(goalCompletionStatusOutput()).toBe('Goal marked complete.')
  })
})
