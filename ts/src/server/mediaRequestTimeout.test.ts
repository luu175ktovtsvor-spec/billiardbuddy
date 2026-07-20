import { describe, expect, test } from 'bun:test'
import { isLongMediaRequestPath } from './mediaRequestTimeout'

describe('local media response timeout routing', () => {
  test('disables Bun idle timeout only for media and task-scoped media responses', () => {
    expect(isLongMediaRequestPath('/api/media/tasks/task-1')).toBe(true)
    expect(isLongMediaRequestPath('/api/product/tasks/task-1/media')).toBe(true)
    expect(isLongMediaRequestPath('/api/product/tasks/task-1/media/projects/img-1/assets/out-1')).toBe(true)
    expect(isLongMediaRequestPath('/api/product/tasks/task-1/thread')).toBe(false)
    expect(isLongMediaRequestPath('/api/mediator')).toBe(false)
  })
})
