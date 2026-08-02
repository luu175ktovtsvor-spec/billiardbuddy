import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const SERVER_BIND_HOST = '127.0.0.1'
export const SERVER_CONTROL_HOST = '127.0.0.1'
export const SERVER_STARTUP_TIMEOUT_MS = 30_000
export const SERVER_STARTUP_LOG_LIMIT = 80
export const STARTUP_ERROR_CODE = 'BB_STARTUP_FAILED'
// Reuse the same sticky port across Electron restarts.
export const SERVER_STATE_FILE = 'desktop-server-state.json'

export type SidecarChild = ChildProcessByStdio<null, Readable, Readable>

export type SidecarPlan = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export type SpawnSidecarDeps = {
  existsSyncFn?: typeof existsSync
  spawnFn?: typeof spawn
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
] as const
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const

export function resolveHostTriple(platform = process.platform, arch = process.arch): string {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  if (platform === 'win32') return 'x86_64-pc-windows-msvc'
  throw new Error(`Unsupported Electron sidecar platform: ${platform}/${arch}`)
}

export function resolveSidecarExecutable(desktopRoot: string, triple = resolveHostTriple()): string {
  const base = path.join(desktopRoot, 'runtime-assets', 'binaries', `billiardbuddy-sidecar-${triple}`)
  return process.platform === 'win32' ? `${base}.exe` : base
}

export function httpToWebSocketUrl(serverHttpUrl: string): string {
  if (serverHttpUrl.startsWith('http://')) return `ws://${serverHttpUrl.slice('http://'.length)}`
  if (serverHttpUrl.startsWith('https://')) return `wss://${serverHttpUrl.slice('https://'.length)}`
  return serverHttpUrl
}

export async function reserveLocalPort(bindHost = SERVER_BIND_HOST): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(error))
    server.listen(0, bindHost, () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Could not resolve reserved local port'))
          return
        }
        resolve(address.port)
      })
    })
  })
}

function canBindPort(bindHost: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, bindHost, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Try the ports used by previous runs before falling back to an OS-assigned
 * local port, so the desktop app starts predictably without exposing a public
 * listener.
 */
export async function reserveServerPort(
  bindHost: string,
  preferred: number[],
): Promise<number> {
  for (const port of preferred) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (await canBindPort(bindHost, port)) return port
    console.error(`[desktop] preferred server port ${port} unavailable`)
  }
  return await reserveLocalPort(bindHost)
}

export function billiardBuddyConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BILLIARDBUDDY_CONFIG_DIR || path.join(os.homedir(), '.BilliardBuddy')
}

export function readLastServerPort(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    const statePath = path.join(billiardBuddyConfigDir(env), SERVER_STATE_FILE)
    const state: unknown = JSON.parse(readFileSync(statePath, 'utf-8'))
    if (!state || typeof state !== 'object') return null
    const port = (state as Record<string, unknown>).lastPort
    if (typeof port !== 'number' || !Number.isInteger(port)) return null
    return port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

export function writeLastServerPort(port: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = billiardBuddyConfigDir(env)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, SERVER_STATE_FILE), `${JSON.stringify({ lastPort: port }, null, 2)}\n`, 'utf-8')
  } catch (error) {
    console.error('[desktop] failed to persist server state', error)
  }
}

/** Preferred port for the next local server start: the sticky last-used port. */
export function preferredServerPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const lastPort = readLastServerPort(env)
  return lastPort === null ? [] : [lastPort]
}

export async function waitForServer(host: string, port: number, timeoutMs = SERVER_STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `http://${host}:${port}/health`
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    try {
      await assertServerHealth(healthUrl, Math.min(500, Math.max(100, deadline - Date.now())))
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    await sleep(150)
  }

  const reason = lastError ? `: ${lastError.message}` : ''
  throw new Error(`desktop server did not report healthy at ${healthUrl} within ${Math.round(timeoutMs / 1000)} seconds${reason}`)
}

async function assertServerHealth(healthUrl: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(healthUrl, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`healthcheck returned ${response.status}`)

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`healthcheck returned non-JSON response from ${healthUrl}`)
    }

    const body = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'ok') {
      throw new Error(`healthcheck returned invalid response from ${healthUrl}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function pushStartupLog(logs: string[], line: string) {
  const trimmed = line.trimEnd()
  if (!trimmed) return
  if (logs.length >= SERVER_STARTUP_LOG_LIMIT) logs.shift()
  logs.push(trimmed)
}

export function formatStartupDiagnostic(message: string, logs: string[]): string {
  const logText = logs.length > 0
    ? logs.join('\n')
    : 'No server stdout/stderr was captured before the timeout.'
  return `${message}\n\nRecent server logs:\n${logText}`
}

/**
 * Startup stderr can include filesystem locations, gateway details, and other
 * implementation data. The renderer only receives this stable product code;
 * the detailed diagnostic stays in the Electron process log.
 */
export function formatStartupError(_message: string, _logs: string[]): string {
  return STARTUP_ERROR_CODE
}

export function proxyUrlFromElectronProxyRules(rules: string | undefined): string | undefined {
  if (!rules) return undefined

  for (const rawRule of rules.split(';')) {
    const rule = rawRule.trim()
    if (!rule || /^DIRECT$/i.test(rule)) continue

    const match = rule.match(/^(PROXY|HTTPS)\s+(.+)$/i)
    if (!match) continue

    const scheme = match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'
    const hostPort = match[2]!.trim()
    if (!hostPort) continue

    return `${scheme}://${hostPort}`
  }

  return undefined
}

export function mergeProxyEnv(
  baseEnv: NodeJS.ProcessEnv,
  proxyUrl: string | undefined,
): NodeJS.ProcessEnv {
  if (!proxyUrl) return baseEnv
  if (PROXY_ENV_KEYS.some(key => baseEnv[key])) {
    const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)
    return { ...baseEnv, NO_PROXY: noProxy, no_proxy: noProxy }
  }

  const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)

  return {
    ...baseEnv,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

function mergeLoopbackNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  const lowerEntries = new Set(entries.map(entry => entry.toLowerCase()))

  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!lowerEntries.has(entry.toLowerCase())) entries.push(entry)
  }

  return entries.join(',')
}

export const SIDE_CAR_SECRET_ENV_KEYS = [
  'BB_GATEWAY_BOOTSTRAP_CREDENTIAL',
  'BB_GATEWAY_ACCESS_TOKEN_CAPABILITY',
  'BB_LICENSE_KEY',
  'BB_GATEWAY_REFRESH_TOKEN',
  'BB_GATEWAY_SESSION',
  'BB_GATEWAY_SESSION_PROOF',
  'BB_GATEWAY_TOKEN',
  'BB_GATEWAY_URL',
  'BB_MEDIA_BIN_DIR',
  'BB_MEDIA_UI_CAPABILITY',
  'BB_CODEX_ENGINE_BIN_DIR',
  'BB_INSTALLATION_ID',
  'BILLIARDBUDDY_MCP_OAUTH_KEY',
] as const

// A desktop can be launched from a developer shell, IDE or CI wrapper that
// already contains a provider credential. The local media sidecar must never
// inherit one of those by accident: personal model keys belong exclusively to
// Electron Main and its short-lived native App Server child.
const SIDE_CAR_SECRET_ENV_NAME = /(?:^|_)(?:KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|CREDENTIALS?|COOKIE|SESSION)(?:_|$)/i

/** Start from a clean credential boundary before injecting a single access bearer. */
export function stripSidecarSecretEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  for (const key of SIDE_CAR_SECRET_ENV_KEYS) delete env[key]
  for (const key of Object.keys(env)) {
    if (SIDE_CAR_SECRET_ENV_NAME.test(key)) delete env[key]
  }
  return env
}

/**
 * Only Electron Main may provide trusted values here after stripping the
 * inherited process environment. Callers must never pass renderer-controlled
 * data as `trustedEnv`.
 */
export function buildSidecarEnv(
  baseEnv: NodeJS.ProcessEnv,
  trustedEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env = stripSidecarSecretEnv(baseEnv)
  const configDir = baseEnv.BILLIARDBUDDY_CONFIG_DIR
  if (configDir) {
    const cacheDir = path.join(configDir, 'Cache')
    mkdirSync(cacheDir, { recursive: true })
    env.BILLIARDBUDDY_CONFIG_DIR = configDir
    env.XDG_CACHE_HOME = cacheDir
  }
  return { ...env, ...trustedEnv }
}

export function createServerPlan({
  desktopRoot,
  appRoot,
  port,
  bindHost = SERVER_BIND_HOST,
  env = process.env,
  trustedEnv,
  accessToken,
}: {
  desktopRoot: string
  appRoot: string
  port: number
  bindHost?: string
  env?: NodeJS.ProcessEnv
  /** Electron Main-injected Gateway config and local capabilities. */
  trustedEnv?: NodeJS.ProcessEnv
  /** Current short-lived access bearer, injected after all inherited secrets are stripped. */
  accessToken?: string
}): SidecarPlan {
  const cleanEnv = buildSidecarEnv(env, trustedEnv)
  if (accessToken) cleanEnv.BB_GATEWAY_TOKEN = accessToken
  return {
    command: resolveSidecarExecutable(desktopRoot),
    args: ['server', '--app-root', appRoot, '--host', bindHost, '--port', String(port)],
    env: cleanEnv,
  }
}

export function spawnSidecar(plan: SidecarPlan, deps: SpawnSidecarDeps = {}): SidecarChild {
  const exists = deps.existsSyncFn ?? existsSync
  if (!exists(plan.command)) {
    throw new Error(`Electron sidecar binary not found: ${plan.command}. Run "cd desktop && bun run build:sidecars" first.`)
  }
  return (deps.spawnFn ?? spawn)(plan.command, plan.args, {
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

function waitForSidecarExit(child: SidecarChild): Promise<void> {
  const bunChild = child as SidecarChild & { exited?: Promise<unknown> }
  if (bunChild.exited) return bunChild.exited.then(() => undefined)
  if (typeof child.exitCode === 'number') return Promise.resolve()
  return new Promise(resolve => child.once('exit', () => resolve()))
}

/** Stop a sidecar and wait for the child (or Windows process tree) to exit. */
export async function stopSidecar(child: SidecarChild, deps: KillSidecarDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' && child.pid) {
    const taskkill = (deps.spawnAsync ?? spawn)('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
    await new Promise<void>((resolve, reject) => { taskkill.once('error', reject); taskkill.once('close', () => resolve()) })
  } else child.kill()
  await waitForSidecarExit(child)
}

/**
 * Terminate a sidecar process. On Windows we shell out to `taskkill /T` to also
 * reap the child process tree (the Bun sidecar spawns workers). Pass `sync=true`
 * during app shutdown so the kill completes before the process exits — otherwise
 * the async `taskkill` is fire-and-forget and can leave orphaned processes.
 */
export function killSidecar(child: SidecarChild, sync = false, deps: KillSidecarDeps = {}) {
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
