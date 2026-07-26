import path from 'node:path'
import { existsSync } from 'node:fs'
import {
  createServerPlan,
  formatStartupDiagnostic,
  formatStartupError,
  killSidecar,
  stopSidecar,
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
  stripSidecarSecretEnv,
  waitForServer,
  windowsPowerShellOverride,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'
import { readDesktopTerminalConfig, resolveDesktopTerminalShell } from './terminal'
import { applyGatewayConfigToEnv, type ProductGatewayConfig } from './productConfig'

type ServerRuntimeOptions = {
  desktopRoot: string
  appRoot?: string
  resolveSystemProxy?: (url: string) => Promise<string>
  /** Product gateway config injected into the SERVER sidecar only (never adapters). */
  resolveGatewayConfig?: () => ProductGatewayConfig
  /** Main-process session manager returns only a current installation access bearer. */
  resolveInstallationAccessToken?: () => Promise<string>
  /** Electron-owned capability for paid/final media actions. Never inherited by Agent worker processes. */
  mediaUiCapability?: string
  /** Electron-owned capability for confirming recruiting side effects. */
  browserUiCapability?: string
  /** Electron-encrypted master key used only to encrypt MCP OAuth credentials at rest. */
  mcpOAuthCredentialKey?: string
}

export class ElectronServerRuntime {
  private readonly desktopRoot: string
  private readonly appRoot: string
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private readonly resolveGatewayConfig?: () => ProductGatewayConfig
  private readonly resolveInstallationAccessToken?: () => Promise<string>
  private readonly mediaUiCapability?: string
  private readonly browserUiCapability?: string
  private readonly mcpOAuthCredentialKey?: string
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
    this.resolveGatewayConfig = options.resolveGatewayConfig
    this.resolveInstallationAccessToken = options.resolveInstallationAccessToken
    this.mediaUiCapability = options.mediaUiCapability
    this.browserUiCapability = options.browserUiCapability
    this.mcpOAuthCredentialKey = options.mcpOAuthCredentialKey
  }

  /** Build a sidecar base env after removing inherited credential material. */
  private async buildServerEnv(baseEnv: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const cleanBase = stripSidecarSecretEnv(baseEnv)
    const withGateway = applyGatewayConfigToEnv(cleanBase, this.resolveGatewayConfig?.())
    const withMediaCapability = this.mediaUiCapability
      ? { ...withGateway, BB_MEDIA_UI_CAPABILITY: this.mediaUiCapability }
      : withGateway
    const withBrowserCapability = this.browserUiCapability
      ? { ...withMediaCapability, BB_BROWSER_UI_CAPABILITY: this.browserUiCapability }
      : withMediaCapability
    const withMcpCredentialKey = this.mcpOAuthCredentialKey
      ? { ...withBrowserCapability, BILLIARDBUDDY_MCP_OAUTH_KEY: this.mcpOAuthCredentialKey }
      : withBrowserCapability
    if (withMcpCredentialKey.BB_MEDIA_BIN_DIR) return withMcpCredentialKey

    const mediaBinDir = path.join(this.desktopRoot, 'runtime-assets', 'binaries')
    const executableSuffix = process.platform === 'win32' ? '.exe' : ''
    const hasMediaToolchain = ['ffmpeg', 'ffprobe'].every(name => (
      existsSync(path.join(mediaBinDir, `${name}${executableSuffix}`))
    ))
    return hasMediaToolchain
      ? { ...withMcpCredentialKey, BB_MEDIA_BIN_DIR: mediaBinDir }
      : withMcpCredentialKey
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

  private async startServerOnce(): Promise<string> {
    const generation = this.generation
    // Reuse the previous local port when available; otherwise let the OS choose
    // one, so renderer and preview URLs remain local to this desktop runtime.
    const port = await reserveServerPort(SERVER_BIND_HOST, preferredServerPorts())
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    const env = await this.buildServerEnv(await this.resolveSidecarBaseEnv())
    const accessToken = this.resolveInstallationAccessToken ? await this.resolveInstallationAccessToken() : undefined
    const plan = createServerPlan({
      desktopRoot: this.desktopRoot,
      appRoot: this.appRoot,
      port,
      env,
      accessToken,
    })

    let child: SidecarChild | null = null
    try {
      child = spawnSidecar(plan)
      this.captureLogs(child, 'billiardbuddy-server', logs)
      await waitForServer(SERVER_CONTROL_HOST, port, SERVER_STARTUP_TIMEOUT_MS)
      if (this.closing || generation !== this.generation) throw new Error('Desktop server runtime is closing')
      writeLastServerPort(port)
      this.server = { url, child }
      this.startupError = null
      return url
    } catch (error) {
      if (child && !this.server) await stopSidecar(child).catch(() => undefined)
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
