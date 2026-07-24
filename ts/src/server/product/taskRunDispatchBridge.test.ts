import { expect, test } from 'bun:test'
import type { ProductTaskService } from './taskService.js'
import { ProductTaskWorkerMessageSink } from './taskRunDispatchBridge.js'
import { productTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'

test('worker sink publishes only product-safe assistant text and one terminal fence', async () => {
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-safe' }),
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const events: unknown[] = []
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-safe') events.push(event)
  })

  await sink.record('run', 1, { type: 'event', event: 'started' })
  await sink.record('run', 1, {
    type: 'event',
    event: 'delta',
    data: '完成结果 /private/workspace/secret.txt data:text/plain;base64,U0VDUkVU',
  })
  await sink.record('run', 1, { type: 'terminal', state: 'completed', run_id: 'run' })
  await sink.record('run', 1, { type: 'event', event: 'delta', data: '晚到内容' })
  unsubscribe()

  expect(events).toEqual([
    { type: 'status', state: 'working' },
    { type: 'assistant_text_start' },
    { type: 'assistant_text_delta', text: '完成结果' },
    { type: 'turn_complete' },
  ])
})

test('terminal closes an event already waiting for its private task identity', async () => {
  let resolveIdentity!: (value: { task_id: string }) => void
  const identity = new Promise<{ task_id: string }>((resolve) => { resolveIdentity = resolve })
  const tasks = {
    readTaskRunDispatchIdentity: async () => identity,
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const events: unknown[] = []
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-race') events.push(event)
  })

  const delta = sink.record('race', 1, { type: 'event', event: 'delta', data: '不得晚到' })
  const terminal = sink.record('race', 1, { type: 'terminal', state: 'stopped', run_id: 'race' })
  resolveIdentity({ task_id: 'task-race' })
  await Promise.all([delta, terminal])
  unsubscribe()

  expect(events).toEqual([{ type: 'turn_complete' }])
})

test('worker sink durably records an explained approval before publishing it', async () => {
  const order: string[] = []
  const action = { what: '运行一条受限命令', scope: '当前任务工作区之外的本机资源或网络边界', consequence: '命令可能修改文件、启动进程或访问外部服务。' }
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-approval' }),
    recordTaskRunApprovalRequest: async (_run: string, _generation: number, requestId: string) => {
      order.push('durable')
      return { task_id: 'task-approval', event: { type: 'approval_required' as const, requestId, kind: 'action' as const, action } }
    },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-approval' && event.type === 'approval_required') order.push(`publish:${event.requestId}`)
  })

  await sink.record('run', 1, { type: 'event', event: 'approval', request_id: 'approval-1', action })
  unsubscribe()
  expect(order).toEqual(['durable', 'publish:approval-1'])
  expect(productTaskWorkerRuntimeEvents.snapshot('task-approval').state).toBe('awaiting_approval')
  expect(productTaskWorkerRuntimeEvents.ownsApproval('task-approval', 'approval-1')).toBeTrue()
  productTaskWorkerRuntimeEvents.publish('task-approval', { type: 'status', state: 'working' })
  expect(productTaskWorkerRuntimeEvents.ownsApproval('task-approval', 'approval-1')).toBeFalse()
})
