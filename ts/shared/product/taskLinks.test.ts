import { describe, expect, it } from 'bun:test'
import {
  buildProductTaskLink,
  normalizeProductTaskId,
  parseProductTaskLink,
  parseProductTaskWindowSearch,
} from './taskLinks.js'

describe('product task links', () => {
  it('builds and parses an opaque product task link', () => {
    const link = buildProductTaskLink('task_abc-123')

    expect(link).toBe('billiardbuddy://task/task_abc-123')
    expect(parseProductTaskLink(link!)).toBe('task_abc-123')
  })

  it('rejects malformed task identities and link variants', () => {
    expect(normalizeProductTaskId(' task_1 ')).toBe('task_1')
    expect(normalizeProductTaskId('../task')).toBeNull()
    expect(buildProductTaskLink('task/1')).toBeNull()
    expect(parseProductTaskLink('billiardbuddy://task/task-1?session=private')).toBeNull()
    expect(parseProductTaskLink('billiardbuddy://task/task-1/extra')).toBeNull()
    expect(parseProductTaskLink('https://task/task-1')).toBeNull()
  })

  it('reads only a bounded public task id from a task-window query', () => {
    expect(parseProductTaskWindowSearch('?task=task_abc-123')).toBe('task_abc-123')
    expect(parseProductTaskWindowSearch('?task=../../private')).toBeNull()
    expect(parseProductTaskWindowSearch('?other=task-1')).toBeNull()
  })
})
