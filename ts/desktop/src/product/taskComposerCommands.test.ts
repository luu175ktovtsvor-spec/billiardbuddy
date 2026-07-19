import { describe, expect, it } from 'vitest'
import {
  buildTaskComposerAgentCommands,
  resolveTaskComposerRuntimeCommand,
} from './taskComposerCommands'

describe('taskComposerCommands', () => {
  it('uses the product-safe display name and restores the Agent runtime name on submit', () => {
    const commands = buildTaskComposerAgentCommands([
      {
        displayName: 'assistant-1',
        runtimeName: 'venue-analyst',
      },
    ])

    expect(commands).toEqual([
      {
        name: 'agent assistant-1',
        runtimeName: 'agent venue-analyst',
        description: '',
        argumentHint: '<prompt>',
      },
    ])
    expect(resolveTaskComposerRuntimeCommand('/agent assistant-1 inspect tables', commands)).toBe(
      '/agent venue-analyst inspect tables',
    )
  })

  it('keeps colliding display names selectable without exposing duplicate runtime names', () => {
    const commands = buildTaskComposerAgentCommands([
      {
        displayName: 'assistant-1',
        runtimeName: 'venue-analyst',
      },
      {
        displayName: 'assistant-1',
        runtimeName: 'venue-operator',
      },
      {
        displayName: 'ignored',
        runtimeName: 'venue-operator',
      },
    ])

    expect(commands).toEqual([
      expect.objectContaining({
        name: 'agent assistant-1',
        runtimeName: 'agent venue-analyst',
      }),
      expect.objectContaining({
        name: 'agent assistant-1-assistant',
        runtimeName: 'agent venue-operator',
      }),
    ])
    expect(resolveTaskComposerRuntimeCommand('/agent assistant-1-assistant continue', commands)).toBe(
      '/agent venue-operator continue',
    )
  })

  it('leaves unrecognized slash commands unchanged', () => {
    const commands = buildTaskComposerAgentCommands([
      {
        displayName: 'assistant-1',
        runtimeName: 'venue-analyst',
      },
    ])

    expect(resolveTaskComposerRuntimeCommand('/venue-daily-review', commands)).toBe('/venue-daily-review')
  })
})
