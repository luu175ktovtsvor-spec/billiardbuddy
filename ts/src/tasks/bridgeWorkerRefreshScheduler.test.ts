import { expect, test } from 'bun:test'
import { BridgeWorkerRefreshScheduler } from './bridgeWorkerRefreshScheduler'

type Timer = {
  id: number
  delayMs: number
  callback: () => void
  cleared: boolean
}

function fakeTimers() {
  const timers: Timer[] = []
  return {
    timers,
    setTimeoutFn(callback: () => void, delayMs: number) {
      const timer = { id: timers.length + 1, delayMs, callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutFn(raw: unknown) {
      const timer = raw as Timer
      timer.cleared = true
    },
    fire(timer = timers.find(item => !item.cleared)) {
      if (!timer || timer.cleared) throw new Error('timer is not active')
      timer.callback()
    },
  }
}

test('BridgeWorkerRefreshScheduler schedules from expires_in with CC-Haha floor and buffer', () => {
  const timers = fakeTimers()
  const scheduler = new BridgeWorkerRefreshScheduler({
    sessionId: 'cse_refresh',
    refreshBufferMs: 300_000,
    minDelayMs: 30_000,
    now: () => 1_000_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onRefresh: async () => ({ value: 'ok', expiresInSeconds: 3600 }),
  })

  scheduler.scheduleFromExpiresIn(20)
  expect(timers.timers.at(-1)?.delayMs).toBe(30_000)
  expect(scheduler.getStatus(1_000_000)).toMatchObject({
    enabled: true,
    nextRefreshInMs: 30_000,
  })

  scheduler.scheduleFromExpiresIn(3600)
  expect(timers.timers.at(-1)?.delayMs).toBe(3_300_000)
  expect(timers.timers[0]?.cleared).toBe(true)
})

test('BridgeWorkerRefreshScheduler cancel invalidates queued proactive refresh', async () => {
  const timers = fakeTimers()
  let refreshes = 0
  const scheduler = new BridgeWorkerRefreshScheduler({
    sessionId: 'cse_refresh',
    minDelayMs: 10,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onRefresh: async () => {
      refreshes += 1
      return { value: 'ok', expiresInSeconds: 3600 }
    },
  })

  scheduler.scheduleFromExpiresIn(1)
  scheduler.cancel()
  expect(timers.timers[0]?.cleared).toBe(true)
  expect(scheduler.getStatus()).toMatchObject({ enabled: false, nextRefreshAt: null })
  await scheduler.refreshNow('manual_refresh')
  expect(refreshes).toBe(0)
})

test('BridgeWorkerRefreshScheduler skips overlapping refreshes and reschedules after success', async () => {
  const timers = fakeTimers()
  let release: ((value: { value: string; expiresInSeconds: number }) => void) | undefined
  let refreshes = 0
  const scheduler = new BridgeWorkerRefreshScheduler({
    sessionId: 'cse_refresh',
    refreshBufferMs: 0,
    minDelayMs: 10,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onRefresh: async (): Promise<{ value: string; expiresInSeconds: number }> => {
      refreshes += 1
      return await new Promise(resolve => { release = resolve })
    },
  })

  scheduler.scheduleFromExpiresIn(1)
  const first = scheduler.refreshNow('manual_refresh')
  const second = await scheduler.refreshNow('auth_401_recovery')
  expect(second).toMatchObject({ ok: false, skipped: true, reason: 'in_flight' })
  release?.({ value: 'fresh', expiresInSeconds: 3600 })
  expect(await first).toMatchObject({ ok: true, value: 'fresh' })
  expect(refreshes).toBe(1)
  expect(timers.timers.at(-1)?.delayMs).toBe(3_600_000)
})

test('BridgeWorkerRefreshScheduler retries failed proactive refreshes with a capped chain', async () => {
  const timers = fakeTimers()
  let attempts = 0
  const scheduler = new BridgeWorkerRefreshScheduler({
    sessionId: 'cse_refresh',
    minDelayMs: 10,
    retryDelayMs: 25,
    maxConsecutiveFailures: 2,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onRefresh: async () => {
      attempts += 1
      throw new Error('network down')
    },
  })

  scheduler.scheduleFromExpiresIn(1)
  timers.fire()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(scheduler.getStatus()).toMatchObject({
    consecutiveFailures: 1,
    lastError: 'network down',
    nextRefreshInMs: expect.any(Number),
  })
  expect(timers.timers.at(-1)?.delayMs).toBe(25)

  timers.fire(timers.timers.at(-1))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(attempts).toBe(2)
  expect(scheduler.getStatus()).toMatchObject({
    consecutiveFailures: 2,
    nextRefreshAt: null,
  })
})
