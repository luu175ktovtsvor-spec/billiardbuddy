import * as fs from 'node:fs/promises'
import * as path from 'node:path'

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue | undefined }

type JsonRpcError = { code: number; message: string; data?: JsonValue }
type PendingRequest = {
  resolve(value: JsonValue): void
  reject(error: Error): void
}

export type CodexAppServerClientInfo = {
  name: string
  title?: string
  version: string
}

export type CodexAppServerNotification = {
  method: string
  params?: JsonValue
}

export type CodexAppServerRequest = CodexAppServerNotification & {
  id: number | string
}

export type CodexAppServerClientOptions = {
  /** A BilliardBuddy-owned executable command; callers must never supply a shell string. */
  command: readonly string[]
  /** Product-private engine state directory, never the user's existing Codex directory. */
  engine_home: string
  /** Keep the app-server itself out of a user workspace until a Turn supplies one explicitly. */
  cwd?: string
  client_info: CodexAppServerClientInfo
  config_overrides?: readonly string[]
  environment?: Readonly<Record<string, string | undefined>>
  on_notification?(notification: CodexAppServerNotification): void
  on_server_request?(request: CodexAppServerRequest): Promise<JsonValue | undefined>
}

const MAX_JSON_RPC_FRAME_BYTES = 4 * 1024 * 1024
const APP_SERVER_SHUTDOWN_WAIT_MS = 1_000

function isNonEmptyText(value: string | undefined, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function jsonRpcError(value: unknown): JsonRpcError | undefined {
  const record = jsonObject(value)
  return record && typeof record.code === 'number' && typeof record.message === 'string'
    ? { code: record.code, message: record.message, ...(record.data !== undefined ? { data: record.data } : {}) }
    : undefined
}

function productEngineEnvironment(input: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const inheritedKeys = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']
  const environment: Record<string, string> = {}
  for (const key of inheritedKeys) {
    const value = process.env[key]
    if (value) environment[key] = value
  }
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === undefined) continue
    environment[key] = value
  }
  return environment
}

async function ensurePrivateEngineHome(engineHome: string): Promise<string> {
  const resolved = path.resolve(engineHome)
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CODEX_ENGINE_HOME_INVALID')
  return await fs.realpath(resolved)
}

function engineError(message: string, detail?: string): Error {
  return new Error(detail ? `${message}: ${detail}` : message)
}

/**
 * Narrow JSON-RPC client for the upstream app-server. It deliberately keeps
 * credentials and product state out of the process environment and forces all
 * server-initiated approvals through an explicit BilliardBuddy callback.
 */
export class CodexAppServerClient {
  private process?: ReturnType<typeof Bun.spawn>
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 0
  private engineHome?: string
  private closed = false
  private stderr = ''

  constructor(private readonly options: CodexAppServerClientOptions) {}

  async start(): Promise<void> {
    if (this.process) throw new Error('CODEX_APP_SERVER_ALREADY_STARTED')
    if (this.options.command.length === 0 || this.options.command.some(value => !isNonEmptyText(value, 4_096))) {
      throw new Error('CODEX_APP_SERVER_COMMAND_INVALID')
    }
    if (!isNonEmptyText(this.options.client_info.name) || !isNonEmptyText(this.options.client_info.version)) {
      throw new Error('CODEX_APP_SERVER_CLIENT_INFO_INVALID')
    }
    const engineHome = await ensurePrivateEngineHome(this.options.engine_home)
    this.engineHome = engineHome
    const environment = productEngineEnvironment(this.options.environment)
    environment.CODEX_HOME = engineHome
    const command = [
      ...this.options.command,
      ...(this.options.config_overrides ?? []).flatMap(value => ['--config', value]),
      '--listen',
      'stdio://',
    ]
    const process = Bun.spawn(command, {
      cwd: this.options.cwd ? path.resolve(this.options.cwd) : engineHome,
      env: environment,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.process = process
    void this.readStdout(process)
    void this.readStderr(process)
    void process.exited.then(() => this.failAllPending(engineError('CODEX_APP_SERVER_EXITED', this.stderr.slice(-2_000))), () => this.failAllPending(engineError('CODEX_APP_SERVER_EXITED', this.stderr.slice(-2_000))))
    try {
      const initialized = await this.request<JsonObject>('initialize', {
        clientInfo: {
          name: this.options.client_info.name,
          ...(this.options.client_info.title ? { title: this.options.client_info.title } : {}),
          version: this.options.client_info.version,
        },
        capabilities: { experimentalApi: true },
      })
      if (initialized.codexHome !== engineHome) throw new Error('CODEX_APP_SERVER_HOME_MISMATCH')
      this.notify('initialized', {})
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async request<T extends JsonValue = JsonValue>(method: string, params?: JsonValue): Promise<T> {
    if (!isNonEmptyText(method)) throw new Error('CODEX_APP_SERVER_METHOD_INVALID')
    const process = this.process
    if (!process || this.closed) throw new Error('CODEX_APP_SERVER_UNAVAILABLE')
    const id = ++this.nextRequestId
    const response = new Promise<JsonValue>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return await response as T
  }

  notify(method: string, params?: JsonValue): void {
    if (!isNonEmptyText(method)) throw new Error('CODEX_APP_SERVER_METHOD_INVALID')
    if (!this.process || this.closed) throw new Error('CODEX_APP_SERVER_UNAVAILABLE')
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const process = this.process
    this.process = undefined
    this.failAllPending(engineError('CODEX_APP_SERVER_CLOSED'))
    if (!process) return
    try {
      if (process.stdin && typeof process.stdin !== 'number') process.stdin.end()
    } catch {}
    const exited = process.exited.catch(() => undefined)
    const timer = new Promise<void>(resolve => setTimeout(resolve, APP_SERVER_SHUTDOWN_WAIT_MS))
    await Promise.race([exited, timer])
    try { process.kill() } catch {}
    await exited
  }

  private write(frame: JsonObject): void {
    const stdin = this.process?.stdin
    if (!stdin || typeof stdin === 'number') throw new Error('CODEX_APP_SERVER_STDIN_UNAVAILABLE')
    const serialized = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(serialized) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_APP_SERVER_FRAME_TOO_LARGE')
    stdin.write(serialized)
  }

  private async readStdout(process: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!process.stdout || typeof process.stdout === 'number') return this.failAllPending(engineError('CODEX_APP_SERVER_STDOUT_UNAVAILABLE'))
    const reader = process.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        if (Buffer.byteLength(buffer) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_APP_SERVER_FRAME_TOO_LARGE')
        let boundary: number
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, boundary).trim()
          buffer = buffer.slice(boundary + 1)
          if (!line) continue
          if (Buffer.byteLength(line) > MAX_JSON_RPC_FRAME_BYTES) throw new Error('CODEX_APP_SERVER_FRAME_TOO_LARGE')
          let message: unknown
          try { message = JSON.parse(line) } catch { throw new Error('CODEX_APP_SERVER_PROTOCOL_INVALID') }
          await this.handleMessage(message)
        }
      }
      if (buffer.trim()) throw new Error('CODEX_APP_SERVER_PROTOCOL_INVALID')
    } catch (error) {
      this.failAllPending(error instanceof Error ? error : engineError('CODEX_APP_SERVER_PROTOCOL_INVALID'))
      try { process.kill() } catch {}
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(process: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!process.stderr || typeof process.stderr === 'number') return
    const reader = process.stderr.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        this.stderr = `${this.stderr}${decoder.decode(next.value, { stream: true })}`.slice(-8_192)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async handleMessage(value: unknown): Promise<void> {
    const message = jsonObject(value)
    // The upstream app-server accepts JSON-RPC 2.0 envelopes but deliberately
    // omits the redundant `jsonrpc` field in its own stdout responses and
    // notifications. Keep that wire compatibility narrow: any supplied value
    // must still be exactly 2.0.
    if (!message || (message.jsonrpc !== undefined && message.jsonrpc !== '2.0')) {
      throw new Error('CODEX_APP_SERVER_PROTOCOL_INVALID')
    }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      const error = message.error === undefined ? undefined : jsonRpcError(message.error)
      if (message.error !== undefined && !error) return pending.reject(engineError('CODEX_APP_SERVER_PROTOCOL_INVALID'))
      if (error) return pending.reject(engineError('CODEX_APP_SERVER_REQUEST_FAILED', `${error.code} ${error.message}`))
      return pending.resolve(message.result ?? null)
    }
    if (!isNonEmptyText(typeof message.method === 'string' ? message.method : undefined)) throw new Error('CODEX_APP_SERVER_PROTOCOL_INVALID')
    const request = {
      method: message.method as string,
      ...(message.params === undefined ? {} : { params: message.params }),
    }
    if (typeof message.id !== 'number' && typeof message.id !== 'string') {
      this.options.on_notification?.(request)
      return
    }
    const requestWithId: CodexAppServerRequest = { ...request, id: message.id }
    try {
      if (!this.options.on_server_request) throw new Error('CODEX_APP_SERVER_SERVER_REQUEST_UNHANDLED')
      const result = await this.options.on_server_request(requestWithId)
      this.write({ jsonrpc: '2.0', id: message.id, result: result ?? {} })
    } catch (error) {
      const description = error instanceof Error ? error.message : 'BILLIARDBUDDY_ENGINE_REQUEST_FAILED'
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: description } })
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
