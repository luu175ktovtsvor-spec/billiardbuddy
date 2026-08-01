import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway'

export type InstallationSession = {
  schemaVersion: 2
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export type InstallationSessionStore = {
  load(): string | null
  save(value: string): void
  clear(): void
}

export type InstallationSessionManagerOptions = {
  gatewayUrl: string
  installationId: string
  /** Refresh this far ahead of the server expiry; never serve a token in this window. */
  refreshSkewMs?: number
  requestTimeoutMs?: number
  now?: () => number
  fetchFn?: typeof fetch
  onTokenChanged?: (accessToken: string) => void | Promise<void>
  onSessionFailure?: (error: Error) => void | Promise<void>
}

const DEFAULT_REFRESH_SKEW_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const SESSION_RECOVERY_DELAY_MS = 10_000

type AuthResponse = { access_token: string; refresh_token: string; expires_at: number; token_type?: string }

/**
 * Main-process owner for the installation session. It serializes refresh-token
 * rotation and persists only the current token pair in encrypted storage.
 */
export class InstallationSessionManager {
  private readonly refreshSkewMs: number
  private readonly now: () => number
  private readonly fetchFn: typeof fetch
  private readonly requestTimeoutMs: number
  private session: InstallationSession | null | undefined
  private logoutIntent = false
  private logoutPromise: Promise<void> | null = null
  private stateTail: Promise<void> = Promise.resolve()
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: InstallationSessionManagerOptions, private readonly store: InstallationSessionStore) {
    this.refreshSkewMs = positiveDuration(options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS, 'refreshSkewMs')
    this.now = options.now ?? Date.now
    this.fetchFn = options.fetchFn ?? fetch
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs')
  }

  /** Return an already-valid proof without performing network I/O. */
  cachedAccessToken(): string | undefined {
    if (this.logoutIntent) return undefined
    const session = this.loadSession()
    return session && session.expiresAt > this.now() + this.refreshSkewMs
      ? session.accessToken
      : undefined
  }

  async accessToken(): Promise<string> {
    if (this.logoutIntent) throw new Error('Installation session logout is in progress')
    return await this.enqueue(async () => {
      if (this.logoutIntent) throw new Error('Installation session logout is in progress')
      const session = this.loadSession()
      if (session && session.expiresAt > this.now() + this.refreshSkewMs) return session.accessToken
      return await this.refreshOrBootstrap(session)
    })
  }

  /** Set intent synchronously: no later refresh may start after this point. */
  async logout(): Promise<void> {
    this.logoutIntent = true
    this.dispose()
    if (this.logoutPromise) return await this.logoutPromise
    this.logoutPromise = this.enqueue(async () => {
      const session = this.loadSession()
      if (!session) { this.logoutIntent = false; return }
      await this.logoutOnce(session)
      this.logoutIntent = false
    })
    try { await this.logoutPromise } finally { this.logoutPromise = null }
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.refreshTimer = null
    this.recoveryTimer = null
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(operation)
    this.stateTail = result.then(() => undefined, () => undefined)
    return result
  }

  private loadSession(): InstallationSession | null {
    if (this.session !== undefined) return this.session
    let encoded: string | null
    try {
      encoded = this.store.load()
    } catch (error) {
      try { this.store.clear() } catch { /* An in-memory bootstrap remains valid for this run. */ }
      encoded = null
      void this.options.onSessionFailure?.(asError(error))
    }
    if (encoded === null) this.session = null
    else {
      try { this.session = parseSession(encoded) }
      catch (error) {
        try { this.store.clear() } catch (clearError) { void this.options.onSessionFailure?.(asError(clearError)) }
        this.session = null
        void this.options.onSessionFailure?.(asError(error))
      }
    }
    if (this.session && !this.logoutIntent) this.scheduleRefresh(this.session)
    return this.session
  }

  private async refreshOrBootstrap(session: InstallationSession | null): Promise<string> {
    try {
      let next: InstallationSession
      if (session) {
        try { next = await this.requestTokens('refresh', { refresh_token: session.refreshToken }) }
        catch (error) {
          if (!(error instanceof InstallationSessionRequestError) || (error.status !== 401 && error.status !== 403)) throw error
          this.session = null
          try { this.store.clear() } catch (clearError) { await this.options.onSessionFailure?.(asError(clearError)) }
          next = await this.requestTokens('bootstrap', { installation_id: this.options.installationId })
        }
      } else next = await this.requestTokens('bootstrap', { installation_id: this.options.installationId })
      return await this.commitSession(next)
    } catch (error) {
      const failure = asError(error)
      if (failure.message !== 'Installation session logout is in progress') {
        this.scheduleRecovery()
        await this.options.onSessionFailure?.(failure)
      }
      throw failure
    }
  }

  private async commitSession(next: InstallationSession): Promise<string> {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.session = next
    try { this.store.save(JSON.stringify(next)) } catch (error) { await this.options.onSessionFailure?.(asError(error)) }
    if (this.logoutIntent) throw new Error('Installation session logout is in progress')
    this.scheduleRefresh(next)
    await this.options.onTokenChanged?.(next.accessToken)
    return next.accessToken
  }

  private async logoutOnce(session: InstallationSession): Promise<void> {
    try {
      const response = await this.fetchFn(this.endpoint('logout'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
      if (response.status !== 204) throw new Error(`Installation session logout failed (${response.status})`)
      this.session = null
      this.store.clear()
      this.dispose()
    } catch (error) {
      // Do not silently orphan a refresh token: retain encrypted credentials and
      // keep the logout intent, so no caller can revive the sidecar before retry.
      const failure = asError(error)
      await this.options.onSessionFailure?.(failure)
      throw failure
    }
  }

  private async requestTokens(operation: 'bootstrap' | 'refresh', body: Record<string, string>): Promise<InstallationSession> {
    const headers: Record<string, string> = { 'content-type': 'application/json', [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue }
    const response = await this.fetchFn(this.endpoint(operation), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!response.ok) throw new InstallationSessionRequestError(operation, response.status)
    return parseAuthResponse(await response.json())
  }

  private endpoint(operation: 'bootstrap' | 'refresh' | 'logout'): string {
    return `${this.options.gatewayUrl.replace(/\/+$/, '')}/v1/auth/${operation}`
  }

  private scheduleRefresh(session: InstallationSession): void {
    if (this.logoutIntent) return
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    const delay = Math.max(0, session.expiresAt - this.now() - this.refreshSkewMs)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.accessToken().catch(() => undefined)
    }, delay)
    this.refreshTimer.unref?.()
  }

  private scheduleRecovery(): void {
    if (this.logoutIntent || this.recoveryTimer) return
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      void this.accessToken().catch(() => undefined)
    }, SESSION_RECOVERY_DELAY_MS)
    this.recoveryTimer.unref?.()
  }
}

function parseSession(encoded: string): InstallationSession {
  let value: unknown
  try { value = JSON.parse(encoded) } catch { throw new Error('Installation session is corrupt') }
  if (value && typeof value === 'object') {
    const stored = value as Partial<InstallationSession>
    if (stored.schemaVersion === 2
      && typeof stored.accessToken === 'string' && stored.accessToken.trim()
      && typeof stored.refreshToken === 'string' && stored.refreshToken.trim()
      && typeof stored.expiresAt === 'number' && Number.isSafeInteger(stored.expiresAt) && stored.expiresAt > 0) {
      return {
        schemaVersion: 2,
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
      }
    }
  }
  throw new Error('Installation session is obsolete')
}

function parseAuthResponse(value: unknown): InstallationSession {
  if (!value || typeof value !== 'object') throw new Error('Installation session response is invalid')
  const tokens = value as Partial<AuthResponse>
  const expiresAt = tokens.expires_at
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim()
    || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token.trim()
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error('Installation session response is invalid')
  }
  return { schemaVersion: 2, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt }
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}
class InstallationSessionRequestError extends Error {
  constructor(operation: 'bootstrap' | 'refresh', readonly status: number) {
    super(`Installation session ${operation} failed (${status})`)
    this.name = 'InstallationSessionRequestError'
  }
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
