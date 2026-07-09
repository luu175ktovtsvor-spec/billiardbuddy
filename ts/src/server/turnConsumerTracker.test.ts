import { expect, test } from 'bun:test'
import { TurnConsumerTracker } from './turnConsumerTracker'

function fakeTimers() {
  const scheduled: Array<{ id: number; fn: () => void }> = []
  let seq = 0
  return {
    scheduleTimer: (fn: () => void) => { const id = ++seq; scheduled.push({ id, fn }); return id as unknown as ReturnType<typeof setTimeout> },
    cancelTimer: (h: ReturnType<typeof setTimeout>) => { const i = scheduled.findIndex(s => s.id === (h as unknown as number)); if (i >= 0) scheduled.splice(i, 1) },
    fireAll: () => { const copy = [...scheduled]; scheduled.length = 0; copy.forEach(s => s.fn()) },
    pending: () => scheduled.length,
  }
}

test('最后一个消费者断连 + 回合在跑 + 无重连 → 宽限期后中止', () => {
  const t = fakeTimers()
  const aborted: string[] = []
  const tracker = new TurnConsumerTracker({ graceMs: 1000, isRunning: () => true, abort: id => aborted.push(id), scheduleTimer: t.scheduleTimer, cancelTimer: t.cancelTimer })
  tracker.onConnect('c1')
  tracker.onDisconnect('c1')
  expect(t.pending()).toBe(1)
  t.fireAll()
  expect(aborted).toEqual(['c1'])
})

test('重连取消挂起的中止', () => {
  const t = fakeTimers()
  const aborted: string[] = []
  const tracker = new TurnConsumerTracker({ graceMs: 1000, isRunning: () => true, abort: id => aborted.push(id), scheduleTimer: t.scheduleTimer, cancelTimer: t.cancelTimer })
  tracker.onConnect('c1')
  tracker.onDisconnect('c1')
  tracker.onConnect('c1') // 重连 → 取消挂起中止
  t.fireAll()
  expect(aborted).toEqual([])
})

test('多消费者:只有最后一个断连才排中止计时器', () => {
  const t = fakeTimers()
  const tracker = new TurnConsumerTracker({ graceMs: 1000, isRunning: () => true, abort: () => {}, scheduleTimer: t.scheduleTimer, cancelTimer: t.cancelTimer })
  tracker.onConnect('c1')
  tracker.onConnect('c1')
  tracker.onDisconnect('c1')
  expect(t.pending()).toBe(0)
  tracker.onDisconnect('c1')
  expect(t.pending()).toBe(1)
})

test('回合已结束(isRunning false)→ 宽限到期不中止', () => {
  const t = fakeTimers()
  const aborted: string[] = []
  const tracker = new TurnConsumerTracker({ graceMs: 1000, isRunning: () => false, abort: id => aborted.push(id), scheduleTimer: t.scheduleTimer, cancelTimer: t.cancelTimer })
  tracker.onConnect('c1')
  tracker.onDisconnect('c1')
  t.fireAll()
  expect(aborted).toEqual([])
})
