import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway'

export type RemoteHostCommand =
  | { id: string, type: 'start_turn', threadId: string, cwd: string, text: string, createdAt: number }
  | { id: string, type: 'steer_turn', threadId: string, turnId: string, text: string, createdAt: number }

type RemoteHostConfiguration = { enabled: boolean }

const POLL_DELAY_MS = 2_500
const RETRY_DELAY_MS = 10_000

function configurationPath(userDataPath: string): string {
  return path.join(userDataPath, 'agent-runtime', 'remote-host', 'config.json')
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${pathname}`
}

function validCommand(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const safeText = (candidate: unknown): candidate is string =>
    typeof candidate === 'string'
    && candidate.trim().length > 0
    && candidate.length <= 32_000
    && !candidate.includes('\u0000')
  const safeWorkspace = (candidate: unknown): candidate is string =>
    typeof candidate === 'string'
    && candidate.length > 0
    && candidate.length <= 4_096
    && !/[\u0000\r\n]/.test(candidate)
  const safeThreadId = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(candidate)
  if (
    typeof item.id !== 'string'
    || !/^[A-Za-z0-9_-]{16,80}$/.test(item.id)
    || typeof item.created_at !== 'number'
    || !Number.isSafeInteger(item.created_at)
    || item.created_at < 0
  ) return false
  if (item.type === 'start_turn') {
    return safeThreadId(item.thread_id) && safeWorkspace(item.cwd) && safeText(item.text)
  }
  return item.type === 'steer_turn'
    && safeThreadId(item.thread_id) && safeThreadId(item.turn_id) && safeText(item.text)
}

function normalizeCommand(value: Record<string, unknown>): RemoteHostCommand {
  if (!validCommand(value)) throw new Error('BILLIARDBUDDY_REMOTE_COMMAND_INVALID')
  if (value.type === 'start_turn') {
    return { id: value.id as string, type: 'start_turn', threadId: value.thread_id as string, cwd: value.cwd as string, text: value.text as string, createdAt: value.created_at as number }
  }
  return { id: value.id as string, type: 'steer_turn', threadId: value.thread_id as string, turnId: value.turn_id as string, text: value.text as string, createdAt: value.created_at as number }
}

/**
 * Cross-platform BilliardBuddy Remote Host client. The relay sees only typed
 * remote control commands; it never receives an App Server socket or local
 * credentials. The caller executes commands locally through the existing Core.
 */
export class RemoteHostService {
  private enabled = false
  private running = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: {
    userDataPath: string
    gatewayUrl: () => string
    accessToken: () => Promise<string>
    execute(command: RemoteHostCommand): Promise<void>
    /** Hosts do not claim queued work while the local desktop is unavailable. */
    canAccept?(): boolean
    onStatus?(status: { enabled: boolean, connected: boolean, detail?: string }): void
    fetchFn?: typeof fetch
  }) {}

  async start(): Promise<void> {
    const file = configurationPath(this.options.userDataPath)
    const raw = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (raw) {
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error('BILLIARDBUDDY_REMOTE_HOST_CONFIGURATION_INVALID') }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).enabled !== 'boolean') {
        throw new Error('BILLIARDBUDDY_REMOTE_HOST_CONFIGURATION_INVALID')
      }
      this.enabled = (parsed as RemoteHostConfiguration).enabled
    }
    if (this.enabled) this.arm(0)
    else this.publish(false, false)
  }

  status(): { enabled: boolean } {
    return { enabled: this.enabled }
  }

  refresh(): void {
    if (this.enabled && !this.running) this.arm(0)
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.publish(this.enabled, false)
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled
    const file = configurationPath(this.options.userDataPath)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, file)
    if (enabled) this.arm(0)
    else this.stop()
  }

  async createPairing(ttlSeconds?: number): Promise<{ pairingCode: string, expiresAt: number }> {
    if (!this.enabled) throw new Error('BILLIARDBUDDY_REMOTE_HOST_DISABLED')
    const body = ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds }
    const result = await this.request('/v1/remote/host/pairings', { method: 'POST', body: JSON.stringify(body) }) as Record<string, unknown>
    if (typeof result.pairing_code !== 'string' || typeof result.expires_at !== 'number') throw new Error('BILLIARDBUDDY_REMOTE_PAIRING_RESPONSE_INVALID')
    return { pairingCode: result.pairing_code, expiresAt: result.expires_at }
  }

  async listControllers(): Promise<Array<{ installationId: string, createdAt: number }>> {
    const result = await this.request('/v1/remote/host/controllers') as Record<string, unknown>
    if (!Array.isArray(result.data)) throw new Error('BILLIARDBUDDY_REMOTE_CONTROLLERS_RESPONSE_INVALID')
    return result.data.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const row = item as Record<string, unknown>
      return typeof row.installation_id === 'string' && typeof row.created_at === 'number'
        ? [{ installationId: row.installation_id, createdAt: row.created_at }]
        : []
    })
  }

  async revokeController(installationId: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(installationId)) throw new Error('BILLIARDBUDDY_REMOTE_CONTROLLER_INVALID')
    await this.request(`/v1/remote/host/controllers/${encodeURIComponent(installationId)}`, { method: 'DELETE' })
  }

  private arm(delay: number): void {
    if (!this.enabled || this.pollTimer) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll()
    }, delay)
    this.pollTimer.unref?.()
  }

  private async poll(): Promise<void> {
    if (!this.enabled || this.running) return
    this.running = true
    try {
      if (this.options.canAccept && !this.options.canAccept()) {
        this.publish(true, false, 'local host unavailable')
        this.arm(RETRY_DELAY_MS)
        return
      }
      const result = await this.request('/v1/remote/host/commands?limit=16') as Record<string, unknown>
      if (!Array.isArray(result.data)) throw new Error('BILLIARDBUDDY_REMOTE_COMMANDS_RESPONSE_INVALID')
      this.publish(true, true)
      for (const raw of result.data) {
        let command: RemoteHostCommand | undefined
        try { command = normalizeCommand(raw as Record<string, unknown>) } catch { continue }
        try {
          await this.options.execute(command)
          await this.complete(command.id, 'completed')
        } catch (error) {
          await this.complete(command.id, error instanceof Error && error.message.includes('DECLINED') ? 'rejected' : 'failed').catch(() => undefined)
        }
      }
      this.arm(POLL_DELAY_MS)
    } catch (error) {
      this.publish(true, false, error instanceof Error ? error.message : 'remote host connection failed')
      this.arm(RETRY_DELAY_MS)
    } finally {
      this.running = false
    }
  }

  private async complete(commandId: string, status: 'completed' | 'rejected' | 'failed'): Promise<void> {
    await this.request(`/v1/remote/host/commands/${encodeURIComponent(commandId)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    })
  }

  private publish(enabled: boolean, connected: boolean, detail?: string): void {
    this.options.onStatus?.({ enabled, connected, ...(detail === undefined ? {} : { detail }) })
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.options.accessToken()
    const fetchFn = this.options.fetchFn ?? fetch
    const response = await fetchFn(endpoint(this.options.gatewayUrl(), pathname), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (response.status === 204) return undefined
    if (!response.ok) throw new Error(`BILLIARDBUDDY_REMOTE_HTTP_${response.status}`)
    return await response.json()
  }
}

/** Controller-side typed API for a second BilliardBuddy desktop/mobile client. */
export class RemoteHostControllerClient {
  constructor(private readonly options: { gatewayUrl: () => string, accessToken: () => Promise<string>, fetchFn?: typeof fetch }) {}

  async claim(pairingCode: string): Promise<{ hostInstallationId: string }> {
    const result = await this.request('/v1/remote/pairings/claim', { method: 'POST', body: JSON.stringify({ pairing_code: pairingCode }) }) as Record<string, unknown>
    if (typeof result.host_installation_id !== 'string') throw new Error('BILLIARDBUDDY_REMOTE_CLAIM_RESPONSE_INVALID')
    return { hostInstallationId: result.host_installation_id }
  }

  async startTurn(hostInstallationId: string, input: { threadId: string, cwd: string, text: string }): Promise<{ commandId: string }> {
    return await this.command(hostInstallationId, { type: 'start_turn', thread_id: input.threadId, cwd: input.cwd, text: input.text })
  }

  async steerTurn(hostInstallationId: string, input: { threadId: string, turnId: string, text: string }): Promise<{ commandId: string }> {
    return await this.command(hostInstallationId, { type: 'steer_turn', thread_id: input.threadId, turn_id: input.turnId, text: input.text })
  }

  private async command(hostInstallationId: string, body: Record<string, unknown>): Promise<{ commandId: string }> {
    if (!/^[A-Za-z0-9._-]{8,128}$/.test(hostInstallationId)) throw new Error('BILLIARDBUDDY_REMOTE_HOST_INVALID')
    const result = await this.request(`/v1/remote/hosts/${encodeURIComponent(hostInstallationId)}/commands`, { method: 'POST', body: JSON.stringify(body) }) as Record<string, unknown>
    if (typeof result.command_id !== 'string') throw new Error('BILLIARDBUDDY_REMOTE_COMMAND_RESPONSE_INVALID')
    return { commandId: result.command_id }
  }

  private async request(pathname: string, init: RequestInit): Promise<unknown> {
    const token = await this.options.accessToken()
    const response = await (this.options.fetchFn ?? fetch)(endpoint(this.options.gatewayUrl(), pathname), {
      ...init,
      headers: { Authorization: `Bearer ${token}`, [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue, 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`BILLIARDBUDDY_REMOTE_HTTP_${response.status}`)
    return await response.json()
  }
}
