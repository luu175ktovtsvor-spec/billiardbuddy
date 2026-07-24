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
