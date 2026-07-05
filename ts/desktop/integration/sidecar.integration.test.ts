import { afterAll, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { reserveServerPort, waitForServer, killSidecar } from '../electron/services/sidecarManager'

/** 证明「Electron 会走的那条 spawn 链」:reserve 端口 → spawn Bun sidecar → 等就绪 → GET /health 200 → 杀干净。
 *  用 process.execPath(= 当前 bun 二进制)解释执行入口,快、且不依赖 PATH 上有 `bun`。
 *  编译出的二进制单独在 build:sidecar + 手动/CI 验(慢)。 */
const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) killSidecar(c, true)
})

test('electron-style: spawn Bun sidecar -> waitForServer -> GET /health 200 -> kill', async () => {
  const host = '127.0.0.1'
  const port = await reserveServerPort(host, [])
  const entry = path.resolve(import.meta.dir, '../sidecars/backend-sidecar.ts')
  const child = spawn(process.execPath, ['run', entry, 'server', '--host', host, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)

  await waitForServer(host, port, 15_000)
  const res = await fetch(`http://${host}:${port}/health`)
  expect(res.status).toBe(200)
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true)

  killSidecar(child, true)
  await new Promise<void>(resolve => child.on('exit', () => resolve()))
  // 杀掉后端口应不再有人听 —— waitForServer 应超时 reject
  await waitForServer(host, port, 800).then(
    () => {
      throw new Error('server still listening after kill')
    },
    () => {},
  )
})
