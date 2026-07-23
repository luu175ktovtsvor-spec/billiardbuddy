import { expect, test } from 'bun:test'
import { CapacityQueueError, MimoReservationScheduler } from './modelCapacity'

function scheduler(overrides: Partial<ConstructorParameters<typeof MimoReservationScheduler>[0]> = {}) {
  return new MimoReservationScheduler({
    maxConcurrent: 6, nativeConcurrent: 2, visionConcurrent: 4,
    maxConcurrentPerUser: 4, maxConcurrentPerToken: 6, maxInflightPerUser: 4,
    nativeQueueMax: 1, visionQueueMax: 1, visionMaxConcurrentPerUser: 4, visionMaxInflightPerUser: 4,
    ...overrides,
  })
}

test('vision lane global cap admits four distinct users then rejects the fifth', async () => {
  const reservations = scheduler()
  const vision = reservations.forLane('vision')
  const permits = await Promise.all(Array.from({ length: 4 }, (_, index) => vision.acquire(`user-${index}`, { maxWaitMs: 0, tokenId: `token-${index}` })))
  await expect(vision.acquire('user-4', { maxWaitMs: 0, tokenId: 'token-4' })).rejects.toMatchObject({ status: 429 } satisfies Partial<CapacityQueueError>)
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 4, queued: 0 })
  permits.forEach(permit => permit.release())
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 0, queued: 0 })
})

test('vision lane limits one user while admitting another user', async () => {
  const reservations = scheduler({ maxConcurrent: 4, nativeConcurrent: 2, visionConcurrent: 2, visionMaxConcurrentPerUser: 1, visionMaxInflightPerUser: 1 })
  const vision = reservations.forLane('vision')
  const first = await vision.acquire('same-user', { maxWaitMs: 0, tokenId: 'same-token' })
  await expect(vision.acquire('same-user', { maxWaitMs: 0, tokenId: 'same-token' })).rejects.toMatchObject({ status: 429 } satisfies Partial<CapacityQueueError>)
  const other = await vision.acquire('other-user', { maxWaitMs: 0, tokenId: 'other-token' })
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 2, queued: 0 })
  first.release(); other.release()
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 0, queued: 0 })
})

test('vision queue abort removes its waiter and preserves active permit accounting', async () => {
  const reservations = scheduler({ maxConcurrent: 3, nativeConcurrent: 2, visionConcurrent: 1, visionQueueMax: 1, visionMaxConcurrentPerUser: 2, visionMaxInflightPerUser: 2 })
  const vision = reservations.forLane('vision')
  const first = await vision.acquire('first', { maxWaitMs: 0, tokenId: 'first-token' })
  const controller = new AbortController()
  const queued = vision.acquire('second', { maxWaitMs: 2_000, tokenId: 'second-token', signal: controller.signal })
  await Promise.resolve()
  await expect(vision.acquire('third', { maxWaitMs: 0, tokenId: 'third-token' })).rejects.toMatchObject({ status: 429 } satisfies Partial<CapacityQueueError>)
  controller.abort()
  await expect(queued).rejects.toMatchObject({ status: 499 } satisfies Partial<CapacityQueueError>)
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 1, queued: 0 })
  first.release()
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 0, queued: 0 })
})
