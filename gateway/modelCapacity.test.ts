import { expect, test } from 'bun:test'
import { CapacityQueueError, FairCapacityScheduler } from './modelCapacity'

test('capacity scheduler applies per-user limits without blocking other users', async () => {
  const scheduler = new FairCapacityScheduler(2, 1)
  const firstA = await scheduler.acquire('a', { maxWaitMs: 1000 })
  const secondAPromise = scheduler.acquire('a', { maxWaitMs: 1000 })
  const firstB = await scheduler.acquire('b', { maxWaitMs: 1000 })

  expect(scheduler.snapshot()).toEqual({
    active: 2,
    queued: 1,
    maxConcurrent: 2,
    maxConcurrentPerUser: 1,
  })

  firstB.release()
  expect(scheduler.snapshot().active).toBe(1)
  firstA.release()
  const secondA = await secondAPromise
  expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 0 })
  secondA.release()
  secondA.release()
  expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('capacity scheduler rotates queued users fairly', async () => {
  const scheduler = new FairCapacityScheduler(1, 1)
  const first = await scheduler.acquire('a', { maxWaitMs: 1000 })
  const a2 = scheduler.acquire('a', { maxWaitMs: 1000 })
  const b1 = scheduler.acquire('b', { maxWaitMs: 1000 })
  const a3 = scheduler.acquire('a', { maxWaitMs: 1000 })

  first.release()
  const nextA = await a2
  nextA.release()
  const nextB = await b1
  nextB.release()
  const finalA = await a3
  finalA.release()
})

test('capacity scheduler times out and removes cancelled requests', async () => {
  const scheduler = new FairCapacityScheduler(1, 1)
  const active = await scheduler.acquire('a', { maxWaitMs: 1000 })

  await expect(scheduler.acquire('b', { maxWaitMs: 5 })).rejects.toMatchObject({
    status: 429,
    publicMessage: '当前使用人数较多，排队等待超时，请稍后重试',
  })

  const controller = new AbortController()
  const cancelled = scheduler.acquire('c', { maxWaitMs: 1000, signal: controller.signal })
  controller.abort()
  await expect(cancelled).rejects.toBeInstanceOf(CapacityQueueError)
  expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 0 })
  active.release()
})
