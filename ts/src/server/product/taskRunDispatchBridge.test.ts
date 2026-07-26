import { expect, test } from 'bun:test'
import type { ProductTaskService } from './taskService.js'
import { ProductTaskWorkerMessageSink } from './taskRunDispatchBridge.js'
import { productTaskWorkerRuntimeEvents } from './taskWorkerRuntimeEvents.js'

test('worker sink publishes only product-safe assistant text and one terminal fence', async () => {
  const durable: unknown[] = []
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-safe' }),
    recordTaskRunTerminalProjection: async (...args: unknown[]) => { durable.push(args); return { task_id: 'task-safe' } },
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
  expect(durable).toEqual([['run', 1, 'completed', '完成结果']])
})

test('worker sink persists and publishes the same safe run failure', async () => {
  const durable: unknown[] = []
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-failure' }),
    recordTaskRunTerminalProjection: async (...args: unknown[]) => { durable.push(args); return { task_id: 'task-failure' } },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const events: unknown[] = []
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-failure') events.push(event)
  })
  const failure = { code: 'task_network_unavailable' as const, retryable: true }

  await sink.record('run-failure', 3, { type: 'terminal', state: 'recovery_required', run_id: 'run-failure', failure })
  unsubscribe()

  expect(durable).toEqual([['run-failure', 3, 'recovery_required', '', failure]])
  expect(events).toEqual([{ type: 'error', ...failure }])
})

test('terminal waits for an earlier event identity and rejects only events arriving after the fence', async () => {
  let resolveIdentity!: (value: { task_id: string }) => void
  const identity = new Promise<{ task_id: string }>((resolve) => { resolveIdentity = resolve })
  const tasks = {
    readTaskRunDispatchIdentity: async () => identity,
    recordTaskRunTerminalProjection: async () => ({ task_id: 'task-race' }),
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

  expect(events).toEqual([
    { type: 'assistant_text_start' },
    { type: 'assistant_text_delta', text: '不得晚到' },
    { type: 'turn_complete' },
  ])
})

test('worker sink persists an opaque activity phase before publishing it', async () => {
  const order: string[] = []
  const activity = { id: 'activity_0123456789abcdef0123456789abcdef', kind: 'workspace' as const, phase: 'started' as const, summary: '正在整理工作内容' }
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-activity' }),
    recordTaskRunActivity: async (_run: string, _generation: number, event: { id: string }) => {
      order.push(`durable:${event.id}`)
      return { task_id: 'task-activity', event: { type: 'activity' as const, ...activity } }
    },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-activity' && event.type === 'activity') order.push(`publish:${event.id}`)
  })
  await sink.record('run-activity', 1, { type: 'event', event: 'activity', activity })
  unsubscribe()
  expect(order).toEqual([
    `durable:${activity.id}`,
    `publish:${activity.id}`,
  ])
})

test('worker sink freezes the Turn extension manifest before tool activity', async () => {
  const snapshots: unknown[] = []
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-extensions' }),
    recordTaskRunExtensionSnapshot: async (...args: unknown[]) => { snapshots.push(args) },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  await sink.record('run-extensions', 2, {
    type: 'event',
    event: 'extension_snapshot',
    digest: 'a'.repeat(64),
    tool_count: 12,
    command_count: 3,
    mcp_server_count: 1,
  })
  expect(snapshots).toEqual([[
    'run-extensions',
    2,
    { digest: 'a'.repeat(64), tool_count: 12, command_count: 3, mcp_server_count: 1 },
  ]])
})

test('worker sink persists compact lifecycle before publishing it', async () => {
  const order: string[] = []
  const compact = { type: 'event' as const, event: 'context_compaction' as const, phase: 'completed' as const, source: 'automatic' as const, generation: 2, input_tokens: 12_000, output_tokens: 20, summary: 'private summary', compacted_through_event_sequence: 14 }
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-compact' }),
    recordTaskRunContextCompaction: async () => {
      order.push('durable')
      return { task_id: 'task-compact', event: { type: 'context_compaction' as const, item: { id: 'compact_0123456789abcdef0123456789abcdef', phase: 'completed' as const, source: 'automatic' as const, generation: 2 }, event_sequence: 15 } }
    },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-compact' && event.type === 'context_compaction') order.push(`publish:${event.item.phase}`)
  })
  await sink.record('run-compact', 1, compact)
  unsubscribe()
  expect(order).toEqual(['durable', 'publish:completed'])
})

test('worker sink publishes steer assignment only after its durable user Item exists', async () => {
  const order: string[] = []
  const queueEvent = { type: 'queue_updated' as const, item: { id: 'queue_123e4567-e89b-42d3-a456-426614174000', text: 'follow up', state: 'injected' as const, createdAt: '2026-07-26T00:00:00.000Z', attachmentCount: 0, targetRunId: 'run_123e4567-e89b-42d3-a456-426614174000' }, event_sequence: 2 }
  const userEvent = { type: 'user_text' as const, id: 'thread_0123456789abcdef0123', text: 'follow up', replayed: true as const, event_sequence: 3 }
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-steer' }),
    recordQueuedInputConsumed: async () => {
      order.push('durable')
      return { task_id: 'task-steer', events: [queueEvent, userEvent] }
    },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-steer') order.push(`publish:${event.type}`)
  })
  await sink.record('run-steer', 1, { type: 'steer_consumed', queue_item_id: queueEvent.item.id })
  unsubscribe()
  expect(order).toEqual(['durable', 'publish:queue_updated', 'publish:user_text'])
})

test('worker sink durably records an explained approval before publishing it', async () => {
  const order: string[] = []
  const action = { what: '运行一条受限命令', scope: '当前任务工作区之外的本机资源或网络边界', consequence: '命令可能修改文件、启动进程或访问外部服务。' }
  const review = { category: 'command' as const, read_only: false, destructive: false, open_world: false }
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-approval' }),
    recordTaskRunApprovalRequest: async (_run: string, _generation: number, requestId: string) => {
      order.push('durable')
      return { task_id: 'task-approval', reviewer: 'user' as const, event: { type: 'approval_required' as const, requestId, kind: 'action' as const, action } }
    },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-approval' && event.type === 'approval_required') order.push(`publish:${event.requestId}`)
  })

  await sink.record('run', 1, { type: 'event', event: 'approval', request_id: 'approval-1', action, review })
  unsubscribe()
  expect(order).toEqual(['durable', 'publish:approval-1'])
  expect(productTaskWorkerRuntimeEvents.snapshot('task-approval').state).toBe('awaiting_approval')
  expect(productTaskWorkerRuntimeEvents.ownsApproval('task-approval', 'approval-1')).toBeTrue()
  productTaskWorkerRuntimeEvents.publish('task-approval', { type: 'status', state: 'working' })
  expect(productTaskWorkerRuntimeEvents.ownsApproval('task-approval', 'approval-1')).toBeFalse()
})

test('automatic reviewer decides a durable request without creating a user approval card', async () => {
  const action = { what: '读取受保护的文件', scope: '当前任务工作区之外的文件位置', consequence: '允许后会读取本次任务所需的文件。' }
  const review = { category: 'filesystem' as const, read_only: true, destructive: false, open_world: false }
  const resolutions: unknown[] = []
  const tasks = {
    readTaskRunDispatchIdentity: async () => ({ task_id: 'task-auto' }),
    recordTaskRunApprovalRequest: async () => ({ task_id: 'task-auto', reviewer: 'automatic' as const, event: { type: 'approval_required' as const, requestId: 'approval-auto', kind: 'action' as const, action } }),
    resolveTaskRunApproval: async (...args: unknown[]) => { resolutions.push(args); return true },
  } as unknown as ProductTaskService
  const sink = new ProductTaskWorkerMessageSink(tasks)
  const published: unknown[] = []
  const unsubscribe = productTaskWorkerRuntimeEvents.subscribe((taskId, event) => {
    if (taskId === 'task-auto') published.push(event)
  })

  await sink.record('run-auto', 1, { type: 'event', event: 'approval', request_id: 'approval-auto', action, review })
  unsubscribe()
  expect(resolutions).toEqual([['task-auto', 'approval-auto', true, 'automatic', 'read_only_local']])
  expect(published).toEqual([])
})
