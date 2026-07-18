import { describe, expect, it } from 'bun:test'
import type { MessageEntry } from '../services/sessionService.js'
import {
  projectMemorySavedData,
  projectSessionMessagesForProduct,
} from '../api/productMessageProjection.js'

describe('product message projection', () => {
  it('projects saved-memory data without mutating the retained transcript message', () => {
    const privatePath = '/Users/test/.claude/projects/example/memory/preferences.md'
    const sourceMessage: MessageEntry = {
      id: 'memory-1',
      type: 'system',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: {
        subtype: 'memory_saved',
        writtenPaths: [privatePath, '/Users/test/.claude/projects/example/memory/team/MEMORY.md'],
        message: 'PRIVATE_MEMORY_TRANSCRIPT_MESSAGE',
        teamCount: 1,
      },
    }
    const source = [sourceMessage]

    const projected = projectSessionMessagesForProduct(source)

    expect(projected).toEqual([
      {
        ...sourceMessage,
        content: {
          subtype: 'memory_saved',
          writtenCount: 2,
        },
      },
    ])
    expect(sourceMessage.content).toEqual({
      subtype: 'memory_saved',
      writtenPaths: [privatePath, '/Users/test/.claude/projects/example/memory/team/MEMORY.md'],
      message: 'PRIVATE_MEMORY_TRANSCRIPT_MESSAGE',
      teamCount: 1,
    })
  })

  it('uses an explicit count without copying any remaining fields', () => {
    expect(projectMemorySavedData({
      writtenCount: 3,
      writtenPaths: ['/private/path-that-must-not-leak.md'],
      message: 'PRIVATE_MEMORY_EVENT_MESSAGE',
    })).toEqual({ writtenCount: 3 })
  })

  it('normalizes the system envelope used by team transcripts', () => {
    const privatePath = '/Users/test/.claude/projects/example/memory/team/MEMORY.md'
    const source: MessageEntry[] = [{
      id: 'team-memory-1',
      type: 'system',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: {
        role: 'system',
        content: {
          subtype: 'memory_saved',
          writtenPaths: [privatePath],
          message: 'PRIVATE_TEAM_MEMORY_MESSAGE',
        },
      },
    }]

    const projected = projectSessionMessagesForProduct(source)

    expect(projected[0]?.content).toEqual({
      subtype: 'memory_saved',
      writtenCount: 1,
    })
    expect(JSON.stringify(projected)).not.toContain(privatePath)
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_TEAM_MEMORY_MESSAGE')
  })
})
