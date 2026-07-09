import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import net from 'node:net'
import type { Readable } from 'node:stream'

export const SERVER_BIND_HOST = '127.0.0.1'

export type SidecarChild = ChildProcessByStdio<null, Readable, Readable>
/** cwd:显式指定 sidecar 工作目录。打包后从 Finder/开始菜单启动时 Electron 进程 cwd=`/`,
 *  若不显式传,spawn 出的 sidecar 会继承这个坏 cwd(任何相对路径解析/落盘都可能失败)。 */
export type SidecarPlan = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }

function canBindPort(bindHost: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, bindHost, () => server.close(() => resolve(true)))
  })
}

async function reserveLocalPort(bindHost = SERVER_BIND_HOST): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, bindHost, () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') return reject(new Error('no port'))
        resolve(address.port)
      })
    })
  })
}

/** 首选端口(固定/上次)优先,全占了回落随机——起步版,sticky 落盘是 W13。 */
export async function reserveServerPort(bindHost: string, preferred: number[]): Promise<number> {
  for (const port of preferred) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (await canBindPort(bindHost, port)) return port
  }
  return await reserveLocalPort(bindHost)
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 200 })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function waitForServer(host: string, port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return
    await sleep(150)
  }
  throw new Error(`sidecar did not start listening on ${host}:${port} within ${Math.round(timeoutMs / 1000)}s`)
}

export type SpawnSidecarDeps = { existsSyncFn?: typeof existsSync; spawnFn?: typeof spawn }
export function spawnSidecar(plan: SidecarPlan, deps: SpawnSidecarDeps = {}): SidecarChild {
  const exists = deps.existsSyncFn ?? existsSync
  if (!exists(plan.command)) {
    throw new Error(`sidecar binary not found: ${plan.command}. Run "bun run build:sidecar" first.`)
  }
  return (deps.spawnFn ?? spawn)(plan.command, plan.args, {
    // 显式可写 cwd(打包后 Electron 进程 cwd 可能是 `/`,别让 sidecar 继承坏 cwd)。
    cwd: plan.cwd,
    env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export type KillSidecarDeps = {
  platform?: NodeJS.Platform
  spawnAsync?: typeof spawn
  spawnSyncFn?: typeof spawnSync
}
/** Win 上 taskkill /T 收整棵进程树防孤儿(Bun sidecar 会派 worker);其余 child.kill。 */
export function killSidecar(
  child: { pid?: number; kill: () => void },
  sync = false,
  deps: KillSidecarDeps = {},
): void {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' && child.pid) {
    const args = ['/F', '/T', '/PID', String(child.pid)]
    const options = { stdio: 'ignore', windowsHide: true } as const
    if (sync) (deps.spawnSyncFn ?? spawnSync)('taskkill', args, options)
    else (deps.spawnAsync ?? spawn)('taskkill', args, options)
    return
  }
  child.kill()
}
