import { expect, test } from 'bun:test'
import net from 'node:net'
import { reserveServerPort, waitForServer, killSidecar } from './sidecarManager'

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
