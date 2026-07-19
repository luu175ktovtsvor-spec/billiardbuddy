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
    maxConcurrentPerToken: 2, // defaults to the global cap when not specified
    queueMax: Infinity, // gateway production pools always set this to a finite bound
    oldestQueueMs: expect.any(Number),
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

test('capacity scheduler caps its waiting queue and reports the oldest waiter', async () => {
  const scheduler = new FairCapacityScheduler(1, 1, 1, 2)
  const active = await scheduler.acquire('active', { maxWaitMs: 1000 })
  const firstQueued = scheduler.acquire('queued-a', { maxWaitMs: 1000 })
  const secondQueued = scheduler.acquire('queued-b', { maxWaitMs: 1000 })

  const snapshot = scheduler.snapshot()
  expect(snapshot).toMatchObject({
    active: 1,
    queued: 2,
    maxConcurrent: 1,
    maxConcurrentPerUser: 1,
    maxConcurrentPerToken: 1,
    queueMax: 2,
  })
  expect(snapshot.oldestQueueMs).toBeGreaterThanOrEqual(0)
  await expect(scheduler.acquire('overflow', { maxWaitMs: 1000 })).rejects.toMatchObject({
    status: 429,
    publicMessage: '当前使用人数较多，排队已满，请稍后重试',
  })

  active.release()
  const next = await firstQueued
  next.release()
  const final = await secondQueued
  final.release()
  expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
})

test('MiMo-style 64/1/64 pool admits one permit for each of 100 sequential installations before repeat windows', async () => {
  // The fifth argument is an active + queued per-install cap. It deliberately differs
  // from the active-only `maxConcurrentPerUser`: each installation may hold one MiMo
  // call or wait for one, but cannot consume all 64 short-queue entries with windows 2–5.
  const scheduler = new FairCapacityScheduler(64, 1, 64, 64, 1)
  const active: Array<{ release(): void }> = []
  const admittedByUser = new Map<string, number>()
  let releaseSubsequentPermits = false
  const outcomes = Array.from({ length: 100 }, (_, user) =>
    Array.from({ length: 5 }, () => {
      const installation = `shared-token#install-${String(user).padStart(3, '0')}`
      return scheduler.acquire(installation, {
        tokenId: 'shared-token',
        maxWaitMs: 1_000,
      }).then(permit => {
        admittedByUser.set(installation, (admittedByUser.get(installation) ?? 0) + 1)
        if (releaseSubsequentPermits) permit.release()
        else active.push(permit)
        return 200
      }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(CapacityQueueError)
        return 429
      })
    }),
  ).flat()

  // Requests are intentionally created installation-by-installation, the worst ordering
  // for fairness. The first 64 are active; the remaining 36 accepted requests are one
  // each from later installations, rather than repeat windows from the first 64.
  await Promise.resolve()
  expect(scheduler.snapshot()).toMatchObject({
    active: 64,
    queued: 36,
    maxConcurrent: 64,
    maxConcurrentPerUser: 1,
    maxConcurrentPerToken: 64,
    queueMax: 64,
  })
  expect(active).toHaveLength(64)

  releaseSubsequentPermits = true
  for (const permit of active.splice(0)) permit.release()
  const statuses = await Promise.all(outcomes)
  expect(statuses.filter(status => status === 200)).toHaveLength(100)
  expect(statuses.filter(status => status === 429)).toHaveLength(400)
  expect(admittedByUser.size).toBe(100)
  expect([...admittedByUser.values()]).toEqual(Array.from({ length: 100 }, () => 1))
  expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, oldestQueueMs: 0 })
})

test('five-window profile caps one installation at five permits before later users arrive', async () => {
  const scheduler = new FairCapacityScheduler(256, 5, 256, 256)
  const firstFive = await Promise.all(
    Array.from({ length: 5 }, () => scheduler.acquire('shared-token#install-0001', {
      tokenId: 'shared-token',
      maxWaitMs: 1000,
    })),
  )
  const sixth = scheduler.acquire('shared-token#install-0001', {
    tokenId: 'shared-token',
    maxWaitMs: 1000,
  })
  expect(scheduler.snapshot()).toMatchObject({ active: 5, queued: 1, maxConcurrentPerUser: 5 })

  // A different installation sharing the same app token still gets a slot: the token
  // ceiling is global, while the five-window cap is per installation.
  const otherInstall = await scheduler.acquire('shared-token#install-0002', {
    tokenId: 'shared-token',
    maxWaitMs: 1000,
  })
  expect(scheduler.snapshot()).toMatchObject({ active: 6, queued: 1 })

  firstFive[0]!.release()
  const sixthPermit = await sixth
  for (const permit of firstFive.slice(1)) permit.release()
  sixthPermit.release()
  otherInstall.release()
  expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0 })
})
