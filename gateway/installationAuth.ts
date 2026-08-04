import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Database } from 'bun:sqlite'

export type AuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  principalId: string
  installationId: string
}

export type VerifiedInstallation = {
  pid: string
  iid: string
  sid: string
  /** Expiry of this verified access proof, projected to trusted Relay introspection. */
  exp: number
}

export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'AuthError'
  }
}

type RegistrationRow = {
  installation_id: string
  principal_id: string
  revoked: number
}

type SessionRow = {
  session_id: string
  principal_id: string
  installation_id: string
  expires_at: number
  revoked: number
  refresh_hash: string
}

type AccessPayload = VerifiedInstallation & {
  v: 2
  aud: string
  exp: number
}

const INSTALLATION_ID = /^[A-Za-z0-9._-]{8,128}$/
const SESSION_ID = /^[A-Za-z0-9_-]{24}$/
const REFRESH_SECRET = /^[A-Za-z0-9_-]{43}$/
const PRINCIPAL_ID = /^installation:[A-Za-z0-9_-]{32}$/

/**
 * Durable authority for anonymous desktop installations. The public installer
 * supplies only a locally generated installation id; access and refresh proofs
 * are rotated server-side and all quota ownership resolves from the verified
 * opaque principal, never a client assertion.
 */
export class AuthAuthority {
  private readonly db: Database
  private readonly now: () => number
  private readonly accessTtlMs: number
  private readonly refreshTtlMs: number
  private readonly audience: string

  constructor(options: {
    dbPath: string
    signingKey: string
    now?: () => number
    accessTtlMs?: number
    refreshTtlMs?: number
    audience?: string
  }) {
    if (options.signingKey.trim().length < 32) throw new Error('Gateway signing key must be at least 32 characters')
    this.signingKey = options.signingKey
    this.now = options.now ?? Date.now
    this.accessTtlMs = positiveDuration(options.accessTtlMs ?? 15 * 60_000)
    this.refreshTtlMs = positiveDuration(options.refreshTtlMs ?? 30 * 24 * 60 * 60_000)
    this.audience = options.audience ?? 'billiardbuddy-gateway'
    this.db = new Database(options.dbPath)
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS installation_registrations_v1(
      installation_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL UNIQUE,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS installation_sessions_v1(
      session_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      refresh_hash TEXT NOT NULL
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS installation_sessions_by_installation_v1 ON installation_sessions_v1(installation_id, revoked, expires_at)')
  }

  private readonly signingKey: string

  bootstrap(installationId: string): AuthTokens {
    if (!INSTALLATION_ID.test(installationId)) throw new AuthError(400, 'invalid_installation')
    return this.transaction(() => {
      this.pruneExpiredSessions()
      let registration = this.registration(installationId)
      if (!registration) {
        const principalId = `installation:${createHmac('sha256', this.signingKey)
          .update(`installation-principal\0${installationId}`).digest('base64url').slice(0, 32)}`
        this.db.query('INSERT INTO installation_registrations_v1(installation_id,principal_id,revoked,created_at) VALUES(?,?,0,?)')
          .run(installationId, principalId, validTimestamp(this.now()))
        registration = this.registration(installationId)
      }
      if (!registration || registration.revoked) throw new AuthError(403, 'installation_revoked')
      this.db.query('UPDATE installation_sessions_v1 SET revoked=1 WHERE installation_id=? AND revoked=0').run(installationId)
      return this.issue(registration.principal_id, installationId)
    })
  }

  refresh(refreshToken: string): AuthTokens {
    const parsed = parseRefreshToken(refreshToken)
    return this.transaction(() => {
      this.pruneExpiredSessions()
      const session = this.db.query('SELECT * FROM installation_sessions_v1 WHERE session_id=?').get(parsed.id) as SessionRow | null
      if (!session || session.revoked || session.expires_at <= this.now() || !safeEqual(session.refresh_hash, digest(parsed.secret))) {
        throw new AuthError(401, 'invalid_refresh')
      }
      const registration = this.registration(session.installation_id)
      if (!registration || registration.revoked || registration.principal_id !== session.principal_id) {
        this.db.query('UPDATE installation_sessions_v1 SET revoked=1 WHERE session_id=?').run(session.session_id)
        throw new AuthError(403, 'installation_revoked')
      }
      this.db.query('UPDATE installation_sessions_v1 SET revoked=1 WHERE session_id=?').run(session.session_id)
      return this.issue(session.principal_id, session.installation_id)
    })
  }

  logout(accessToken?: string, refreshToken?: string): void {
    this.transaction(() => {
      if (refreshToken) {
        const parsed = parseRefreshToken(refreshToken)
        const session = this.db.query('SELECT * FROM installation_sessions_v1 WHERE session_id=?').get(parsed.id) as SessionRow | null
        if (!session || !safeEqual(session.refresh_hash, digest(parsed.secret))) throw new AuthError(401, 'invalid_refresh')
        this.db.query('UPDATE installation_sessions_v1 SET revoked=1 WHERE session_id=?').run(session.session_id)
        return
      }
      if (!accessToken) throw new AuthError(401, 'missing_session_proof')
      const access = this.verifyAccess(accessToken)
      this.db.query('UPDATE installation_sessions_v1 SET revoked=1 WHERE session_id=?').run(access.sid)
    })
  }

  verifyAccess(accessToken: string): VerifiedInstallation {
    const [encoded, signature, extra] = accessToken.split('.')
    if (!encoded || !signature || extra !== undefined) throw new AuthError(401, 'invalid_access')
    const expected = createHmac('sha256', this.signingKey).update(encoded).digest('base64url')
    if (!safeEqual(signature, expected)) throw new AuthError(401, 'invalid_access')
    let payload: AccessPayload
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccessPayload } catch { throw new AuthError(401, 'invalid_access') }
    if (payload.v !== 2 || payload.aud !== this.audience || !SESSION_ID.test(payload.sid) || !PRINCIPAL_ID.test(payload.pid) || !INSTALLATION_ID.test(payload.iid) || !Number.isSafeInteger(payload.exp) || payload.exp <= this.now()) {
      throw new AuthError(401, 'invalid_access')
    }
    const session = this.db.query('SELECT * FROM installation_sessions_v1 WHERE session_id=?').get(payload.sid) as SessionRow | null
    const registration = this.registration(payload.iid)
    if (!session || session.revoked || session.expires_at <= this.now() || session.principal_id !== payload.pid || session.installation_id !== payload.iid || !registration || registration.revoked || registration.principal_id !== payload.pid) {
      throw new AuthError(401, 'invalid_access')
    }
    return { pid: payload.pid, iid: payload.iid, sid: payload.sid, exp: payload.exp }
  }

  private registration(installationId: string): RegistrationRow | null {
    return this.db.query('SELECT * FROM installation_registrations_v1 WHERE installation_id=?').get(installationId) as RegistrationRow | null
  }

  private issue(principalId: string, installationId: string): AuthTokens {
    const issuedAt = validTimestamp(this.now())
    const sessionId = randomBytes(18).toString('base64url')
    const refreshSecret = randomBytes(32).toString('base64url')
    this.db.query('INSERT INTO installation_sessions_v1(session_id,principal_id,installation_id,expires_at,revoked,refresh_hash) VALUES(?,?,?,?,0,?)')
      .run(sessionId, principalId, installationId, issuedAt + this.refreshTtlMs, digest(refreshSecret))
    const expiresAt = issuedAt + this.accessTtlMs
    const encoded = Buffer.from(JSON.stringify({ v: 2, aud: this.audience, sid: sessionId, pid: principalId, iid: installationId, exp: expiresAt })).toString('base64url')
    const signature = createHmac('sha256', this.signingKey).update(encoded).digest('base64url')
    return { accessToken: `${encoded}.${signature}`, refreshToken: `${sessionId}.${refreshSecret}`, expiresAt, principalId, installationId }
  }

  private pruneExpiredSessions(): void {
    this.db.query('DELETE FROM installation_sessions_v1 WHERE expires_at<=?').run(this.now())
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

function parseRefreshToken(value: string): { id: string; secret: string } {
  const [id, secret, extra] = value.split('.')
  if (!id || !secret || extra !== undefined || !SESSION_ID.test(id) || !REFRESH_SECRET.test(secret)) throw new AuthError(401, 'invalid_refresh')
  return { id, secret }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('base64url') }

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Gateway duration must be a positive safe integer')
  return value
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Gateway clock is invalid')
  return value
}
