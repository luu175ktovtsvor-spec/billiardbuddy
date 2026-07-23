import { describe, expect, test } from 'bun:test'
import {
  formatGoalContinuationStatusOutput,
  shouldLetGoalPromptHookContinue,
  shouldRunLegacyMemoryAutomation,
} from './stopHooks.js'

describe('stop hook goal continuation', () => {
  test('converts unmet managed /goal prompt hooks into normal blocking continuation', () => {
    expect(
      shouldLetGoalPromptHookContinue({
        preventContinuation: true,
        blockingError: {
          blockingError: 'Prompt hook condition was not met: keep working',
          command: '<bb-goal-hook>\nship the feature',
        },
      }),
    ).toBe(true)
  })

  test('preserves prevent-continuation semantics for non-goal hooks', () => {
    expect(
      shouldLetGoalPromptHookContinue({
        preventContinuation: true,
        blockingError: {
          blockingError: 'Prompt hook condition was not met: stop',
          command: 'ordinary prompt hook',
        },
      }),
    ).toBe(false)

    expect(
      shouldLetGoalPromptHookContinue({
        preventContinuation: false,
        blockingError: {
          blockingError: 'Prompt hook condition was not met: keep working',
          command: '<bb-goal-hook>\nship the feature',
        },
      }),
    ).toBe(false)
  })

  test('formats goal continuation status output for visible transcript separators', () => {
    expect(
      formatGoalContinuationStatusOutput(
        'Prompt hook condition was not met: finish <release> & verify',
      ),
    ).toBe('Goal continuing: finish release verify')
  })
})

test('project-isolated ProductTask contexts never run legacy memory automation', () => {
  expect(shouldRunLegacyMemoryAutomation({
    agentId: undefined,
    disableMemoryDiscovery: true,
  })).toBe(false)
  expect(shouldRunLegacyMemoryAutomation({
    agentId: undefined,
    disableMemoryDiscovery: false,
  })).toBe(true)
})
