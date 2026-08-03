import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Database } from 'bun:sqlite'

export type RemoteIdentity = { principalId: string, installationId: string }

export type RemoteHostCommand =
  | { id: string, type: 'start_turn', threadId: string, cwd: string, text: string, createdAt: number }
  | { id: string, type: 'steer_turn', threadId: string, turnId: string, text: string, createdAt: number }

export type RemoteHostCommandInput =
  | { type: 'start_turn', threadId: string, cwd: string, text: string }
  | { type: 'steer_turn', threadId: string, turnId: string, text: string }

type PairingRow = {
  code_hash: string
  host_installation_id: string
  host_principal_id: string
  expires_at: number
  claimed_by_installation_id: string | null
  claimed_by_principal_id: string | null
  claimed_at: number | null
}

type GrantRow = {
  host_installation_id: string
  controller_installation_id: string
  controller_principal_id: string
  created_at: number
  revoked_at: number | null
}

type CommandRow = {
  command_id: string
  host_installation_id: string
  controller_installation_id: string
  controller_principal_id: string
  type: string
  payload_json: string
  created_at: number
  expires_at: number
  claimed_at: number | null
  completed_at: number | null
  status: string | null
}

const INSTALLATION = /^[A-Za-z0-9._-]{8,128}$/
const THREAD = /^[A-Za-z0-9_-]{1,200}$/
const TURN = /^[A-Za-z0-9_-]{1,200}$/
const PAIRING_TTL_MS = 10 * 60_000
const COMMAND_TTL_MS = 10 * 60_000
const MAX_PENDING_COMMANDS = 64

function requireInstallation(value: string): void {
  if (!INSTALLATION.test(value)) throw new RemoteHostError(400, 'REMOTE_INSTALLATION_INVALID')
}

function nowTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Remote Host clock is invalid')
  return value
}

function codeHash(code: string): string { return createHash('sha256').update(code).digest('base64url') }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class RemoteHostError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

/**
 * Durable, minimal pairing registry for BilliardBuddy Remote Host.
 *
 * This is intentionally a transport-neutral authority. It stores no model
 * credentials, files, screenshots, Browser cookies, Rust Thread history or
 * tool output. A paired controller can enqueue only typed prompts/steering;
 * the desktop Host remains the place where Core, plugins and approvals run.
 */
export class SqliteRemoteHostRegistry {
  private readonly db: Database
  private readonly now: () => number

  constructor(options: { dbPath: string, now?: () => number }) {
    this.now = options.now ?? Date.now
    this.db = new Database(options.dbPath)
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_host_pairings_v1(
      code_hash TEXT PRIMARY KEY,
      host_installation_id TEXT NOT NULL,
      host_principal_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_by_installation_id TEXT,
      claimed_by_principal_id TEXT,
      claimed_at INTEGER
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_host_grants_v1(
      host_installation_id TEXT NOT NULL,
      controller_installation_id TEXT NOT NULL,
      controller_principal_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY(host_installation_id, controller_installation_id)
    )`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_host_commands_v1(
      command_id TEXT PRIMARY KEY,
      host_installation_id TEXT NOT NULL,
      controller_installation_id TEXT NOT NULL,
      controller_principal_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER,
      status TEXT
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS remote_host_pairings_by_expiry_v1 ON remote_host_pairings_v1(expires_at)')
    this.db.exec('CREATE INDEX IF NOT EXISTS remote_host_commands_by_host_v1 ON remote_host_commands_v1(host_installation_id, claimed_at, expires_at)')
  }

  createPairing(host: RemoteIdentity, ttlMs = PAIRING_TTL_MS): { pairingCode: string, expiresAt: number } {
    requireInstallation(host.installationId)
    const now = this.nowValue()
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > PAIRING_TTL_MS) throw new RemoteHostError(400, 'REMOTE_PAIRING_TTL_INVALID')
    const pairingCode = randomBytes(18).toString('base64url')
    this.transaction(() => {
      this.prune(now)
      this.db.query(`INSERT INTO remote_host_pairings_v1(
        code_hash,host_installation_id,host_principal_id,expires_at,claimed_by_installation_id,claimed_by_principal_id,claimed_at
      ) VALUES(?,?,?,?,NULL,NULL,NULL)`).run(codeHash(pairingCode), host.installationId, host.principalId, now + ttlMs)
    })
    return { pairingCode, expiresAt: now + ttlMs }
  }

  claimPairing(controller: RemoteIdentity, pairingCode: string): { hostInstallationId: string } {
    requireInstallation(controller.installationId)
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(pairingCode)) throw new RemoteHostError(400, 'REMOTE_PAIRING_CODE_INVALID')
    return this.transaction(() => {
      const now = this.nowValue()
      this.prune(now)
      const row = this.db.query('SELECT * FROM remote_host_pairings_v1 WHERE code_hash=?').get(codeHash(pairingCode)) as PairingRow | null
      if (!row || row.expires_at <= now || !safeEqual(row.code_hash, codeHash(pairingCode))) throw new RemoteHostError(404, 'REMOTE_PAIRING_NOT_FOUND')
      if (row.claimed_by_installation_id || row.host_installation_id === controller.installationId) throw new RemoteHostError(409, 'REMOTE_PAIRING_UNAVAILABLE')
      this.db.query(`INSERT INTO remote_host_grants_v1(host_installation_id,controller_installation_id,controller_principal_id,created_at,revoked_at)
        VALUES(?,?,?,?,NULL)
        ON CONFLICT(host_installation_id,controller_installation_id) DO UPDATE SET controller_principal_id=excluded.controller_principal_id,created_at=excluded.created_at,revoked_at=NULL`)
        .run(row.host_installation_id, controller.installationId, controller.principalId, now)
      const updated = this.db.query(`UPDATE remote_host_pairings_v1
        SET claimed_by_installation_id=?,claimed_by_principal_id=?,claimed_at=?
        WHERE code_hash=? AND claimed_by_installation_id IS NULL`).run(controller.installationId, controller.principalId, now, row.code_hash)
      if (updated.changes !== 1) throw new RemoteHostError(409, 'REMOTE_PAIRING_UNAVAILABLE')
      return { hostInstallationId: row.host_installation_id }
    })
  }

  listControllers(host: RemoteIdentity): Array<{ installationId: string, createdAt: number }> {
    requireInstallation(host.installationId)
    const now = this.nowValue()
    this.prune(now)
    return (this.db.query(`SELECT controller_installation_id,created_at FROM remote_host_grants_v1
      WHERE host_installation_id=? AND revoked_at IS NULL ORDER BY created_at DESC`).all(host.installationId) as Array<{ controller_installation_id: string, created_at: number }>)
      .map(row => ({ installationId: row.controller_installation_id, createdAt: row.created_at }))
  }

  revokeController(host: RemoteIdentity, controllerInstallationId: string): void {
    requireInstallation(host.installationId)
    requireInstallation(controllerInstallationId)
    const changed = this.db.query(`UPDATE remote_host_grants_v1 SET revoked_at=?
      WHERE host_installation_id=? AND controller_installation_id=? AND revoked_at IS NULL`).run(this.nowValue(), host.installationId, controllerInstallationId)
    if (changed.changes !== 1) throw new RemoteHostError(404, 'REMOTE_CONTROLLER_NOT_FOUND')
  }

  enqueue(controller: RemoteIdentity, hostInstallationId: string, command: RemoteHostCommandInput): { commandId: string } {
    requireInstallation(controller.installationId)
    requireInstallation(hostInstallationId)
    const now = this.nowValue()
    const normalized = validateCommand(command)
    this.transaction(() => {
      this.prune(now)
      const grant = this.db.query(`SELECT * FROM remote_host_grants_v1
        WHERE host_installation_id=? AND controller_installation_id=? AND revoked_at IS NULL`).get(hostInstallationId, controller.installationId) as GrantRow | null
      if (!grant || grant.controller_principal_id !== controller.principalId) throw new RemoteHostError(403, 'REMOTE_HOST_NOT_PAIRED')
      const pending = this.db.query(`SELECT COUNT(*) AS count FROM remote_host_commands_v1
        WHERE host_installation_id=? AND claimed_at IS NULL AND expires_at>?`).get(hostInstallationId, now) as { count: number }
      if (pending.count >= MAX_PENDING_COMMANDS) throw new RemoteHostError(429, 'REMOTE_HOST_QUEUE_FULL')
      this.db.query(`INSERT INTO remote_host_commands_v1(
        command_id,host_installation_id,controller_installation_id,controller_principal_id,type,payload_json,created_at,expires_at,claimed_at,completed_at,status
      ) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL)`).run(
        normalized.id, hostInstallationId, controller.installationId, controller.principalId,
        normalized.type, JSON.stringify(normalized), now, now + COMMAND_TTL_MS,
      )
    })
    return { commandId: normalized.id }
  }

  claimCommands(host: RemoteIdentity, limit = 16): RemoteHostCommand[] {
    requireInstallation(host.installationId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) throw new RemoteHostError(400, 'REMOTE_COMMAND_LIMIT_INVALID')
    return this.transaction(() => {
      const now = this.nowValue()
      this.prune(now)
      const rows = this.db.query(`SELECT * FROM remote_host_commands_v1
        WHERE host_installation_id=? AND claimed_at IS NULL AND expires_at>? ORDER BY created_at ASC LIMIT ?`).all(host.installationId, now, limit) as CommandRow[]
      const commands: RemoteHostCommand[] = []
      for (const row of rows) {
        const changed = this.db.query(`UPDATE remote_host_commands_v1 SET claimed_at=?
          WHERE command_id=? AND host_installation_id=? AND claimed_at IS NULL`).run(now, row.command_id, host.installationId)
        if (changed.changes !== 1) continue
        commands.push(commandFromRow(row))
      }
      return commands
    })
  }

  completeCommand(host: RemoteIdentity, commandId: string, status: 'completed' | 'rejected' | 'failed'): void {
    requireInstallation(host.installationId)
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(commandId)) throw new RemoteHostError(400, 'REMOTE_COMMAND_ID_INVALID')
    const changed = this.db.query(`UPDATE remote_host_commands_v1 SET completed_at=?,status=?
      WHERE command_id=? AND host_installation_id=? AND claimed_at IS NOT NULL AND completed_at IS NULL`).run(this.nowValue(), status, commandId, host.installationId)
    if (changed.changes !== 1) throw new RemoteHostError(404, 'REMOTE_COMMAND_NOT_FOUND')
  }

  private nowValue(): number { return nowTimestamp(this.now()) }

  private prune(now: number): void {
    this.db.query('DELETE FROM remote_host_pairings_v1 WHERE expires_at<=?').run(now)
    this.db.query('DELETE FROM remote_host_commands_v1 WHERE expires_at<=? OR completed_at IS NOT NULL').run(now)
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}

function validateCommand(value: RemoteHostCommandInput): RemoteHostCommand {
  const id = randomBytes(18).toString('base64url')
  const createdAt = 0
  if (value.type === 'start_turn') {
    if (!THREAD.test(value.threadId) || typeof value.cwd !== 'string' || value.cwd.length === 0 || value.cwd.length > 4_096 || /[\u0000\r\n]/.test(value.cwd) || typeof value.text !== 'string' || value.text.trim().length === 0 || value.text.length > 32_000 || value.text.includes('\u0000')) throw new RemoteHostError(400, 'REMOTE_COMMAND_INVALID')
    return { id, createdAt, type: 'start_turn', threadId: value.threadId, cwd: value.cwd, text: value.text }
  }
  if (value.type === 'steer_turn') {
    if (!THREAD.test(value.threadId) || !TURN.test(value.turnId) || typeof value.text !== 'string' || value.text.trim().length === 0 || value.text.length > 32_000 || value.text.includes('\u0000')) throw new RemoteHostError(400, 'REMOTE_COMMAND_INVALID')
    return { id, createdAt, type: 'steer_turn', threadId: value.threadId, turnId: value.turnId, text: value.text }
  }
  throw new RemoteHostError(400, 'REMOTE_COMMAND_INVALID')
}

function commandFromRow(row: CommandRow): RemoteHostCommand {
  let parsed: unknown
  try { parsed = JSON.parse(row.payload_json) } catch { throw new RemoteHostError(500, 'REMOTE_COMMAND_CORRUPT') }
  const command = validateCommand(parsed as RemoteHostCommandInput)
  return { ...command, id: row.command_id, createdAt: row.created_at }
}
