import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  startCodexNativeProvider,
  type CodexNativeModelRoute,
  type StartedCodexNativeProvider,
} from './codexNativeProvider'

type JsonPrimitive = string | number | boolean | null
export type CodexNativeJsonValue = JsonPrimitive | CodexNativeJsonObject | CodexNativeJsonValue[]
export type CodexNativeJsonObject = { [key: string]: CodexNativeJsonValue | undefined }

type PendingRequest = {
  resolve(value: CodexNativeJsonValue): void
  reject(error: Error): void
}

export type CodexNativeNotification = {
  method: string
  params?: CodexNativeJsonValue
}

export type CodexNativeServerRequest = CodexNativeNotification & {
  id: string | number
}

export type CodexNativeAppServerClientOptions = {
  /** Resolved BilliardBuddy-owned binary; never a renderer-provided command. */
  command: readonly string[]
  /** BilliardBuddy's private Codex home. This is the sole Agent Thread Store. */
  engineHome: string
  /** Do not let process start-up implicitly enter an untrusted workspace. */
  cwd?: string
  configOverrides: readonly string[]
  environment: Readonly<Record<string, string>>
  onNotification?(notification: CodexNativeNotification): void | Promise<void>
  onServerRequest?(request: CodexNativeServerRequest): Promise<CodexNativeJsonValue | undefined>
}

/**
 * BilliardBuddy names the three source-native Codex permission experiences.
 * These are inputs to Rust, never a second permission engine in Electron.
 */
export type NativeCodexPermissionMode = 'ask' | 'approve-for-me' | 'full-access'

export type NativeCodexThread = {
  id: string
  /** Projected from the authoritative App Server Thread settings response. */
  permissionMode: NativeCodexPermissionMode
}

export type NativeCodexTurn = {
  id: string
}

/**
 * The value is passed unchanged to Codex's `mcp_servers.<name>` schema. Rust
 * validates the transport and owns the persisted configuration; Electron only
 * fixes the writable key-space and the caller's Thread ownership.
 */
export type NativeCodexMcpServerConfig = CodexNativeJsonObject

/** Exactly one source-native skill selector: its display name or SKILL.md path. */
export type NativeCodexSkillSelector = {
  name?: string
  path?: string
}

export type NativeCodexStartThreadInput = {
  cwd: string
  route: CodexNativeModelRoute
  permissionMode: NativeCodexPermissionMode
}

export type NativeCodexResumeThreadInput = {
  threadId: string
  cwd: string
  route: CodexNativeModelRoute
}

export type NativeCodexTurnInput =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }

export type ElectronCodexNativeRuntimeOptions = {
  /** The unpacked desktop root, where verified staged binaries are stored. */
  desktopRoot: string
  /** Electron app userData; never the user's standalone Codex home. */
  userDataPath: string
  onNotification?(notification: CodexNativeNotification): void | Promise<void>
  /**
   * App Server issues approvals as server requests. The UI bridge supplies the
   * exact source-approved decision; no BilliardBuddy code invents one.
   */
  onServerRequest?(request: CodexNativeServerRequest): Promise<CodexNativeJsonValue | undefined>
}

const MAX_JSON_RPC_FRAME_BYTES = 128 * 1024 * 1024
const APP_SERVER_SHUTDOWN_WAIT_MS = 1_000
const NATIVE_PROVIDER_ID = 'billiardbuddy'
const NATIVE_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/

function engineError(message: string, detail?: string): Error {
  return new Error(detail ? `${message}: ${detail}` : message)
}

function jsonObject(value: unknown): CodexNativeJsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CodexNativeJsonObject : undefined
}

function jsonRpcError(value: unknown): { code: number; message: string } | undefined {
  const error = jsonObject(value)
  return error && typeof error.code === 'number' && typeof error.message === 'string'
    ? { code: error.code, message: error.message }
    : undefined
}

function nonEmptyText(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function absoluteDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('CODEX_NATIVE_PATH_INVALID')
  return path.resolve(value)
}

function routeKey(route: CodexNativeModelRoute): string {
  if (route.kind === 'managed') return `managed\0${route.gatewayUrl}\0${route.model}`
  // A profile can keep its id, endpoint and model while the user rotates its
  // secret or changes a Chat-adapter option. Keep only a non-reversible route
  // fingerprint in process memory, never the raw key, so the next idle use
  // cannot reuse a child started with stale provider capability.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(route.profile))
    .digest('base64url')
  return `personal\0${fingerprint}`
}

function supportedEngineTarget(
  platform = process.platform,
  arch = process.arch,
): 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc' {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  throw new Error(`CODEX_NATIVE_PLATFORM_UNSUPPORTED:${platform}/${arch}`)
}

async function privateDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_NATIVE_HOME_INVALID')
  return await fs.realpath(resolved)
}

async function nativeAppServerCommand(desktopRoot: string): Promise<string[]> {
  const target = supportedEngineTarget()
  const extension = process.platform === 'win32' ? '.exe' : ''
  const binaryDirectory = path.join(absoluteDirectory(desktopRoot), 'runtime-assets', 'binaries')
  const directory = await fs.realpath(binaryDirectory)
  const binary = path.join(directory, `codex-app-server-${target}${extension}`)
  const stat = await fs.lstat(binary)
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) {
    throw new Error('CODEX_NATIVE_BINARY_UNAVAILABLE')
  }
  const resolved = await fs.realpath(binary)
  if (path.dirname(resolved) !== directory) throw new Error('CODEX_NATIVE_BINARY_UNAVAILABLE')
  return [resolved]
}

function childEnvironment(input: Readonly<Record<string, string>>): Record<string, string> {
  const inheritedKeys = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
  const environment: Record<string, string> = {}
  for (const key of inheritedKeys) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  for (const [key, value] of Object.entries(input)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value) environment[key] = value
  }
  return environment
}

function threadId(value: CodexNativeJsonObject): string {
  const thread = jsonObject(value.thread)
  if (!nonEmptyText(thread?.id)) throw new Error('CODEX_NATIVE_THREAD_RESPONSE_INVALID')
  return thread.id
}

function turnId(value: CodexNativeJsonObject): string {
  const turn = jsonObject(value.turn)
  if (!nonEmptyText(turn?.id)) throw new Error('CODEX_NATIVE_TURN_RESPONSE_INVALID')
  return turn.id
}

function permissionModeFromThreadResponse(value: CodexNativeJsonObject): NativeCodexPermissionMode {
  // The App Server serializes the effective legacy policy alongside the
  // canonical permission profile. Use the effective policy because that is
  // what the Rust Core will actually enforce for the next turn.
  const sandboxType = jsonObject(value.sandbox)?.type
  if (sandboxType === 'dangerFullAccess' && value.approvalPolicy === 'never') return 'full-access'
  if (
    sandboxType === 'workspaceWrite'
    && value.approvalPolicy === 'on-request'
    && value.approvalsReviewer === 'auto_review'
  ) return 'approve-for-me'
  return 'ask'
}

function nativePermissionSettings(mode: NativeCodexPermissionMode): {
  sandbox: 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'on-request' | 'never'
  approvalsReviewer: 'user' | 'auto_review'
} {
  switch (mode) {
    case 'ask':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }
    case 'approve-for-me':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    case 'full-access':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user' }
  }
}

/** `thread/settings/update` uses the v2 tagged SandboxPolicy, not SandboxMode. */
function nativeSandboxPolicy(mode: NativeCodexPermissionMode): CodexNativeJsonObject {
  return mode === 'full-access'
    ? { type: 'dangerFullAccess' }
    : { type: 'workspaceWrite' }
}

function validateTurnInput(value: NativeCodexTurnInput): boolean {
  if (value.type === 'text') return nonEmptyText(value.text, 1 << 20)
  return nonEmptyText(value.url, 32 * 1024 * 1024)
    && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.url)
}

function nativeMcpServerName(value: string): string {
  if (!NATIVE_MCP_SERVER_NAME.test(value)) throw new Error('CODEX_NATIVE_MCP_SERVER_NAME_INVALID')
  return value
}

function nativeJsonValue(value: unknown, depth = 0): value is CodexNativeJsonValue {
  if (depth > 16 || value === null || typeof value === 'string' || typeof value === 'boolean') return depth <= 16
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => nativeJsonValue(item, depth + 1))
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const entries = Object.entries(record)
  return entries.length <= 256
    && entries.every(([key, item]) => (
      key.length > 0
      && key.length <= 256
      && key !== '__proto__'
      && key !== 'constructor'
      && key !== 'prototype'
      && nativeJsonValue(item, depth + 1)
    ))
}

function nativeMcpConfig(value: unknown): NativeCodexMcpServerConfig {
  const config = jsonObject(value)
  if (!config || !nativeJsonValue(config) || Buffer.byteLength(JSON.stringify(config)) > 512 * 1024) {
    throw new Error('CODEX_NATIVE_MCP_CONFIGURATION_INVALID')
  }
  return config
}

function nativeSkillSelector(value: NativeCodexSkillSelector): NativeCodexSkillSelector {
  const name = value.name
  const skillPath = value.path
  if (
    (typeof name === 'string' && nonEmptyText(name.trim(), 512) && skillPath === undefined)
    || (typeof skillPath === 'string' && nonEmptyText(skillPath, 4_096) && path.isAbsolute(skillPath) && !/[\u0000\r\n]/.test(skillPath) && name === undefined)
  ) {
    return name === undefined ? { path: skillPath } : { name: name.trim() }
  }
  throw new Error('CODEX_NATIVE_SKILL_SELECTOR_INVALID')
}

/**
 * Electron-Main JSON-RPC client for the official Codex App Server.
 *
 * It speaks the source's JSONL stdio transport directly. There is no Bun
 * Product Server, local HTTP bridge, ProductTask state, or legacy permission
 * envelope on this path.
 */
export class CodexNativeAppServerClient {
  private process?: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 0
  private closed = false

  constructor(private readonly options: CodexNativeAppServerClientOptions) {}

  async start(): Promise<void> {
    if (this.process || this.closed) throw new Error('CODEX_NATIVE_APP_SERVER_ALREADY_STARTED')
    if (this.options.command.length === 0 || this.options.command.some(value => !nonEmptyText(value, 4_096))) {
      throw new Error('CODEX_NATIVE_APP_SERVER_COMMAND_INVALID')
    }
    const engineHome = await privateDirectory(this.options.engineHome)
    const environment = childEnvironment({ ...this.options.environment, CODEX_HOME: engineHome })
    const command = this.options.command[0]!
    const args = [
      ...this.options.command.slice(1),
      ...this.options.configOverrides.flatMap(value => ['--config', value]),
      '--listen',
      'stdio://',
    ]
    const child = spawn(command, args, {
      cwd: this.options.cwd ? absoluteDirectory(this.options.cwd) : engineHome,
      env: environment,
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    })
    this.process = child
    void this.readStdout(child)
    void this.drainStderr(child).catch(() => undefined)
    child.once('error', error => this.failAllPending(engineError('CODEX_NATIVE_APP_SERVER_SPAWN_FAILED', error.message)))
    child.once('exit', (code, signal) => {
      this.failAllPending(engineError('CODEX_NATIVE_APP_SERVER_EXITED', `code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
    try {
      const initialized = await this.request<CodexNativeJsonObject>('initialize', {
        clientInfo: { name: 'billiardbuddy', title: 'BilliardBuddy', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      if (initialized.codexHome !== engineHome) throw new Error('CODEX_NATIVE_APP_SERVER_HOME_MISMATCH')
      this.notify('initialized', {})
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async request<T extends CodexNativeJsonValue = CodexNativeJsonValue>(method: string, params?: CodexNativeJsonValue): Promise<T> {
    if (!nonEmptyText(method)) throw new Error('CODEX_NATIVE_APP_SERVER_METHOD_INVALID')
    if (!this.process || this.closed) throw new Error('CODEX_NATIVE_APP_SERVER_UNAVAILABLE')
    const id = ++this.nextRequestId
    const result = new Promise<CodexNativeJsonValue>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return await result as T
  }

  notify(method: string, params?: CodexNativeJsonValue): void {
    if (!nonEmptyText(method)) throw new Error('CODEX_NATIVE_APP_SERVER_METHOD_INVALID')
    if (!this.process || this.closed) throw new Error('CODEX_NATIVE_APP_SERVER_UNAVAILABLE')
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.process
    this.process = undefined
    this.failAllPending(engineError('CODEX_NATIVE_APP_SERVER_CLOSED'))
    if (!child) return
    try { child.stdin.end() } catch {}
    const exited = await Promise.race([
      new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), APP_SERVER_SHUTDOWN_WAIT_MS)),
    ])
    if (!exited) {
      try { child.kill() } catch {}
    }
  }

  /**
   * Electron's `before-quit` hook cannot await JSON-RPC. Kill only the
   * BilliardBuddy-owned child synchronously so closing the desktop app never
   * leaves an App Server process running against its private CODEX_HOME.
   */
  closeImmediately(): void {
    if (this.closed) return
    this.closed = true
    const child = this.process
    this.process = undefined
    this.failAllPending(engineError('CODEX_NATIVE_APP_SERVER_CLOSED'))
    if (!child) return
    try { child.stdin.destroy() } catch {}
    try { child.kill() } catch {}
  }

  private write(frame: CodexNativeJsonObject): void {
    const stdin = this.process?.stdin
    if (!stdin || stdin.destroyed) throw new Error('CODEX_NATIVE_APP_SERVER_STDIN_UNAVAILABLE')
    const serialized = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(serialized) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_NATIVE_APP_SERVER_FRAME_TOO_LARGE')
    stdin.write(serialized)
  }

  private async readStdout(child: ChildProcessWithoutNullStreams): Promise<void> {
    let buffer = ''
    child.stdout.setEncoding('utf8')
    try {
      for await (const chunk of child.stdout) {
        buffer += String(chunk)
        if (Buffer.byteLength(buffer) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_NATIVE_APP_SERVER_FRAME_TOO_LARGE')
        let boundary: number
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).trim()
          buffer = buffer.slice(boundary + 1)
          if (!line) continue
          if (Buffer.byteLength(line) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_NATIVE_APP_SERVER_FRAME_TOO_LARGE')
          let message: unknown
          try { message = JSON.parse(line) } catch { throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID') }
          await this.handleMessage(message)
        }
      }
      if (buffer.trim()) throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID')
    } catch (error) {
      this.failAllPending(error instanceof Error ? error : engineError('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID'))
      try { child.kill() } catch {}
    }
  }

  private async drainStderr(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.stderr.setEncoding('utf8')
    // Rust diagnostics can contain user-path or provider messages. Drain them
    // so the child cannot block, but do not retain or forward them as Agent
    // state or a renderer-visible error channel.
    for await (const _chunk of child.stderr) {}
  }

  private async handleMessage(value: unknown): Promise<void> {
    const message = jsonObject(value)
    if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) {
      throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID')
    }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      const error = message.error === undefined ? undefined : jsonRpcError(message.error)
      if (message.error !== undefined && !error) return pending.reject(engineError('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID'))
      if (error) return pending.reject(engineError('CODEX_NATIVE_APP_SERVER_REQUEST_FAILED', `${error.code} ${error.message}`))
      return pending.resolve(message.result ?? null)
    }
    if (!nonEmptyText(message.method)) throw new Error('CODEX_NATIVE_APP_SERVER_PROTOCOL_INVALID')
    const notification: CodexNativeNotification = {
      method: message.method,
      ...(message.params === undefined ? {} : { params: message.params }),
    }
    if (typeof message.id !== 'number' && typeof message.id !== 'string') {
      await this.options.onNotification?.(notification)
      return
    }
    try {
      if (!this.options.onServerRequest) throw new Error('CODEX_NATIVE_APP_SERVER_REQUEST_UNHANDLED')
      const result = await this.options.onServerRequest({ ...notification, id: message.id })
      this.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} })
    } catch (error) {
      const description = error instanceof Error ? error.message : 'CODEX_NATIVE_APP_SERVER_REQUEST_FAILED'
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: description } })
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/**
 * Direct Thread/Turn owner for BilliardBuddy Agent.
 *
 * The upstream Rust Core persists Threads, Items, compactions, approvals,
 * forks and recovery below this object's private `CODEX_HOME`. This manager
 * holds only process handles and a non-secret route identity while alive.
 */
export class ElectronCodexNativeRuntime {
  private client?: CodexNativeAppServerClient
  private provider?: StartedCodexNativeProvider
  private configuredRouteKey?: string
  private activeTurns = new Set<string>()
  private pendingTurnStarts = 0
  /**
   * Ephemeral Main-process reconnect hints only. Rust remains the durable
   * Thread owner; these paths are never persisted or used as Agent history.
   */
  private readonly threadWorkspaces = new Map<string, string>()
  private readonly loadedThreads = new Set<string>()
  /** Clients/providers launched before they become current must also be revocable. */
  private readonly startingClients = new Set<CodexNativeAppServerClient>()
  private readonly startingProviders = new Set<StartedCodexNativeProvider>()
  private routeGeneration = 0
  private closePromise?: Promise<void>

  constructor(private readonly options: ElectronCodexNativeRuntimeOptions) {}

  async startThread(input: NativeCodexStartThreadInput): Promise<NativeCodexThread> {
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    const permissions = nativePermissionSettings(input.permissionMode)
    const response = await client.request<CodexNativeJsonObject>('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      model: this.provider!.model,
      modelProvider: NATIVE_PROVIDER_ID,
      ...permissions,
    })
    const id = threadId(response)
    this.threadWorkspaces.set(id, cwd)
    this.loadedThreads.add(id)
    return { id, permissionMode: permissionModeFromThreadResponse(response) }
  }

  async resumeThread(input: NativeCodexResumeThreadInput): Promise<NativeCodexThread> {
    if (!nonEmptyText(input.threadId)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    this.threadWorkspaces.set(input.threadId, cwd)
    this.loadedThreads.delete(input.threadId)
    return await this.resumeStoredThread(input.threadId, input.route)
  }

  /**
   * Re-open an already owned Rust Thread after a local provider process was
   * deliberately revoked. The workspace is an in-memory reconnect hint, not
   * a replacement Thread record; the source Thread Store validates and owns
   * the returned session.
   */
  async ensureThread(thread: Pick<NativeCodexThread, 'id'>, route: CodexNativeModelRoute): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = this.threadWorkspaces.get(thread.id)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    await this.ensureClient(route, cwd)
    if (this.loadedThreads.has(thread.id)) return
    await this.resumeStoredThread(thread.id, route)
  }

  /** Read durable history from the Rust Thread Store; Electron never caches it as authority. */
  async readThread(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('thread/read', {
      threadId: thread.id,
      includeTurns: true,
    })
  }

  async forkThread(input: NativeCodexResumeThreadInput & { lastTurnId?: string, permissionMode: NativeCodexPermissionMode }): Promise<NativeCodexThread> {
    if (!nonEmptyText(input.threadId)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const cwd = await this.workspace(input.cwd)
    const client = await this.ensureClient(input.route, cwd)
    const permissions = nativePermissionSettings(input.permissionMode)
    const response = await client.request<CodexNativeJsonObject>('thread/fork', {
      threadId: input.threadId,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      // Apply the selected source-native permissions explicitly, so a fork
      // never inherits an old privilege level after the user changed it.
      model: this.provider!.model,
      modelProvider: NATIVE_PROVIDER_ID,
      ...permissions,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
    })
    const id = threadId(response)
    this.threadWorkspaces.set(id, cwd)
    this.loadedThreads.add(id)
    return { id, permissionMode: permissionModeFromThreadResponse(response) }
  }

  /**
   * Changes the active Rust Thread settings for subsequent turns. The Thread
   * Store records the applied settings and emits `thread/settings/updated`;
   * no Electron or renderer permission record is written.
   */
  async updatePermissionMode(thread: Pick<NativeCodexThread, 'id'>, mode: NativeCodexPermissionMode): Promise<NativeCodexPermissionMode> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const settings = nativePermissionSettings(mode)
    await this.requireClient().request('thread/settings/update', {
      threadId: thread.id,
      sandboxPolicy: nativeSandboxPolicy(mode),
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
    })
    return mode
  }

  /**
   * Writes only one source-native MCP server configuration under this private
   * Codex Home, then asks the App Server to apply it to loaded Threads.
   */
  async configureMcpServer(
    thread: Pick<NativeCodexThread, 'id'>,
    name: string,
    config: NativeCodexMcpServerConfig,
  ): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const serverName = nativeMcpServerName(name)
    const value = nativeMcpConfig(config)
    const client = this.requireClient()
    await client.request('config/value/write', {
      keyPath: `mcp_servers.${serverName}`,
      value,
      mergeStrategy: 'replace',
    })
    await client.request('config/mcpServer/reload')
  }

  /** Remove one source-native MCP server and refresh the active Rust sessions. */
  async removeMcpServer(thread: Pick<NativeCodexThread, 'id'>, name: string): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const serverName = nativeMcpServerName(name)
    const client = this.requireClient()
    await client.request('config/value/write', {
      keyPath: `mcp_servers.${serverName}`,
      value: null,
      mergeStrategy: 'replace',
    })
    await client.request('config/mcpServer/reload')
  }

  /** Query the authoritative App Server MCP startup/auth/tool snapshot. */
  async listMcpServerStatuses(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('mcpServerStatus/list', {
      threadId: thread.id,
      detail: 'toolsAndAuthOnly',
    })
  }

  /** Starts Codex's own OAuth flow; credentials stay in its configured store. */
  async startMcpOAuth(thread: Pick<NativeCodexThread, 'id'>, name: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('mcpServer/oauth/login', {
      name: nativeMcpServerName(name),
      threadId: thread.id,
    })
  }

  /** Read the source-owned skill catalog for one verified workspace. */
  async listSkills(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = await this.workspace(cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('skills/list', {
      cwds: [workspace],
      forceReload: true,
    })
  }

  /** Enable or disable a source-native skill without maintaining a second registry. */
  async setSkillEnabled(
    thread: Pick<NativeCodexThread, 'id'>,
    selector: NativeCodexSkillSelector,
    enabled: boolean,
  ): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id) || typeof enabled !== 'boolean') throw new Error('CODEX_NATIVE_SKILL_CONFIGURATION_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('skills/config/write', {
      ...nativeSkillSelector(selector),
      enabled,
    })
  }

  /** Read resolved source-native Hook metadata; execution remains in Rust Core. */
  async listHooks(thread: Pick<NativeCodexThread, 'id'>, cwd: string): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    const workspace = await this.workspace(cwd)
    return await this.requireClient().request<CodexNativeJsonObject>('hooks/list', { cwds: [workspace] })
  }

  /** Read available Codex collaboration presets; Rust owns spawned Agent state. */
  async listCollaborationModes(thread: Pick<NativeCodexThread, 'id'>): Promise<CodexNativeJsonObject> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    return await this.requireClient().request<CodexNativeJsonObject>('collaborationMode/list', {})
  }

  async startTurn(thread: Pick<NativeCodexThread, 'id'>, input: readonly NativeCodexTurnInput[], clientUserMessageId?: string): Promise<NativeCodexTurn> {
    if (!nonEmptyText(thread.id) || input.length === 0 || input.length > 64 || !input.every(validateTurnInput)) {
      throw new Error('CODEX_NATIVE_TURN_INPUT_INVALID')
    }
    if (clientUserMessageId !== undefined && !nonEmptyText(clientUserMessageId, 512)) {
      throw new Error('CODEX_NATIVE_CLIENT_MESSAGE_ID_INVALID')
    }
    const client = this.requireClient()
    this.pendingTurnStarts += 1
    try {
      const response = await client.request<CodexNativeJsonObject>('turn/start', {
        threadId: thread.id,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
        input: input.map(item => item.type === 'text'
          ? { type: 'text', text: item.text, textElements: [] }
          : { type: 'image', url: item.url }),
      })
      const id = turnId(response)
      this.activeTurns.add(id)
      return { id }
    } finally {
      this.pendingTurnStarts = Math.max(0, this.pendingTurnStarts - 1)
    }
  }

  async steerTurn(thread: Pick<NativeCodexThread, 'id'>, turn: NativeCodexTurn, text: string, clientUserMessageId?: string): Promise<void> {
    if (!nonEmptyText(thread.id) || !nonEmptyText(turn.id) || !nonEmptyText(text, 1 << 20)) {
      throw new Error('CODEX_NATIVE_STEER_INPUT_INVALID')
    }
    if (clientUserMessageId !== undefined && !nonEmptyText(clientUserMessageId, 512)) {
      throw new Error('CODEX_NATIVE_CLIENT_MESSAGE_ID_INVALID')
    }
    await this.requireClient().request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turn.id,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      input: [{ type: 'text', text, textElements: [] }],
    })
  }

  async interruptTurn(thread: Pick<NativeCodexThread, 'id'>, turn: NativeCodexTurn): Promise<void> {
    if (!nonEmptyText(thread.id) || !nonEmptyText(turn.id)) throw new Error('CODEX_NATIVE_TURN_ID_INVALID')
    await this.requireClient().request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    this.activeTurns.delete(turn.id)
  }

  async archiveThread(thread: Pick<NativeCodexThread, 'id'>): Promise<void> {
    if (!nonEmptyText(thread.id)) throw new Error('CODEX_NATIVE_THREAD_ID_INVALID')
    await this.requireClient().request('thread/archive', { threadId: thread.id })
    this.threadWorkspaces.delete(thread.id)
    this.loadedThreads.delete(thread.id)
  }

  /** Called by the UI projection after an authoritative `turn/completed` event. */
  markTurnCompleted(turnId: string): void {
    this.activeTurns.delete(turnId)
  }

  /** A provider mutation must not interrupt or split a source-native Turn. */
  assertModelRouteMayChange(): void {
    if (this.activeTurns.size > 0 || this.pendingTurnStarts > 0) {
      throw new Error('CODEX_NATIVE_ROUTE_CHANGE_REQUIRES_IDLE')
    }
  }

  /**
   * Revoke the current process-local provider capability after credential or
   * route settings change. The durable Rust Thread Store is intentionally
   * retained and idle Threads are source-resumed by `ensureThread`.
   */
  async invalidateModelRoute(): Promise<void> {
    this.assertModelRouteMayChange()
    this.routeGeneration += 1
    await this.closeCurrentProcess()
  }

  async close(): Promise<void> {
    this.routeGeneration += 1
    await this.closeCurrentProcess()
  }

  private async closeCurrentProcess(): Promise<void> {
    if (this.closePromise) return await this.closePromise
    this.closePromise = this.closeOnce()
    try { await this.closePromise } finally { this.closePromise = undefined }
  }

  /** Synchronous desktop-shutdown path; no persisted Agent state is deleted. */
  closeImmediately(): void {
    const client = this.client
    const provider = this.provider
    const startingClients = [...this.startingClients]
    const startingProviders = [...this.startingProviders]
    this.client = undefined
    this.provider = undefined
    this.configuredRouteKey = undefined
    this.activeTurns.clear()
    this.pendingTurnStarts = 0
    this.loadedThreads.clear()
    this.threadWorkspaces.clear()
    this.startingClients.clear()
    this.startingProviders.clear()
    this.routeGeneration += 1
    client?.closeImmediately()
    for (const pendingClient of startingClients) pendingClient.closeImmediately()
    // A sudden Electron shutdown must revoke the per-process loopback
    // capability as well as killing Rust. `close()` synchronously aborts its
    // active requests and destroys sockets before awaiting the local server's
    // close callback, so it is safe to initiate from before-quit.
    void provider?.close().catch(() => undefined)
    for (const pendingProvider of startingProviders) void pendingProvider.close().catch(() => undefined)
  }

  private async closeOnce(): Promise<void> {
    const client = this.client
    const provider = this.provider
    const startingClients = [...this.startingClients]
    const startingProviders = [...this.startingProviders]
    this.client = undefined
    this.provider = undefined
    this.configuredRouteKey = undefined
    this.activeTurns.clear()
    this.pendingTurnStarts = 0
    this.loadedThreads.clear()
    this.startingClients.clear()
    this.startingProviders.clear()
    await client?.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    await Promise.all(startingClients.map(pendingClient => pendingClient.close().catch(() => undefined)))
    await Promise.all(startingProviders.map(pendingProvider => pendingProvider.close().catch(() => undefined)))
  }

  private requireClient(): CodexNativeAppServerClient {
    if (!this.client || !this.provider) throw new Error('CODEX_NATIVE_RUNTIME_UNAVAILABLE')
    return this.client
  }

  private async ensureClient(route: CodexNativeModelRoute, cwd: string): Promise<CodexNativeAppServerClient> {
    const nextRouteKey = routeKey(route)
    if (this.client && this.configuredRouteKey === nextRouteKey) return this.client
    this.assertModelRouteMayChange()
    const generation = ++this.routeGeneration
    await this.closeCurrentProcess()
    const provider = await startCodexNativeProvider(route)
    this.startingProviders.add(provider)
    let client: CodexNativeAppServerClient | undefined
    try {
      const engineHome = path.join(absoluteDirectory(this.options.userDataPath), 'codex-native')
      client = new CodexNativeAppServerClient({
        command: await nativeAppServerCommand(this.options.desktopRoot),
        engineHome,
        cwd,
        configOverrides: provider.configOverrides,
        environment: provider.environment,
        onNotification: async notification => {
          const completedTurn = jsonObject(jsonObject(notification.params)?.turn)?.id
          if (notification.method === 'turn/completed' && typeof completedTurn === 'string') this.markTurnCompleted(completedTurn)
          try {
            await this.options.onNotification?.(notification)
          } catch {
            // A renderer projection may disappear during navigation. It must
            // not terminate the authoritative Rust session or strand a tool.
          }
        },
        onServerRequest: this.options.onServerRequest,
      })
      this.startingClients.add(client)
      await client.start()
      this.startingClients.delete(client)
      if (generation !== this.routeGeneration) {
        await client.close().catch(() => undefined)
        throw new Error('CODEX_NATIVE_ROUTE_CHANGED')
      }
      this.startingProviders.delete(provider)
      this.client = client
      this.provider = provider
      this.configuredRouteKey = nextRouteKey
      return client
    } catch (error) {
      if (client) {
        this.startingClients.delete(client)
        await client.close().catch(() => undefined)
      }
      this.startingProviders.delete(provider)
      await provider.close().catch(() => undefined)
      throw error
    }
  }

  private async resumeStoredThread(threadIdValue: string, route: CodexNativeModelRoute): Promise<NativeCodexThread> {
    const cwd = this.threadWorkspaces.get(threadIdValue)
    if (!cwd) throw new Error('CODEX_NATIVE_THREAD_WORKSPACE_UNAVAILABLE')
    const client = await this.ensureClient(route, cwd)
    const response = await client.request<CodexNativeJsonObject>('thread/resume', {
      threadId: threadIdValue,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      // The provider id stays fixed across managed and personal routes, so
      // Rust remains the only durable owner of Thread metadata. Sending the
      // selected model turns a changed credential route into a safe resume
      // mismatch instead of silently sending an old Thread to a new model.
      modelProvider: NATIVE_PROVIDER_ID,
      model: this.provider!.model,
    })
    const id = threadId(response)
    if (id !== threadIdValue) throw new Error('CODEX_NATIVE_THREAD_RESPONSE_INVALID')
    this.loadedThreads.add(id)
    return { id, permissionMode: permissionModeFromThreadResponse(response) }
  }

  private async workspace(value: string): Promise<string> {
    const resolved = absoluteDirectory(value)
    const stat = await fs.lstat(resolved)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_NATIVE_WORKSPACE_INVALID')
    return await fs.realpath(resolved)
  }
}
