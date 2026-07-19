import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  createServerPlan,
  formatStartupDiagnostic,
  formatStartupError,
  killSidecar,
  mergeProxyEnv,
  POWERSHELL_PATH_OVERRIDE_ENV,
  preferredServerPorts,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  reserveServerPort,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  SERVER_STARTUP_TIMEOUT_MS,
  spawnSidecar,
  waitForServer,
  windowsPowerShellOverride,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'
import { readDesktopTerminalConfig, resolveDesktopTerminalShell } from './terminal'
import { applyGatewayConfigToEnv, type ProductGatewayConfig } from './productConfig'
import { applyInstallationIdToEnv } from './installationId'

type ServerRuntimeOptions = {
  desktopRoot: string
  appRoot?: string
  resolveSystemProxy?: (url: string) => Promise<string>
  /** Product gateway config injected into the SERVER sidecar only (never adapters). */
  resolveGatewayConfig?: () => ProductGatewayConfig
  /** Per-install id injected into the SERVER sidecar only (X-QF-Client-ID upstream). */
  resolveInstallationId?: () => string
  /** Electron-owned capability for paid/final media actions. Never inherited by Agent CLI processes. */
  mediaUiCapability?: string
}

export class ElectronServerRuntime {
  private readonly desktopRoot: string
  private readonly appRoot: string
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private readonly resolveGatewayConfig?: () => ProductGatewayConfig
  private readonly resolveInstallationId?: () => string
  private readonly mediaUiCapability?: string
  private sidecarEnvPromise: Promise<NodeJS.ProcessEnv> | null = null
  private server: { url: string, child: SidecarChild } | null = null
  private startupError: string | null = null
  private startPromise: Promise<string> | null = null

  constructor(options: ServerRuntimeOptions) {
    this.desktopRoot = options.desktopRoot
    this.appRoot = options.appRoot ?? options.desktopRoot
    this.resolveSystemProxy = options.resolveSystemProxy
    this.resolveGatewayConfig = options.resolveGatewayConfig
    this.resolveInstallationId = options.resolveInstallationId
    this.mediaUiCapability = options.mediaUiCapability
  }

  /**
   * The SERVER sidecar env is the base env plus the product gateway config AND the
   * per-install id. Both go ONLY here — adapter sidecars keep the plain base env, and
   * the CLI subprocess strips them again. A value already present (shell/ops override)
   * always wins over the injected default.
   */
  private buildServerEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const withGateway = applyGatewayConfigToEnv({
      ...baseEnv,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    }, this.resolveGatewayConfig?.())
    const withInstallation = applyInstallationIdToEnv(withGateway, this.resolveInstallationId?.())
    const withMediaCapability = this.mediaUiCapability
      ? { ...withInstallation, BB_MEDIA_UI_CAPABILITY: this.mediaUiCapability }
      : withInstallation
    if (withMediaCapability.BB_MEDIA_BIN_DIR) return withMediaCapability

    const mediaBinDir = path.join(this.desktopRoot, 'src-tauri', 'binaries')
    const executableSuffix = process.platform === 'win32' ? '.exe' : ''
    const hasMediaToolchain = ['ffmpeg', 'ffprobe'].every(name => (
      existsSync(path.join(mediaBinDir, `${name}${executableSuffix}`))
    ))
    return hasMediaToolchain
      ? { ...withMediaCapability, BB_MEDIA_BIN_DIR: mediaBinDir }
      : withMediaCapability
  }

  async startServer(): Promise<string> {
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

  stopAll(sync = false) {
    if (this.server) {
      killSidecar(this.server.child, sync)
      this.server = null
    }
  }

  private async startServerOnce(): Promise<string> {
    // Reuse the previous local port when available; otherwise let the OS choose
    // one, so renderer and preview URLs remain local to this desktop runtime.
    const port = await reserveServerPort(SERVER_BIND_HOST, preferredServerPorts())
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    const env = this.buildServerEnv(await this.resolveSidecarBaseEnv())
    const plan = createServerPlan({
      desktopRoot: this.desktopRoot,
      appRoot: this.appRoot,
      port,
      env,
    })

    try {
      const child = spawnSidecar(plan)
      this.captureLogs(child, 'claude-server', logs)
      await waitForServer(SERVER_CONTROL_HOST, port, SERVER_STARTUP_TIMEOUT_MS)
      writeLastServerPort(port)
      this.server = { url, child }
      this.startupError = null
      return url
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[desktop] local server startup failed', formatStartupDiagnostic(message, logs))
      this.startupError = formatStartupError(message, logs)
      throw new Error(this.startupError)
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
    if (!this.resolveSystemProxy) return this.applyPowerShellOverride(process.env)

    try {
      const rules = await this.resolveSystemProxy('https://auth.openai.com/')
      return this.applyPowerShellOverride(mergeProxyEnv(
        process.env,
        proxyUrlFromElectronProxyRules(rules),
      ))
    } catch (error) {
      console.error('[desktop] failed to resolve system proxy for sidecars', error)
      return this.applyPowerShellOverride(process.env)
    }
  }

  // On Windows, forward the user's chosen PowerShell to the agent sidecar so its
  // PowerShellTool honors the same shell as the UI terminal. Best-effort: never
  // block sidecar startup, and never override an explicitly set env var.
  private applyPowerShellOverride(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform !== 'win32' || env[POWERSHELL_PATH_OVERRIDE_ENV]) return env
    try {
      const shell = resolveDesktopTerminalShell('win32', readDesktopTerminalConfig(env))
      const override = windowsPowerShellOverride(shell, 'win32')
      if (override) return { ...env, [POWERSHELL_PATH_OVERRIDE_ENV]: override }
    } catch {
      // Misconfigured custom shell etc. — fall through to the unmodified env.
    }
    return env
  }
}
