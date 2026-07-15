import { expect, test } from 'bun:test'
import { PROJECT_TASK_PAGE_SIZE, visibleProjectTasks } from './Sidebar'

test('Codex 项目组默认只展示最近 5 个任务', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => `task-${index + 1}`)
  expect(PROJECT_TASK_PAGE_SIZE).toBe(5)
  expect(visibleProjectTasks(tasks, false)).toEqual(tasks.slice(0, 5))
  expect(visibleProjectTasks(tasks, true)).toEqual(tasks)
})
