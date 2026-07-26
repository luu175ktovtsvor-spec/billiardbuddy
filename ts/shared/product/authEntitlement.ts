import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { basename, dirname } from 'node:path'

export type AccessPrincipal = { id: string }
export type InstallationRegistration = { id: string; principalId: string; revoked: boolean; createdAt: number }
export type Entitlement = { licenseKey: string; principalId: string; active: boolean; deviceLimit: number; authorityRevision: number }
export type AuthSession = { id: string; principalId: string; installationId: string; licenseKey: string; expiresAt: number; revoked: boolean; refreshHash: string }
export type AuthTokens = { accessToken: string; refreshToken: string; expiresAt: number; principalId: string; installationId: string }

type State = {
  version: 1
  revision: number
  entitlements: Entitlement[]
  registrations: InstallationRegistration[]
  sessions: AuthSession[]
}

export type LicenseProvisioning = {
  licenseKey: string
  principalId: string
  deviceLimit: number
  active: boolean
  revision: number
}

export interface DurableAuthorityStore {
  load(): State | null
  save(state: State): void
  withLock<T>(operation: () => T): T
}

export class MemoryAuthorityStore implements DurableAuthorityStore {
  private state: State | null = null
  load(): State | null { return this.state ? structuredClone(this.state) : null }
  save(state: State): void { this.state = structuredClone(state) }
  withLock<T>(operation: () => T): T { return operation() }
}

export type FileAuthorityStoreOptions = { lockTimeoutMs?: number; lockRetryMs?: number; staleLockMs?: number }

type LockOwner = { nonce: string; pid: number; hostname: string; startMarker: string }
type OwnerStatus = 'alive' | 'dead' | 'unknown'

/**
 * The lock is a separately-created directory: mkdir is an atomic, cross-process
 * operation on the filesystems supported by gateway deployments. State writes use
 * a same-directory rename, so readers observe either complete revision.
 *
 * Lock age is deliberately not a reclaim signal. A slow but healthy authority must
 * retain its lock. Reclaim is allowed only after the recorded local process identity
 * (pid plus its OS start marker) has disappeared or changed.
 */
export class FileAuthorityStore implements DurableAuthorityStore {
  private readonly lockTimeoutMs: number
  private readonly lockRetryMs: number

  constructor(private readonly file: string, options: FileAuthorityStoreOptions = {}) {
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? 1_000, 'lockTimeoutMs')
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? 10, 'lockRetryMs')
    // Retained only as a compatible option: mtime is never trusted for reclaim.
    positiveInteger(options.staleLockMs ?? 10_000, 'staleLockMs')
  }

  load(): State | null {
    if (!existsSync(this.file)) return null
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as State } catch { throw new Error('Gateway authority store is unreadable') }
  }

  save(state: State): void {
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    assertPrivateDirectory(dir)
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    chmodOwnerOnly(tmp, 0o600)
    renameSync(tmp, this.file)
    chmodOwnerOnly(this.file, 0o600)
  }

  withLock<T>(operation: () => T): T {
    const lock = `${this.file}.lock`
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    assertPrivateDirectory(dir)
    const deadline = Date.now() + this.lockTimeoutMs
    while (true) {
      const nonce = this.tryAcquire(lock)
      if (nonce) {
        try { return operation() } finally { this.release(lock, nonce) }
      }
      if (this.ownerStatus(lock) === 'dead') this.reclaim(lock)
      if (Date.now() >= deadline) throw new Error('Gateway authority lock timeout')
      sleep(this.lockRetryMs)
    }
  }

  private tryAcquire(lock: string): string | null {
    if (this.reclaimArtifactsActive(lock)) return null
    try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    try {
      const owner = writeLockOwner(lock)
      // A contender which raced an already-claimed reclaim must abandon its
      // provisional directory rather than becoming a replacement during recovery.
      if (this.reclaimArtifactsActive(lock)) { this.release(lock, owner.nonce); return null }
      return owner.nonce
    } catch (error) {
      rmSync(lock, { recursive: true, force: true })
      throw error
    }
  }

  private ownerStatus(lock: string): OwnerStatus { return ownerStatus(readLockOwner(lock)) }

  /**
   * Claim recovery before moving the dead lock. The gate closes the window between
   * observing a dead owner and rename; a stale observer can no longer rename a
   * newly-created lock after another reclaimer has finished.
   */
  private reclaim(lock: string): void {
    const observed = readLockOwner(lock)
    if (!observed || ownerStatus(observed) !== 'dead') return
    const gate = reclaimGatePath(lock)
    const claim = this.tryClaimReclaim(gate)
    if (!claim) return
    let retainGate = false
    try {
      const current = readLockOwner(lock)
      if (!current || current.nonce !== observed.nonce || ownerStatus(current) !== 'dead') return
      const tombstone = reclaimTombstonePath(lock, claim.nonce)
      try { renameSync(lock, tombstone) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      // The tombstone is now exclusively owned by this claim. A mismatched record
      // means an impossible/hostile rename interleave: retain the gate and fail
      // closed rather than attempting a non-atomic restore over a new owner.
      const moved = readLockOwner(tombstone)
      if (!moved || moved.nonce !== observed.nonce || ownerStatus(moved) !== 'dead') {
        retainGate = true
        return
      }
      rmSync(tombstone, { recursive: true, force: true })
    } finally {
      if (!retainGate) this.release(gate, claim.nonce)
    }
  }

  private tryClaimReclaim(gate: string): LockOwner | null {
    try { mkdirSync(gate, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
    try { return writeLockOwner(gate) } catch (error) {
      rmSync(gate, { recursive: true, force: true })
      throw error
    }
  }

  /** Recover a crashed reclaimer only after its identity is confirmed dead. */
  private reclaimArtifactsActive(lock: string): boolean {
    const gate = reclaimGatePath(lock)
    const gateOwner = readLockOwner(gate)
    const tombstones = reclaimTombstones(lock)
    if (gateOwner) {
      if (ownerStatus(gateOwner) !== 'dead') return true
      // A crashed reclaimer may have moved the original directory. Never remove a
      // tombstone unless its own recorded owner is also verifiably dead.
      if (tombstones.some((path) => ownerStatus(readLockOwner(path)) !== 'dead')) return true
      for (const tombstone of tombstones) rmSync(tombstone, { recursive: true, force: true })
      this.release(gate, gateOwner.nonce)
      return false
    }
    if (existsSync(gate)) return true // corrupt/unsafe gate: fail closed.
    if (tombstones.some((path) => ownerStatus(readLockOwner(path)) !== 'dead')) return true
    for (const tombstone of tombstones) rmSync(tombstone, { recursive: true, force: true })
    return false
  }

  private release(lock: string, nonce: string): void {
    const owner = readLockOwner(lock)
    if (!owner || owner.nonce !== nonce) return
    const current = readLockOwner(lock)
    if (!current || current.nonce !== nonce) return
    rmSync(lock, { recursive: true, force: true })
  }
}

function lockOwnerPath(lock: string): string { return `${lock}/owner.json` }
function reclaimGatePath(lock: string): string { return `${lock}.reclaim-gate` }
function reclaimTombstonePath(lock: string, nonce: string): string { return `${lock}.reclaim-tombstone.${nonce}` }
function reclaimTombstones(lock: string): string[] {
  const prefix = `${basename(lock)}.reclaim-tombstone.`
  try { return readdirSync(dirname(lock)).filter((name) => name.startsWith(prefix)).map((name) => `${dirname(lock)}/${name}`) } catch { return [] }
}
function writeLockOwner(lock: string): LockOwner {
  assertPrivateDirectory(lock)
  const startMarker = currentProcessStartMarker(process.pid)
  if (!startMarker) throw new Error('Gateway authority lock process identity is unavailable')
  const owner: LockOwner = { nonce: randomBytes(24).toString('base64url'), pid: process.pid, hostname: hostname(), startMarker }
  writeFileSync(lockOwnerPath(lock), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  chmodOwnerOnly(lockOwnerPath(lock), 0o600)
  return owner
}
function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.platform !== 'win32' && stat.uid !== process.getuid?.())) throw new Error('Gateway authority lock path is unsafe')
  chmodOwnerOnly(path, 0o700)
}
function readLockOwner(lock: string): LockOwner | null {
  try {
    assertPrivateDirectory(lock)
    const stat = lstatSync(lockOwnerPath(lock))
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.platform !== 'win32' && stat.uid !== process.getuid?.())) return null
    const value: unknown = JSON.parse(readFileSync(lockOwnerPath(lock), 'utf8'))
    if (!value || typeof value !== 'object') return null
    const owner = value as Partial<LockOwner>
    return typeof owner.nonce === 'string' && /^[A-Za-z0-9_-]{32}$/.test(owner.nonce)
      && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0
      && typeof owner.hostname === 'string' && owner.hostname.length > 0 && owner.hostname.length <= 255
      && typeof owner.startMarker === 'string' && owner.startMarker.length > 0 && owner.startMarker.length <= 512
      ? owner as LockOwner : null
  } catch { return null }
}
function ownerStatus(owner: LockOwner | null): OwnerStatus {
  if (!owner || owner.hostname !== hostname()) return 'unknown'
  const current = processStartMarker(owner.pid)
  if (current.kind === 'dead') return 'dead'
  if (current.kind !== 'known') return 'unknown'
  return current.value === owner.startMarker ? 'alive' : 'dead'
}
type ProcessMarker = { kind: 'known'; value: string } | { kind: 'dead' | 'unknown' }
function currentProcessStartMarker(pid: number): string | null {
  const result = processStartMarker(pid)
  return result.kind === 'known' ? result.value : null
}
function processStartMarker(pid: number): ProcessMarker {
  try {
    if (process.platform === 'linux') {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ')
      const value = fields[21]
      return value && /^\d+$/.test(value) ? { kind: 'known', value } : { kind: 'unknown' }
    }
    if (process.platform === 'darwin') {
      const value = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return value ? { kind: 'known', value } : { kind: 'dead' }
    }
    if (process.platform === 'win32') {
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return /^\d+$/.test(value) ? { kind: 'known', value } : { kind: 'unknown' }
    }
  } catch (error) {
    const code = (error as { status?: unknown }).status
    return code === 1 ? { kind: 'dead' } : { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

export type AuthAuthorityOptions = {
  store: DurableAuthorityStore
  signingKey: string
  audience?: string
  accessTtlMs?: number
  refreshTtlMs?: number
  now?: () => number
  licenses?: LicenseProvisioning[]
}

type AccessPayload = { v: 1; aud: string; sid: string; pid: string; iid: string; exp: number }
const installationPattern = /^[A-Za-z0-9._-]{8,128}$/
const licensePattern = /^[A-Za-z0-9._-]{8,256}$/
const principalPattern = /^[A-Za-z0-9._:-]{1,256}$/
const opaqueIdPattern = /^[A-Za-z0-9_-]{16,128}$/
const hashPattern = /^[A-Za-z0-9_-]{43}$/

function emptyState(): State { return { version: 1, revision: 0, entitlements: [], registrations: [], sessions: [] } }
function b64(value: string | Uint8Array): string { return Buffer.from(value).toString('base64url') }
function unb64(value: string): string { return Buffer.from(value, 'base64url').toString('utf8') }
function digest(value: string): string { return createHmac('sha256', 'refresh-hash').update(value).digest('base64url') }
function randomToken(): string { return randomBytes(32).toString('base64url') }
function nowMs(): number { return Date.now() }

/** Durable entitlement authority. Every changing operation reloads under the file lock. */
export class AuthAuthority {
  private readonly audience: string
  private readonly accessTtlMs: number
  private readonly refreshTtlMs: number
  private readonly now: () => number

  constructor(private readonly options: AuthAuthorityOptions) {
    if (options.signingKey.trim().length < 32) throw new Error('Gateway signing key must be at least 32 characters')
    this.audience = options.audience ?? 'billiardbuddy-gateway'
    this.accessTtlMs = positiveInteger(options.accessTtlMs ?? 15 * 60_000, 'accessTtlMs')
    this.refreshTtlMs = positiveInteger(options.refreshTtlMs ?? 30 * 24 * 60 * 60_000, 'refreshTtlMs')
    this.now = options.now ?? nowMs
    const licenses = options.licenses ?? []
    for (const license of licenses) assertProvisioning(license)
    if (licenses.length) this.mutate(state => { for (const license of licenses) applyProvisioning(state, license); return undefined })
    else this.readState() // validate an existing file on startup, failing closed before serving requests.
  }

  /** Called only by trusted startup provisioning, never by a public gateway route. */
  provisionLicense(license: LicenseProvisioning): void {
    assertProvisioning(license)
    this.mutate(state => { applyProvisioning(state, license) })
  }

  activate(input: { licenseKey: string; installationId: string; replaceInstallationId?: string }): AuthTokens {
    if (!licensePattern.test(input.licenseKey) || !installationPattern.test(input.installationId)) throw new AuthError(400, 'invalid_activation')
    if (input.replaceInstallationId !== undefined && !installationPattern.test(input.replaceInstallationId)) throw new AuthError(400, 'invalid_activation')
    return this.mutate(state => {
      const entitlement = entitlementFor(state, input.licenseKey)
      if (!entitlement || !entitlement.active) throw new AuthError(403, 'license_unavailable')
      const registration = registrationFor(state, input.installationId)
      if (registration?.revoked) throw new AuthError(403, 'installation_revoked')
      if (registration && registration.principalId !== entitlement.principalId) throw new AuthError(403, 'installation_bound_to_another_principal')
      if (!registration) {
        let active = activeRegistrations(state, entitlement.principalId)
        if (active.length >= entitlement.deviceLimit && input.replaceInstallationId) {
          const replaced = registrationFor(state, input.replaceInstallationId)
          if (!replaced || replaced.revoked || replaced.principalId !== entitlement.principalId || replaced.id === input.installationId) throw new AuthError(403, 'invalid_replacement')
          revokeRegistration(state, replaced)
          active = activeRegistrations(state, entitlement.principalId)
        }
        if (active.length >= entitlement.deviceLimit) throw new AuthError(403, 'device_limit_reached')
        state.registrations.push({ id: input.installationId, principalId: entitlement.principalId, revoked: false, createdAt: validDate(this.now(), 'clock') })
      }
      return issue(state, this.options.signingKey, this.audience, this.accessTtlMs, this.refreshTtlMs, this.now, entitlement.principalId, input.installationId, entitlement.licenseKey)
    })
  }

  refresh(refreshToken: string): AuthTokens {
    return this.mutate(state => {
      const session = refreshSession(state, refreshToken)
      if (!session || session.revoked || session.expiresAt <= this.now()) throw new AuthError(401, 'invalid_refresh')
      if (!isSessionAllowed(state, session)) {
        session.revoked = true
        throw new AuthError(403, 'entitlement_inactive')
      }
      session.revoked = true
      return issue(state, this.options.signingKey, this.audience, this.accessTtlMs, this.refreshTtlMs, this.now, session.principalId, session.installationId, session.licenseKey)
    })
  }

  logout(accessToken?: string, refreshToken?: string): void {
    this.mutate(state => {
      if (refreshToken) {
        const session = refreshSession(state, refreshToken)
        if (!session || !safeEqual(session.refreshHash, digest(refreshToken.split('.', 2)[1] ?? ''))) throw new AuthError(401, 'invalid_refresh')
        session.revoked = true
        return
      }
      if (!accessToken) throw new AuthError(401, 'missing_session_proof')
      const payload = this.verifyAccessInState(accessToken, state)
      const session = sessionFor(state, payload.sid)
      if (session) session.revoked = true
    })
  }

  revokeInstallation(installationId: string): void {
    if (!installationPattern.test(installationId)) throw new Error('Invalid installation id')
    this.mutate(state => {
      const registration = registrationFor(state, installationId)
      if (registration) revokeRegistration(state, registration)
    })
  }

  setEntitlementActive(licenseKey: string, active: boolean): void {
    if (!licensePattern.test(licenseKey) || typeof active !== 'boolean') throw new Error('Invalid entitlement')
    this.mutate(state => {
      const entitlement = entitlementFor(state, licenseKey)
      if (!entitlement) throw new Error('Unknown license')
      entitlement.active = active
      if (!active) revokeLicenseSessions(state, licenseKey)
    })
  }

  verifyAccess(accessToken: string): AccessPayload { return this.verifyAccessInState(accessToken, this.readState()) }

  private verifyAccessInState(accessToken: string, state: State): AccessPayload {
    const parts = accessToken.split('.')
    if (parts.length !== 2) throw new AuthError(401, 'invalid_access')
    const [encoded, signature] = parts
    const expected = createHmac('sha256', this.options.signingKey).update(encoded).digest('base64url')
    if (!safeEqual(signature, expected)) throw new AuthError(401, 'invalid_access')
    let payload: AccessPayload
    try { payload = JSON.parse(unb64(encoded)) as AccessPayload } catch { throw new AuthError(401, 'invalid_access') }
    if (!isAccessPayload(payload, this.audience, this.now())) throw new AuthError(401, 'invalid_access')
    const session = sessionFor(state, payload.sid)
    if (!session || session.revoked || session.expiresAt <= this.now() || session.principalId !== payload.pid || session.installationId !== payload.iid || !isSessionAllowed(state, session)) throw new AuthError(401, 'invalid_access')
    return payload
  }

  private mutate<T>(operation: (state: State) => T): T {
    return this.options.store.withLock(() => {
      const state = this.readState()
      const before = JSON.stringify(state)
      let result: T | undefined
      let failure: unknown
      try { result = operation(state) } catch (error) { failure = error }
      if (JSON.stringify(state) !== before) {
        state.revision += 1
        this.options.store.save(state)
      }
      if (failure) throw failure
      return result as T
    })
  }

  private readState(): State {
    const state = this.options.store.load() ?? emptyState()
    assertState(state)
    return state
  }
}

function applyProvisioning(state: State, license: LicenseProvisioning): void {
  const existing = entitlementFor(state, license.licenseKey)
  if (!existing) {
    state.entitlements.push({ licenseKey: license.licenseKey, principalId: license.principalId, active: license.active, deviceLimit: license.deviceLimit, authorityRevision: license.revision })
    return
  }
  if (license.revision < existing.authorityRevision) throw new Error('License provisioning revision regressed')
  if (license.revision === existing.authorityRevision) {
    if (existing.principalId !== license.principalId || existing.active !== license.active || existing.deviceLimit !== license.deviceLimit) throw new Error('License provisioning revision conflicts')
    return
  }
  if (existing.principalId !== license.principalId) throw new Error('License principal cannot change')
  if (license.deviceLimit < activeRegistrations(state, license.principalId).length) throw new Error('License device limit is below active registrations')
  existing.active = license.active
  existing.deviceLimit = license.deviceLimit
  existing.authorityRevision = license.revision
  if (!license.active) revokeLicenseSessions(state, license.licenseKey)
}

function issue(state: State, signingKey: string, audience: string, accessTtlMs: number, refreshTtlMs: number, now: () => number, principalId: string, installationId: string, licenseKey: string): AuthTokens {
  const id = randomBytes(18).toString('base64url')
  const issuedAt = validDate(now(), 'clock')
  const expiresAt = issuedAt + accessTtlMs
  const refreshSecret = randomToken()
  state.sessions.push({ id, principalId, installationId, licenseKey, expiresAt: issuedAt + refreshTtlMs, revoked: false, refreshHash: digest(refreshSecret) })
  const payload: AccessPayload = { v: 1, aud: audience, sid: id, pid: principalId, iid: installationId, exp: expiresAt }
  const encoded = b64(JSON.stringify(payload))
  const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url')
  return { accessToken: `${encoded}.${signature}`, refreshToken: `${id}.${refreshSecret}`, expiresAt, principalId, installationId }
}

function revokeRegistration(state: State, registration: InstallationRegistration): void {
  registration.revoked = true
  for (const session of state.sessions) if (session.installationId === registration.id) session.revoked = true
}
function revokeLicenseSessions(state: State, licenseKey: string): void { for (const session of state.sessions) if (session.licenseKey === licenseKey) session.revoked = true }
function entitlementFor(state: State, licenseKey: string): Entitlement | undefined { return state.entitlements.find(value => value.licenseKey === licenseKey) }
function registrationFor(state: State, installationId: string): InstallationRegistration | undefined { return state.registrations.find(value => value.id === installationId) }
function sessionFor(state: State, id: string): AuthSession | undefined { return state.sessions.find(value => value.id === id) }
function activeRegistrations(state: State, principalId: string): InstallationRegistration[] { return state.registrations.filter(value => value.principalId === principalId && !value.revoked) }
function isSessionAllowed(state: State, session: AuthSession): boolean {
  const entitlement = entitlementFor(state, session.licenseKey)
  const registration = registrationFor(state, session.installationId)
  return !!entitlement && entitlement.principalId === session.principalId && entitlement.active && !!registration && !registration.revoked && registration.principalId === session.principalId
}
function refreshSession(state: State, refreshToken: string): AuthSession | undefined {
  const [id, secret, extra] = refreshToken.split('.')
  if (!id || !secret || extra !== undefined || !opaqueIdPattern.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined
  const session = sessionFor(state, id)
  return session && safeEqual(session.refreshHash, digest(secret)) ? session : undefined
}
function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
function positiveInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`); return value }
function validDate(value: number, name: string): number { if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a valid date`); return value }
function chmodOwnerOnly(path: string, mode: number): void { try { if (process.platform !== 'win32') chmodSync(path, mode) } catch { /* Windows permissions are deployment-managed. */ } }
function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function assertProvisioning(value: LicenseProvisioning): void {
  if (!value || typeof value !== 'object' || typeof value.licenseKey !== 'string' || typeof value.principalId !== 'string' || !licensePattern.test(value.licenseKey) || !principalPattern.test(value.principalId) || typeof value.active !== 'boolean' || !Number.isSafeInteger(value.deviceLimit) || value.deviceLimit <= 0 || !Number.isSafeInteger(value.revision) || value.revision <= 0) throw new Error('Invalid license provisioning')
}
function assertState(state: unknown): asserts state is State {
  if (!isRecord(state) || Object.keys(state).length !== 5 || state.version !== 1 || !isDate(state.revision) || !Array.isArray(state.entitlements) || !Array.isArray(state.registrations) || !Array.isArray(state.sessions)) throw new Error('Gateway authority state is invalid')
  const entitlements = new Set<string>(); const registrations = new Set<string>(); const sessions = new Set<string>()
  for (const item of state.entitlements) {
    if (!isRecord(item) || Object.keys(item).length !== 5 || !matches(licensePattern, item.licenseKey) || !matches(principalPattern, item.principalId) || typeof item.active !== 'boolean' || !isPositiveSafeInteger(item.deviceLimit) || !isPositiveSafeInteger(item.authorityRevision) || entitlements.has(item.licenseKey)) throw new Error('Gateway authority state is invalid')
    entitlements.add(item.licenseKey)
  }
  for (const item of state.registrations) {
    if (!isRecord(item) || Object.keys(item).length !== 4 || !matches(installationPattern, item.id) || !matches(principalPattern, item.principalId) || typeof item.revoked !== 'boolean' || !isDate(item.createdAt) || registrations.has(item.id)) throw new Error('Gateway authority state is invalid')
    registrations.add(item.id)
  }
  for (const item of state.sessions) {
    if (!isRecord(item) || Object.keys(item).length !== 7 || !matches(opaqueIdPattern, item.id) || !matches(principalPattern, item.principalId) || !matches(installationPattern, item.installationId) || !matches(licensePattern, item.licenseKey) || !isDate(item.expiresAt) || typeof item.revoked !== 'boolean' || !matches(hashPattern, item.refreshHash) || sessions.has(item.id)) throw new Error('Gateway authority state is invalid')
    if (!entitlements.has(item.licenseKey) || !registrations.has(item.installationId)) throw new Error('Gateway authority state is invalid')
    sessions.add(item.id)
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isPositiveSafeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 }
function isDate(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isAccessPayload(value: unknown, audience: string, now: number): value is AccessPayload { return isRecord(value) && value.v === 1 && value.aud === audience && matches(opaqueIdPattern, value.sid) && matches(principalPattern, value.pid) && matches(installationPattern, value.iid) && isDate(value.exp) && value.exp > now }
function matches(pattern: RegExp, value: unknown): value is string { return typeof value === 'string' && pattern.test(value) }

export function parseLicenseProvisioning(raw: string | undefined): LicenseProvisioning[] {
  if (raw === undefined || raw === '') return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Invalid GW_LICENSE_PROVISIONING') }
  if (!Array.isArray(parsed)) throw new Error('GW_LICENSE_PROVISIONING must be an array')
  return parsed.map(item => {
    if (!isRecord(item) || Object.keys(item).length !== 5) throw new Error('Invalid GW_LICENSE_PROVISIONING')
    const value: LicenseProvisioning = { licenseKey: item.licenseKey as string, principalId: item.principalId as string, deviceLimit: item.deviceLimit as number, active: item.active as boolean, revision: item.revision as number }
    assertProvisioning(value)
    return value
  })
}
