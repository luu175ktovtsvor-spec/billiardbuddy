import { expect, test } from 'bun:test'
import { CapacityQueueError, MimoReservationScheduler } from './modelCapacity'

test('five vision permits sharing one token reject a sixth while another token can enter', async () => {
  const reservations = new MimoReservationScheduler({
    maxConcurrent: 8, nativeConcurrent: 2, visionConcurrent: 6,
    maxConcurrentPerUser: 6, maxConcurrentPerToken: 5, maxInflightPerUser: 6,
    nativeQueueMax: 1, visionQueueMax: 1, visionMaxConcurrentPerUser: 6, visionMaxInflightPerUser: 6,
  })
  const vision = reservations.forLane('vision')
  let simulatedUpstreamCalls = 0
  const permits = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    const permit = await vision.acquire(`install-${index}`, { maxWaitMs: 0, tokenId: 'shared-account' })
    simulatedUpstreamCalls++
    return permit
  }))
  await expect(vision.acquire('install-5', { maxWaitMs: 0, tokenId: 'shared-account' })).rejects.toMatchObject({ status: 429 } satisfies Partial<CapacityQueueError>)
  expect(simulatedUpstreamCalls).toBe(5)
  const otherToken = await vision.acquire('other-install', { maxWaitMs: 0, tokenId: 'other-account' })
  simulatedUpstreamCalls++
  expect(simulatedUpstreamCalls).toBe(6)
  expect(reservations.snapshot()).toMatchObject({ active: 6, queued: 0 })
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 6, queued: 0 })
  permits.forEach(permit => permit.release()); otherToken.release()
  expect(reservations.snapshot()).toMatchObject({ active: 0, queued: 0 })
  expect(reservations.laneSnapshot('vision')).toMatchObject({ active: 0, queued: 0 })
})
