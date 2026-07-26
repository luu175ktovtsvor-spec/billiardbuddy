export type InstallationSession = {
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
  bootstrapCredential: string
  licenseKey: string
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

  constructor(private readonly options: InstallationSessionManagerOptions, private readonly store: InstallationSessionStore) {
    this.refreshSkewMs = positiveDuration(options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS, 'refreshSkewMs')
    this.now = options.now ?? Date.now
    this.fetchFn = options.fetchFn ?? fetch
    this.requestTimeoutMs = positiveDuration(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'requestTimeoutMs')
  }

  async accessToken(): Promise<string> {
    if (this.logoutIntent) throw new Error('Installation session logout is in progress')
    return await this.enqueue(async () => {
      if (this.logoutIntent) throw new Error('Installation session logout is in progress')
      const session = this.loadSession()
      if (session && session.expiresAt > this.now() + this.refreshSkewMs) return session.accessToken
      return await this.refreshOrActivate(session)
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
    this.refreshTimer = null
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(operation)
    this.stateTail = result.then(() => undefined, () => undefined)
    return result
  }

  private loadSession(): InstallationSession | null {
    if (this.session !== undefined) return this.session
    const encoded = this.store.load()
    this.session = encoded === null ? null : parseSession(encoded)
    if (this.session && !this.logoutIntent) this.scheduleRefresh(this.session)
    return this.session
  }

  private async refreshOrActivate(session: InstallationSession | null): Promise<string> {
    try {
      const next = session
        ? await this.requestTokens('refresh', { refresh_token: session.refreshToken })
        : await this.requestTokens('activate', {
          license_key: this.options.licenseKey,
          installation_id: this.options.installationId,
        })
      // Persist the rotated proof before handling logout. If logout loses the
      // network, the only valid retry proof survives encrypted at rest.
      this.session = next
      this.store.save(JSON.stringify(next))
      if (this.logoutIntent) throw new Error('Installation session logout is in progress')
      this.scheduleRefresh(next)
      await this.options.onTokenChanged?.(next.accessToken)
      return next.accessToken
    } catch (error) {
      const failure = asError(error)
      // A persisted pair must never fall back to the bootstrap credential after a
      // failed rotation. Keeping it permits an explicit later retry or logout.
      if (failure.message !== 'Installation session logout is in progress') await this.options.onSessionFailure?.(failure)
      throw failure
    }
  }

  private async logoutOnce(session: InstallationSession): Promise<void> {
    try {
      const response = await this.fetchFn(this.endpoint('logout'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

  private async requestTokens(operation: 'activate' | 'refresh', body: Record<string, string>): Promise<InstallationSession> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (operation === 'activate') headers.authorization = `Bearer ${this.options.bootstrapCredential}`
    const response = await this.fetchFn(this.endpoint(operation), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    })
    if (!response.ok) throw new Error(`Installation session ${operation} failed (${response.status})`)
    return parseAuthResponse(await response.json())
  }

  private endpoint(operation: 'activate' | 'refresh' | 'logout'): string {
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
}

function parseSession(encoded: string): InstallationSession {
  let value: unknown
  try { value = JSON.parse(encoded) } catch { throw new Error('Installation session is corrupt') }
  return parseAuthResponse(value)
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
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt }
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`)
  return value
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
