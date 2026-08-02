import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  createServerPlan,
  formatStartupDiagnostic,
  formatStartupError,
  killSidecar,
  stopSidecar,
  mergeProxyEnv,
  preferredServerPorts,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  reserveServerPort,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  SERVER_STARTUP_TIMEOUT_MS,
  spawnSidecar,
  stripSidecarSecretEnv,
  waitForServer,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'
import { applyGatewayConfigToEnv, type ProductGatewayConfig } from './productConfig'
import {
  GATEWAY_ACCESS_TOKEN_CAPABILITY_HEADER,
  GATEWAY_ACCESS_TOKEN_UPDATE_PATH,
} from '../../../shared/product/providerGateway'
import {
} from '../../../shared/product/personalModels'

type ServerRuntimeOptions = {
  desktopRoot: string
  appRoot?: string
  resolveSystemProxy?: (url: string) => Promise<string>
  systemProxyTimeoutMs?: number
  /** Product gateway config injected into the SERVER sidecar only (never adapters). */
  resolveGatewayConfig?: () => ProductGatewayConfig
  /** Main-process session manager returns only a current installation access bearer. */
  resolveInstallationAccessToken?: () => Promise<string>
  /** Read an already-valid bearer without waiting for Gateway network I/O. */
  resolveCachedInstallationAccessToken?: () => string | undefined
  /** Electron-owned capability for paid/final media actions. Never inherited by non-media processes. */
  mediaUiCapability?: string
  /** Main-only capability for rotating the local Server's short-lived bearer. */
  gatewayAccessTokenCapability?: string
}

export class ElectronServerRuntime {
  private readonly desktopRoot: string
  private readonly appRoot: string
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private readonly systemProxyTimeoutMs: number
  private readonly resolveGatewayConfig?: () => ProductGatewayConfig
  private readonly resolveInstallationAccessToken?: () => Promise<string>
  private readonly resolveCachedInstallationAccessToken?: () => string | undefined
  private installationAccessToken: string | undefined
  private readonly mediaUiCapability?: string
  private readonly gatewayAccessTokenCapability?: string
  private sidecarEnvPromise: Promise<NodeJS.ProcessEnv> | null = null
  private server: { url: string, child: SidecarChild } | null = null
  private startupError: string | null = null
  private startPromise: Promise<string> | null = null
  private restartPromise: Promise<void> | null = null
  private closing = false
  private generation = 0

  constructor(options: ServerRuntimeOptions) {
    this.desktopRoot = options.desktopRoot
    this.appRoot = options.appRoot ?? options.desktopRoot
    this.resolveSystemProxy = options.resolveSystemProxy
    this.systemProxyTimeoutMs = options.systemProxyTimeoutMs ?? 5_000
    this.resolveGatewayConfig = options.resolveGatewayConfig
    this.resolveInstallationAccessToken = options.resolveInstallationAccessToken
    this.resolveCachedInstallationAccessToken = options.resolveCachedInstallationAccessToken
    this.mediaUiCapability = options.mediaUiCapability
    this.gatewayAccessTokenCapability = options.gatewayAccessTokenCapability
  }

  /** Build a sidecar base env after removing inherited credential material. */
  private async buildServerEnv(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const cleanBase = stripSidecarSecretEnv(baseEnv)
    const withGateway = applyGatewayConfigToEnv(cleanBase, this.resolveGatewayConfig?.())
    const withMediaCapability = this.mediaUiCapability
      ? { ...withGateway, BB_MEDIA_UI_CAPABILITY: this.mediaUiCapability }
      : withGateway
    const withGatewayCapability = this.gatewayAccessTokenCapability
      ? { ...withMediaCapability, BB_GATEWAY_ACCESS_TOKEN_CAPABILITY: this.gatewayAccessTokenCapability }
      : withMediaCapability

    // The App Server command is product-controlled. Never honor an inherited
    // path here: it would let a renderer launch a user-selected binary once the
    // Agent execution kernel starts consuming this capability.
    const withoutInheritedEngineDir = { ...withGatewayCapability }
    delete withoutInheritedEngineDir.BB_CODEX_ENGINE_BIN_DIR

    const runtimeBinDir = path.join(this.desktopRoot, 'runtime-assets', 'binaries')
    const engineTriple = resolveEngineTargetTriple()
    const engineBinary = process.platform === 'win32'
      ? `codex-app-server-${engineTriple}.exe`
      : `codex-app-server-${engineTriple}`
    const withEngineCapability = existsSync(path.join(runtimeBinDir, engineBinary))
      ? { ...withoutInheritedEngineDir, BB_CODEX_ENGINE_BIN_DIR: runtimeBinDir }
      : withoutInheritedEngineDir

    if (withEngineCapability.BB_MEDIA_BIN_DIR) return withEngineCapability

    const mediaBinDir = runtimeBinDir
    const executableSuffix = process.platform === 'win32' ? '.exe' : ''
    const hasMediaToolchain = ['ffmpeg', 'ffprobe'].every(name => (
      existsSync(path.join(mediaBinDir, `${name}${executableSuffix}`))
    ))
    return hasMediaToolchain
      ? { ...withEngineCapability, BB_MEDIA_BIN_DIR: mediaBinDir }
      : withEngineCapability
  }

  async startServer(): Promise<string> {
    if (this.closing) throw new Error('Desktop server runtime is closing')
    if (this.server) return this.server.url
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startServerOnce()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async getServerUrl(): Promise<string> {
    if (this.server) return this.server.url
    if (this.startupError) throw new Error(this.startupError)
    return await this.startServer()
  }

  async stopServer(sync = false): Promise<void> {
    this.generation += 1
    const server = this.server
    this.server = null
    if (!server) return
    if (sync) killSidecar(server.child, true)
    else await stopSidecar(server.child)
  }

  /** Permanently stop this runtime; token timers must not revive a closing app. */
  async stopAll(sync = false): Promise<void> {
    this.closing = true
    await this.stopServer(sync)
  }

  /** Replace the running child after a rotated access bearer, never overlap children. */
  async reconfigureServer(): Promise<void> {
    if (this.closing || !this.server) return
    if (this.restartPromise) return await this.restartPromise
    this.restartPromise = (async () => {
      if (this.closing || !this.server) return
      await this.stopServer()
      if (!this.closing) await this.startServer()
    })()
    try {
      await this.restartPromise
    } finally {
      this.restartPromise = null
    }
  }

  /** Main is the sole writer of the local Server's installation access bearer. */
  async setInstallationAccessToken(accessToken: string): Promise<void> {
    if (!accessToken.trim()) return
    this.installationAccessToken = accessToken
    if (!this.server) return
    try {
      const capability = this.gatewayAccessTokenCapability
      if (!capability || capability.length < 32) throw new Error('Gateway access token capability is unavailable')
      const response = await fetch(`${this.server.url}${GATEWAY_ACCESS_TOKEN_UPDATE_PATH}`, {
        method: 'PUT',
        headers: { [GATEWAY_ACCESS_TOKEN_CAPABILITY_HEADER]: capability, 'content-type': 'text/plain; charset=utf-8' },
        body: accessToken,
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status !== 204) throw new Error('Gateway access token update failed')
    } catch {
      await this.reconfigureServer()
    }
  }

  private async startServerOnce(): Promise<string> {
    const generation = this.generation
    // Reuse the previous local port when available; otherwise let the OS choose
    // one, so renderer and preview URLs remain local to this desktop runtime.
    const port = await reserveServerPort(SERVER_BIND_HOST, preferredServerPorts())
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    const env = await this.buildServerEnv(await this.resolveSidecarBaseEnv())
    const accessToken = this.installationAccessToken ?? this.resolveCachedInstallationAccessToken?.()
    const plan = createServerPlan({
      desktopRoot: this.desktopRoot,
      appRoot: this.appRoot,
      port,
      env,
      accessToken,
    })

    if (!accessToken && this.resolveInstallationAccessToken) {
      void this.resolveInstallationAccessToken().then(token => this.setInstallationAccessToken(token)).catch(error => {
        console.error('[desktop] failed to refresh installation session', error)
      })
    }

    let child: SidecarChild | null = null
    try {
      child = spawnSidecar(plan)
      this.captureLogs(child, 'billiardbuddy-server', logs)
      await waitForServer(SERVER_CONTROL_HOST, port, SERVER_STARTUP_TIMEOUT_MS)
      if (this.closing || generation !== this.generation) throw new Error('Desktop server runtime is closing')
      writeLastServerPort(port)
      this.server = { url, child }
      this.startupError = null
      if (this.installationAccessToken && this.installationAccessToken !== accessToken) {
        await this.setInstallationAccessToken(this.installationAccessToken)
      }
      return url
    } catch (error) {
      if (child && !this.server) await stopSidecar(child).catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      const diagnostic = formatStartupDiagnostic(message, logs)
      console.error('[desktop] local server startup failed', diagnostic)
      this.startupError = formatStartupError(message, logs)
      const startupError = Object.assign(new Error(this.startupError), {
        code: this.startupError,
      })
      Object.defineProperty(startupError, 'smokeDiagnostic', {
        configurable: false,
        enumerable: false,
        value: diagnostic,
        writable: false,
      })
      throw startupError
    }
  }

  private captureLogs(child: SidecarChild, label: string, startupLogs?: string[]) {
    child.stdout.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.log(`[${label}] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stdout] ${line}`)
    })
    child.stderr.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.error(`[${label}] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stderr] ${line}`)
    })
    child.on('exit', (code, signal) => {
      const line = `sidecar exited (code=${code}, signal=${signal})`
      console.log(`[${label}] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[exit] ${line}`)
    })
  }

  private async resolveSidecarBaseEnv(): Promise<NodeJS.ProcessEnv> {
    this.sidecarEnvPromise ??= this.resolveSidecarBaseEnvOnce()
    return await this.sidecarEnvPromise
  }

  private async resolveSidecarBaseEnvOnce(): Promise<NodeJS.ProcessEnv> {
    if (!this.resolveSystemProxy) return process.env

    try {
      const proxyTarget = this.resolveGatewayConfig?.().url
      if (!proxyTarget) return process.env
      const rules = await promiseWithTimeout(
        this.resolveSystemProxy(proxyTarget),
        this.systemProxyTimeoutMs,
        'Desktop system proxy resolution timed out',
      )
      return mergeProxyEnv(
        process.env,
        proxyUrlFromElectronProxyRules(rules),
      )
    } catch (error) {
      console.error('[desktop] failed to resolve system proxy for sidecars', error)
      return process.env
    }
  }
}

function resolveEngineTargetTriple(
  platform = process.platform,
  arch = process.arch,
): 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc' {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  return 'x86_64-pc-windows-msvc'
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('systemProxyTimeoutMs must be a positive safe integer')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
