import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScheduledTaskList, formatNext, scheduleText } from './ScheduledPage'

test('已安排任务使用 Codex 式无外框紧凑单列行', () => {
  const html = renderToStaticMarkup(
    <ScheduledTaskList
      tasks={[
        { id: 'a', title: '每天整理经营日报', freq: 'day', time: '09:00', enabled: true },
        { id: 'b', title: '每周复盘招聘进度', freq: 'week', time: '18:30', enabled: false },
      ]}
      onToggle={() => undefined}
      onOpenMenu={() => undefined}
    />,
  )

  expect(html).toContain('role="list"')
  expect(html.match(/role="listitem"/g)).toHaveLength(2)
  expect(html.match(/data-testid="scheduled-task-row"/g)).toHaveLength(2)
  expect(html).toContain('rounded-md px-2 py-2')
  expect(html).toContain('aria-label="运行中"')
  expect(html).toContain('aria-label="已暂停"')
  expect(html).toContain('每天 09:00')
  expect(html).toContain('每周一 18:30')
  expect(html).not.toContain('border:1px solid var(--color-border)')
})

test('计划时间文案保留可读的缺省值', () => {
  expect(scheduleText('month', '08:15')).toBe('每月 1 日 08:15')
  expect(formatNext(null, 'day', '09:00')).toBe('明天 09:00')
  expect(formatNext(undefined, 'week', '18:30')).toBe('周一 18:30')
})
