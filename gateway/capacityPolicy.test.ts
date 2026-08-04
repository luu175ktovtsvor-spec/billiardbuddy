import { describe, expect, test } from 'bun:test'
import { loadCapacityPolicy } from './capacityPolicy.ts'
import { CapacityQueueError, FairCapacityScheduler, ProviderRateLimiter } from './modelCapacity.ts'

describe('gateway capacity policy', () => {
  test('uses a deliberately small default profile', () => {
    const policy = loadCapacityPolicy({})

    expect(policy.deepseek).toMatchObject({ rpm: 120, maxConcurrent: 8, queueMax: 24, responseTimeoutMs: 120_000 })
    expect(policy.mimo).toMatchObject({ maxConcurrent: 8, mediaConcurrent: 5, visionConcurrent: 3, rpm: 60 })
    expect(policy.funasr).toMatchObject({ rpm: 6, maxConcurrent: 1, queueMax: 4, timeoutMs: 180_000 })
    expect(policy.ingress).toMatchObject({ inflightBodyBytes: 64 * 1024 * 1024, serverIdleTimeoutSeconds: 120 })
  })

  test('fails closed for malformed or out-of-range supplied values', () => {
    expect(() => loadCapacityPolicy({ GW_DEEPSEEK_CONC: 'eight' })).toThrow('GW_DEEPSEEK_CONC must be a decimal integer')
    expect(() => loadCapacityPolicy({ GW_QWEN_QUEUE_MAX: '-1' })).toThrow('GW_QWEN_QUEUE_MAX must be a decimal integer')
    expect(() => loadCapacityPolicy({ GW_MIMO_QUEUE_MAX_WAIT: 'forever' })).toThrow('GW_MIMO_QUEUE_MAX_WAIT must be a non-negative decimal number of seconds')
    expect(() => loadCapacityPolicy({ GW_DEEPSEEK_USER_CONC: '9' })).toThrow('GW_DEEPSEEK_USER_CONC must not exceed GW_DEEPSEEK_CONC')
  })

  test('allows an existing global ceiling override without inventing invalid child limits', () => {
    expect(loadCapacityPolicy({ GW_DEEPSEEK_CONC: '1' }).deepseek)
      .toMatchObject({ maxConcurrent: 1, maxConcurrentPerUser: 1, maxConcurrentPerToken: 1 })
  })

  test('requires MiMo media and visual lane reservations to equal the shared account ceiling', () => {
    const policy = loadCapacityPolicy({ GW_MIMO_CONC: '6', GW_MIMO_MEDIA_CONC: '4', GW_VISION_CONC: '2' })
    expect(policy.mimo.mediaConcurrent + policy.mimo.visionConcurrent).toBe(policy.mimo.maxConcurrent)

    expect(() => loadCapacityPolicy({ GW_MIMO_CONC: '6', GW_MIMO_MEDIA_CONC: '4', GW_VISION_CONC: '3' }))
      .toThrow('GW_MIMO_MEDIA_CONC + GW_VISION_CONC must equal GW_MIMO_CONC')
  })

  test('keeps future Qwen capacity independent from the shared MiMo account', () => {
    const policy = loadCapacityPolicy({ GW_MIMO_CONC: '6', GW_QWEN_CONC: '3', GW_QWEN_RPM: '17' })

    expect(policy.mimo.maxConcurrent).toBe(6)
    expect(policy.mimo.mediaConcurrent + policy.mimo.visionConcurrent).toBe(6)
    expect(policy.qwen).toMatchObject({ maxConcurrent: 3, rpm: 17 })
  })

  test('调度按受信 owner 公平，且释放许可后才推进同 owner 的下一项', async () => {
    const scheduler = new FairCapacityScheduler(2, 1, 2, 4, 2)
    const firstA = await scheduler.acquire('installation-a', { maxWaitMs: 0, tokenId: 'principal' })
    const firstB = await scheduler.acquire('installation-b', { maxWaitMs: 0, tokenId: 'principal' })
    let nextAResolved = false
    const nextA = scheduler.acquire('installation-a', { maxWaitMs: 1_000, tokenId: 'principal' })
      .then(permit => { nextAResolved = true; return permit })
    await Promise.resolve()
    expect(nextAResolved).toBeFalse()

    firstA.release()
    const secondA = await nextA
    expect(nextAResolved).toBeTrue()
    expect(scheduler.snapshot()).toMatchObject({ active: 2, queued: 0 })
    secondA.release()
    firstB.release()
  })

  test('RPM 队列有界且取消后不遗留 waiter', async () => {
    const limiter = new ProviderRateLimiter(1, 1)
    await limiter.acquire(0)
    await expect(limiter.acquire(0)).rejects.toBeInstanceOf(CapacityQueueError)

    const controller = new AbortController()
    const waiting = limiter.acquire(30, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ status: 499 })
    expect(limiter.snapshot().queued).toBe(0)
  })
})
