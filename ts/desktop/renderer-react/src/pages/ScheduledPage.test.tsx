import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScheduledTaskList, WorkflowRunList, formatNext, formatRunTime, scheduleText } from './ScheduledPage'

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

test('工作流型任务在行内显示「工作流」标记', () => {
  const html = renderToStaticMarkup(
    <ScheduledTaskList
      tasks={[{ id: 'w', title: '营业日报', freq: 'day', time: '23:30', enabled: true, workflowId: 'venue-daily-report' }]}
      onToggle={() => undefined}
      onOpenMenu={() => undefined}
    />,
  )
  expect(html).toContain('data-testid="workflow-badge"')
  expect(html).toContain('工作流')
})

test('工作流运行记录:状态、步骤进度与失败原因可见', () => {
  const html = renderToStaticMarkup(
    <WorkflowRunList
      runs={[
        {
          id: 'r1', workflowId: 'venue-daily-report', workflowName: '营业日报', trigger: 'scheduled',
          status: 'completed', startedAt: '2026-07-16T23:30:00.000Z',
          steps: [
            { stepId: 'a', title: '收集', status: 'completed' },
            { stepId: 'b', title: '生成', status: 'completed' },
          ],
        },
        {
          id: 'r2', workflowId: 'recruitment-daily-prep', workflowName: '招聘每日准备', trigger: 'manual',
          status: 'failed', startedAt: '2026-07-16T09:00:00.000Z', error: '第 1 步「梳理今日待跟进」失败:通道不可用',
          steps: [
            { stepId: 'a', title: '梳理', status: 'failed' },
            { stepId: 'b', title: '草稿', status: 'skipped' },
          ],
        },
      ]}
    />,
  )
  expect(html.match(/data-testid="workflow-run-row"/g)).toHaveLength(2)
  expect(html).toContain('已完成')
  expect(html).toContain('失败')
  expect(html).toContain('2/2 步')
  expect(html).toContain('0/2 步')
  expect(html).toContain('通道不可用')
})

test('formatRunTime 输出 月/日 时:分', () => {
  const html = formatRunTime('2026-07-16T09:05:00.000Z')
  expect(html).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/)
  expect(formatRunTime('not-a-date')).toBe('not-a-date')
})
