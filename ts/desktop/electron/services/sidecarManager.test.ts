import { expect, test } from 'bun:test'
import net from 'node:net'
import { reserveServerPort, waitForServer, killSidecar, SidecarSupervisor } from './sidecarManager'

/** 假 sidecar child:只实现守护器用到的 on('exit') / kill / pid,并可手动触发退出。 */
function makeFakeChild(id: number) {
  let exitListener: ((code: number | null) => void) | null = null
  return {
    pid: 1000 + id,
    killed: false,
    on(event: string, listener: (code: number | null) => void) {
      if (event === 'exit') exitListener = listener
      return this
    },
    kill() { this.killed = true },
    triggerExit(code: number | null) { exitListener?.(code) },
    // 守护器不直接读 stdout/stderr(交给 onSpawn 钩子),这里给占位以贴合类型。
    stdout: { on() {} },
    stderr: { on() {} },
  }
}

/** 受控时钟 + 手动 flush 的假定时器,让退避逻辑可确定性断言。 */
function makeFakeClock() {
  let now = 0
  const pending: { fn: () => void; at: number }[] = []
  return {
    now: () => now,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const handle = { fn, at: now + ms }
      pending.push(handle)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => {
      const i = pending.indexOf(h as unknown as { fn: () => void; at: number })
      if (i >= 0) pending.splice(i, 1)
    },
    advance: (ms: number) => {
      now += ms
      const due = pending.filter((p) => p.at <= now)
      for (const p of due) pending.splice(pending.indexOf(p), 1)
      for (const p of due) p.fn()
    },
    pendingCount: () => pending.length,
  }
}

test('reserveServerPort returns a bindable port when preferred are taken', async () => {
  // 占住一个端口,证明 reserve 会跳过它、回落到可用端口
  const blocker = net.createServer()
  await new Promise<void>(r => blocker.listen(0, '127.0.0.1', () => r()))
  const takenPort = (blocker.address() as net.AddressInfo).port
  const port = await reserveServerPort('127.0.0.1', [takenPort])
  expect(port).toBeGreaterThan(0)
  expect(port).not.toBe(takenPort)
  blocker.close()
})

test('waitForServer resolves once something listens, rejects on timeout', async () => {
  const srv = net.createServer()
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as net.AddressInfo).port
  await waitForServer('127.0.0.1', port, 2000) // 应立即 resolve
  srv.close()
  await new Promise<void>(r => srv.on('close', () => r()))
  await expect(waitForServer('127.0.0.1', port, 500)).rejects.toThrow(/did not start/)
})

test('killSidecar uses taskkill on win32 and child.kill elsewhere (deps injected)', () => {
  let taskkillCalled = false
  let childKilled = false
  const fakeChild = { pid: 4242, kill: () => { childKilled = true } }
  const spawnAsync = ((cmd: string) => { if (cmd === 'taskkill') taskkillCalled = true; return {} }) as any
  killSidecar(fakeChild, false, { platform: 'win32', spawnAsync })
  expect(taskkillCalled).toBe(true)
  expect(childKilled).toBe(false)

  taskkillCalled = false
  killSidecar(fakeChild, false, { platform: 'darwin', spawnAsync })
  expect(taskkillCalled).toBe(false)
  expect(childKilled).toBe(true)
})

test('SidecarSupervisor: 意外退出后按退避重启,且端口/工厂被复用', () => {
  const clock = makeFakeClock()
  const children: ReturnType<typeof makeFakeChild>[] = []
  let spawnCount = 0
  const restarts: { attempt: number; delayMs: number }[] = []

  const sup = new SidecarSupervisor(
    () => { const c = makeFakeChild(spawnCount++); children.push(c); return c as never },
    { onRestartScheduled: (attempt, delayMs) => restarts.push({ attempt, delayMs }) },
    { backoffBaseMs: 1000, backoffMaxMs: 16_000, healthyResetMs: 30_000 },
    { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now },
  )

  sup.start()
  expect(spawnCount).toBe(1)

  // 第一个 child 崩溃 → 排定第 1 次重启(退避 base*2^0 = 1000ms)。
  children[0]!.triggerExit(1)
  expect(restarts[0]).toEqual({ attempt: 1, delayMs: 1000 })
  expect(spawnCount).toBe(1) // 还没到点,尚未重启
  clock.advance(1000)
  expect(spawnCount).toBe(2) // 到点后拉起第二个

  // 第二个 child 立刻又崩(仍在窗口内)→ 第 2 次重启退避翻倍 = 2000ms。
  children[1]!.triggerExit(1)
  expect(restarts[1]).toEqual({ attempt: 2, delayMs: 2000 })
  clock.advance(2000)
  expect(spawnCount).toBe(3)
})

test('SidecarSupervisor: 滚动窗口内重启触顶 → 停手并回调 onGaveUp', () => {
  const clock = makeFakeClock()
  let spawnCount = 0
  let gaveUp = 0
  const children: ReturnType<typeof makeFakeChild>[] = []

  const sup = new SidecarSupervisor(
    () => { const c = makeFakeChild(spawnCount++); children.push(c); return c as never },
    { onGaveUp: () => { gaveUp++ } },
    { maxRestarts: 3, restartWindowMs: 60_000, backoffBaseMs: 100, backoffMaxMs: 100, healthyResetMs: 30_000 },
    { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now },
  )

  sup.start()
  // 连续崩溃:每次崩→到点重启→再崩。前 3 次会重启,第 4 次触顶放弃。
  for (let i = 0; i < 3; i++) {
    children[i]!.triggerExit(1)
    clock.advance(100)
  }
  expect(spawnCount).toBe(4) // 初次 + 3 次重启
  expect(gaveUp).toBe(0)

  children[3]!.triggerExit(1) // 第 4 次崩溃:窗口内已达上限
  expect(gaveUp).toBe(1)
  expect(clock.pendingCount()).toBe(0) // 不再排定新的重启
})

test('SidecarSupervisor: 稳定存活够久后崩溃 → 重置计数,退避从头来', () => {
  const clock = makeFakeClock()
  let spawnCount = 0
  const children: ReturnType<typeof makeFakeChild>[] = []
  const restarts: number[] = []

  const sup = new SidecarSupervisor(
    () => { const c = makeFakeChild(spawnCount++); children.push(c); return c as never },
    { onRestartScheduled: (_a, delayMs) => restarts.push(delayMs) },
    { backoffBaseMs: 1000, backoffMaxMs: 16_000, healthyResetMs: 30_000 },
    { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now },
  )

  sup.start()
  children[0]!.triggerExit(1)          // 退避 1000
  clock.advance(1000)
  // 第二个稳定跑了很久(超过 healthyResetMs)才崩 → 计数重置,退避回到 1000 而非 2000。
  clock.advance(40_000)
  children[1]!.triggerExit(1)
  expect(restarts).toEqual([1000, 1000])
})

test('SidecarSupervisor: stop() 后子进程退出不再重启', () => {
  const clock = makeFakeClock()
  let spawnCount = 0
  const children: ReturnType<typeof makeFakeChild>[] = []

  const sup = new SidecarSupervisor(
    () => { const c = makeFakeChild(spawnCount++); children.push(c); return c as never },
    {},
    {},
    { setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn, now: clock.now },
  )

  sup.start()
  sup.stop() // 主动关闭(before-quit)
  expect(children[0]!.killed).toBe(true)
  children[0]!.triggerExit(0) // 主动关闭后的退出事件
  expect(spawnCount).toBe(1)  // 不再拉起
})
