import { expect, test } from 'bun:test'
import { toBackend, toView, type ScheduledTask } from './scheduled'

test('toBackend:指令型任务发 instruction,显式清空 workflow_id', () => {
  const body = toBackend({ title: '汇总昨天的营业数据', freq: 'day', time: '09:30', enabled: true })
  expect(body).toMatchObject({
    name: '汇总昨天的营业数据',
    instruction: '汇总昨天的营业数据',
    workflow_id: null,
    schedule_kind: 'daily',
    schedule_spec: { hour: 9, minute: 30 },
    enabled: true,
  })
})

test('toBackend:工作流型任务发 workflow_id,instruction 置空', () => {
  const body = toBackend({ title: '营业日报', freq: 'week', time: '23:30', enabled: true, workflowId: 'venue-daily-report' })
  expect(body).toMatchObject({
    name: '营业日报',
    instruction: '',
    workflow_id: 'venue-daily-report',
    schedule_kind: 'weekly',
    schedule_spec: { hour: 23, minute: 30 },
  })
})

test('toView:workflow_id 透传为 workflowId,空串/缺失归 undefined', () => {
  const base: ScheduledTask = { id: 't1', name: '营业日报', schedule_kind: 'daily', schedule_spec: { hour: 23, minute: 30 } }
  expect(toView({ ...base, workflow_id: 'venue-daily-report' }).workflowId).toBe('venue-daily-report')
  expect(toView({ ...base, workflow_id: '' }).workflowId).toBeUndefined()
  expect(toView(base).workflowId).toBeUndefined()
  expect(toView({ ...base, workflow_id: 'venue-daily-report' }).title).toBe('营业日报')
})
