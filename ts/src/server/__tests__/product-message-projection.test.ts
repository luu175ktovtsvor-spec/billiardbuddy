import { describe, expect, it } from 'bun:test'
import { projectMemorySavedData } from '../api/productMessageProjection.js'

describe('product message projection', () => {
  it('uses an explicit count without copying any remaining fields', () => {
    expect(projectMemorySavedData({
      writtenCount: 3,
      writtenPaths: ['/private/path-that-must-not-leak.md'],
      message: 'PRIVATE_MEMORY_EVENT_MESSAGE',
    })).toEqual({ writtenCount: 3 })
  })

  it('derives a count from valid paths without returning those paths', () => {
    const privatePath = '/Users/test/.claude/projects/example/memory/preferences.md'
    const projected = projectMemorySavedData({
      writtenPaths: [privatePath, ' ', 42],
      message: 'PRIVATE_MEMORY_EVENT_MESSAGE',
    })

    expect(projected).toEqual({ writtenCount: 1 })
    expect(JSON.stringify(projected)).not.toContain(privatePath)
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_MEMORY_EVENT_MESSAGE')
  })
})
