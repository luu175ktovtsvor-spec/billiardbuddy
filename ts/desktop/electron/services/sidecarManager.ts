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

// ────────────────────────────────────────────────────────────────────────────
// Sidecar 守护(意外退出 → 自动重启 + 指数退避 + 次数封顶):长会话 agent 循环里 sidecar 任
// 何时候崩了都不该让整个应用停摆。守护器监听 child 的 'exit',若非主动关闭就按退避拉起下一个;
// 端口由调用方保持稳定(同口重启),这样 renderer 的 baseUrl 不失效、现有 WS 指数退避重连即可复连。
// 防雪崩:滚动窗口内累计重启达上限就停手并回调 onGaveUp(交给 main 弹窗提示,而不是无限重启烧 CPU)。
// ────────────────────────────────────────────────────────────────────────────

export interface SidecarSupervisorConfig {
  /** 滚动窗口内允许的最大重启次数,超过就停手。默认 5。 */
  maxRestarts: number
  /** 统计重启次数的滚动窗口(ms)。默认 60s。 */
  restartWindowMs: number
  /** 退避基数(ms):第 n 次重启延迟 = min(base * 2^n, max)。默认 1s。 */
  backoffBaseMs: number
  /** 退避上限(ms)。默认 16s。 */
  backoffMaxMs: number
  /** sidecar 稳定存活超过此时长(ms)后视为"健康",重置重启计数。默认 30s。 */
  healthyResetMs: number
}

export const DEFAULT_SIDECAR_SUPERVISOR: SidecarSupervisorConfig = {
  maxRestarts: 5,
  restartWindowMs: 60_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 16_000,
  healthyResetMs: 30_000,
}

export interface SidecarSupervisorHooks {
  /** 每次(重)spawn 出新 child 后回调:用于挂 stdout/stderr 管道等。 */
  onSpawn?: (child: SidecarChild) => void
  /** child 退出时回调(willRestart 表示是否会自动重启)。 */
  onExit?: (code: number | null, willRestart: boolean) => void
  /** 已排定重启时回调(attempt 从 1 起,delayMs 为本次退避)。 */
  onRestartScheduled?: (attempt: number, delayMs: number) => void
  /** 触顶放弃自动重启时回调(交给 main 优雅提示用户)。 */
  onGaveUp?: (restartsInWindow: number) => void
}

export interface SidecarSupervisorDeps {
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

type ExitListenerChild = SidecarChild & { on(event: 'exit', listener: (code: number | null) => void): unknown }

/** 守护单个 sidecar 子进程:意外退出自动退避重启,主动 stop() 则不再拉起。 */
export class SidecarSupervisor {
  private child: SidecarChild | null = null
  private stopped = false
  private restartTimes: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private startedAt = 0
  private readonly cfg: SidecarSupervisorConfig
  private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void
  private readonly now: () => number

  constructor(
    private readonly spawnFn: () => SidecarChild,
    private readonly hooks: SidecarSupervisorHooks = {},
    config: Partial<SidecarSupervisorConfig> = {},
    deps: SidecarSupervisorDeps = {},
  ) {
    this.cfg = { ...DEFAULT_SIDECAR_SUPERVISOR, ...config }
    this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h))
    this.now = deps.now ?? (() => Date.now())
  }

  /** 首次拉起 sidecar(返回当前 child)。 */
  start(): SidecarChild {
    this.stopped = false
    return this.spawnOnce()
  }

  /** 当前 child(可能为 null:已 stop 或触顶放弃)。 */
  current(): SidecarChild | null {
    return this.child
  }

  /** 主动停止守护并杀掉当前 child;停止后 exit 不再触发重启(before-quit 用)。 */
  stop(sync = false, killDeps: KillSidecarDeps = {}): void {
    this.stopped = true
    if (this.restartTimer) {
      this.clearTimeoutFn(this.restartTimer)
      this.restartTimer = null
    }
    if (this.child) {
      killSidecar(this.child, sync, killDeps)
      this.child = null
    }
  }

  private spawnOnce(): SidecarChild {
    const child = this.spawnFn()
    this.child = child
    this.startedAt = this.now()
    this.hooks.onSpawn?.(child)
    ;(child as ExitListenerChild).on('exit', (code) => this.handleExit(code))
    return child
  }

  private handleExit(code: number | null): void {
    if (this.stopped) return // 主动关闭,不重启
    this.child = null

    // 稳定存活够久 → 视为健康,清空重启计数(避免"跑了几小时后偶发崩一次"被误判为雪崩)。
    if (this.now() - this.startedAt >= this.cfg.healthyResetMs) this.restartTimes = []

    // 滚动窗口裁剪:只统计最近 restartWindowMs 内的重启。
    const cutoff = this.now() - this.cfg.restartWindowMs
    this.restartTimes = this.restartTimes.filter((t) => t >= cutoff)

    if (this.restartTimes.length >= this.cfg.maxRestarts) {
      this.hooks.onExit?.(code, false)
      this.hooks.onGaveUp?.(this.restartTimes.length)
      return
    }

    const attempt = this.restartTimes.length // 0-based:本次是窗口内第 attempt 次
    this.restartTimes.push(this.now())
    const delay = Math.min(this.cfg.backoffBaseMs * 2 ** attempt, this.cfg.backoffMaxMs)
    this.hooks.onExit?.(code, true)
    this.hooks.onRestartScheduled?.(attempt + 1, delay)
    this.restartTimer = this.setTimeoutFn(() => {
      this.restartTimer = null
      if (!this.stopped) this.spawnOnce()
    }, delay)
  }
}
