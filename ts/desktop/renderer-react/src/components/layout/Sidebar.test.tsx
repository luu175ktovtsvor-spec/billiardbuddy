import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PROJECT_TASK_PAGE_SIZE, visibleProjectTasks } from './Sidebar'

const source = readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8')

test('Codex 项目组默认只展示最近 5 个任务', () => {
  const tasks = Array.from({ length: 8 }, (_, index) => `task-${index + 1}`)
  expect(PROJECT_TASK_PAGE_SIZE).toBe(5)
  expect(visibleProjectTasks(tasks, false)).toEqual(tasks.slice(0, 5))
  expect(visibleProjectTasks(tasks, true)).toEqual(tasks)
})

test('active project and active task do not render as stacked selected cards', () => {
  expect(source).not.toContain("background: activeProj ? 'var(--color-surface-selected)'")
  expect(source).toContain('<div className="ml-6 mt-1">')
  expect(source).toContain("background: active ? 'var(--color-surface-selected)' : 'transparent'")
})
