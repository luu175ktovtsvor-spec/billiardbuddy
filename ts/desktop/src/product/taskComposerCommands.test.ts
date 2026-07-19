import { describe, expect, it } from 'vitest'
import {
  buildTaskComposerAgentCommands,
  buildTaskComposerCommands,
  buildTaskComposerSkillCommands,
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

  it('uses a bundled Skill Chinese label in the Composer and restores its runtime name on submit', () => {
    const commands = buildTaskComposerSkillCommands([
      {
        runtimeName: 'venue-daily-review',
        displayName: '复盘今天经营',
        description: '整理当天经营情况。',
      },
    ])

    expect(commands).toEqual([
      {
        name: '复盘今天经营',
        runtimeName: 'venue-daily-review',
        description: '整理当天经营情况。',
      },
    ])
    expect(resolveTaskComposerRuntimeCommand('/复盘今天经营 整理昨天数据', commands)).toBe(
      '/venue-daily-review 整理昨天数据',
    )
  })

  it('keeps colliding bundled Skill labels selectable without exposing the runtime name', () => {
    const commands = buildTaskComposerSkillCommands([
      { runtimeName: 'venue-daily-review', displayName: '经营复盘', description: '' },
      { runtimeName: 'venue-weekly-review', displayName: '经营复盘', description: '' },
    ])

    expect(commands).toEqual([
      expect.objectContaining({ name: '经营复盘', runtimeName: 'venue-daily-review' }),
      expect.objectContaining({ name: '经营复盘-2', runtimeName: 'venue-weekly-review' }),
    ])
    expect(resolveTaskComposerRuntimeCommand('/经营复盘-2 本周数据', commands)).toBe(
      '/venue-weekly-review 本周数据',
    )
  })

  it('keeps Skill and Agent display aliases distinct in one Composer', () => {
    const commands = buildTaskComposerCommands(
      [{
        runtimeName: 'agent assistant-1',
        displayName: 'agent assistant-1',
        description: '',
      }],
      [{ displayName: 'assistant-1', runtimeName: 'venue-analyst' }],
    )

    expect(commands.map((command) => command.name)).toEqual([
      'agent assistant-1',
      'agent assistant-1-2',
    ])
    expect(resolveTaskComposerRuntimeCommand('/agent assistant-1-2 处理数据', commands)).toBe(
      '/agent venue-analyst 处理数据',
    )
  })

  it('resolves a longer display alias before a shorter space-prefixed alias', () => {
    const commands = [
      {
        name: '经营',
        runtimeName: 'business',
        description: '',
      },
      {
        name: '经营 复盘',
        runtimeName: 'business-review',
        description: '',
      },
    ]

    expect(resolveTaskComposerRuntimeCommand('/经营 复盘 本周数据', commands)).toBe(
      '/business-review 本周数据',
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
