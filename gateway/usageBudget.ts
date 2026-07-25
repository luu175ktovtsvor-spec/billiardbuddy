import { createHash, randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'

import type {
  MeteredProviderCapability,
  ProviderUsageAmount,
  ProviderUsageBudgetPolicy,
  ProviderUsageReceipt,
} from '../ts/shared/product/providerContracts'

export type MeteredCapability = MeteredProviderCapability
export type UsageAmount = ProviderUsageAmount
export type UsageLimit = UsageAmount
export type UsageBudgetPolicy = ProviderUsageBudgetPolicy
export type UsageState = 'reserved' | 'settled' | 'released' | 'outcome_unknown'
export type UsageReceipt = ProviderUsageReceipt
export type UsageReservation = { duplicate: boolean; receipt: UsageReceipt }
export type UsageBudgetSummary = {
  period: string
  resets_at: string
  capabilities: Record<MeteredCapability, {
    remaining_percent: number
    exhausted: boolean
  }>
}
export type UsageReserveInput = {
  operation_id: string
  principal_id: string
  installation_id: string
  capability: MeteredCapability
  fingerprint: string
  amount: UsageAmount
}

export const DEFAULT_GATEWAY_USAGE_POLICY: UsageBudgetPolicy = {
  revision: 'bb-04d-gateway-v1',
  period: 'utc_day',
  capabilities: {
    TextReasoning: {
      principal: { requests: 100_000, input_bytes: 4 * 1024 ** 3, output_units: 100_000_000 },
      installation: { requests: 10_000, input_bytes: 1024 ** 3, output_units: 10_000_000 },
    },
    VisualEvidence: {
      principal: { requests: 20_000, input_bytes: 500 * 1024 ** 3, output_units: 20_000_000 },
      installation: { requests: 2_000, input_bytes: 50 * 1024 ** 3, output_units: 2_000_000 },
    },
    SpeechTranscription: {
      principal: { requests: 20_000, input_bytes: 500 * 1024 ** 3, output_units: 200_000_000 },
      installation: { requests: 2_000, input_bytes: 50 * 1024 ** 3, output_units: 20_000_000 },
    },
  },
}

export class UsageBudgetError extends Error {
  constructor(readonly status: number, readonly code: 'BUDGET_UNAVAILABLE' | 'USAGE_LIMIT_REACHED' | 'OPERATION_CONFLICT' | 'STALE_FENCING') {
    super(code)
    this.name = 'UsageBudgetError'
  }
}

export interface UsageBudgetService {
  policyRevision(): string
  summary(principalId: string, installationId: string): UsageBudgetSummary
  reserve(input: UsageReserveInput): UsageReservation
  settle(operationId: string, fencingToken: number, actual: UsageAmount, upstreamReceiptHash?: string): UsageReceipt
  release(operationId: string, fencingToken: number): UsageReceipt
  markOutcomeUnknown(operationId: string, fencingToken: number): UsageReceipt
}

type StoredUsage = UsageReceipt & { fingerprint: string }

function validInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validateAmount(amount: UsageAmount): void {
  if (!validInteger(amount.requests) || !validInteger(amount.input_bytes) || !validInteger(amount.output_units)) {
    throw new UsageBudgetError(503, 'BUDGET_UNAVAILABLE')
  }
}

function validatePolicy(policy: UsageBudgetPolicy): void {
  if (!policy.revision.trim() || policy.period !== 'utc_day') throw new UsageBudgetError(503, 'BUDGET_UNAVAILABLE')
  for (const capability of ['TextReasoning', 'VisualEvidence', 'SpeechTranscription'] as const) {
    const limits = policy.capabilities[capability]
    if (!limits) throw new UsageBudgetError(503, 'BUDGET_UNAVAILABLE')
    validateAmount(limits.principal)
    validateAmount(limits.installation)
  }
}

function validateReserveInput(input: UsageReserveInput): void {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.operation_id)
    || !input.principal_id || !input.installation_id
    || !/^[a-f0-9]{64}$/.test(input.fingerprint)) {
    throw new UsageBudgetError(409, 'OPERATION_CONFLICT')
  }
  validateAmount(input.amount)
  if (input.amount.requests !== 1) throw new UsageBudgetError(503, 'BUDGET_UNAVAILABLE')
}

function periodAt(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function add(left: UsageAmount, right: UsageAmount): UsageAmount {
  return {
    requests: left.requests + right.requests,
    input_bytes: left.input_bytes + right.input_bytes,
    output_units: left.output_units + right.output_units,
  }
}

function exceeds(value: UsageAmount, limit: UsageLimit): boolean {
  return value.requests > limit.requests
    || value.input_bytes > limit.input_bytes
    || value.output_units > limit.output_units
}

function reached(value: UsageAmount, limit: UsageLimit): boolean {
  return value.requests >= limit.requests
    || value.input_bytes >= limit.input_bytes
    || value.output_units >= limit.output_units
}

function remainingPercent(value: UsageAmount, limit: UsageLimit): number {
  const ratios = (['requests', 'input_bytes', 'output_units'] as const).map((key) => {
    if (limit[key] === 0) return 0
    return ((limit[key] - value[key]) / limit[key]) * 100
  })
  return Math.max(0, Math.min(100, Math.floor(Math.min(...ratios))))
}

function sameBinding(existing: StoredUsage, input: UsageReserveInput): boolean {
  return existing.principal_id === input.principal_id
    && existing.installation_id === input.installation_id
    && existing.capability === input.capability
    && existing.fingerprint === input.fingerprint
    && JSON.stringify(existing.reserved) === JSON.stringify(input.amount)
}

function operationKey(principalId: string, operationId: string): string {
  return usageFingerprint(`${principalId}\0${operationId}`)
}

function publicReceipt(row: StoredUsage): UsageReceipt {
  const { fingerprint: _fingerprint, ...receipt } = row
  return structuredClone(receipt)
}

type SqlRow = {
  operation_key: string; operation_id: string; principal_id: string; installation_id: string; capability: MeteredCapability
  policy_revision: string; period: string; state: UsageState; reserved_requests: number
  reserved_input_bytes: number; reserved_output_units: number; actual_requests: number
  actual_input_bytes: number; actual_output_units: number; fencing_token: number
  fingerprint: string; upstream_receipt_hash: string | null
}

function fromSql(row: SqlRow): StoredUsage {
  return {
    operation_id: row.operation_id, principal_id: row.principal_id, installation_id: row.installation_id,
    capability: row.capability, policy_revision: row.policy_revision, period: row.period, state: row.state,
    reserved: { requests: row.reserved_requests, input_bytes: row.reserved_input_bytes, output_units: row.reserved_output_units },
    actual: { requests: row.actual_requests, input_bytes: row.actual_input_bytes, output_units: row.actual_output_units },
    fencing_token: row.fencing_token, fingerprint: row.fingerprint,
    ...(row.upstream_receipt_hash ? { upstream_receipt_hash: row.upstream_receipt_hash } : {}),
  }
}

export class SqliteUsageBudgetService implements UsageBudgetService {
  private readonly db: Database
  constructor(path: string, private readonly policy: UsageBudgetPolicy = DEFAULT_GATEWAY_USAGE_POLICY, private readonly now: () => number = Date.now) {
    validatePolicy(policy)
    this.db = new Database(path)
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage_budget_reservations(
      fencing_token INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_key TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      policy_revision TEXT NOT NULL,
      period TEXT NOT NULL,
      state TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      reserved_requests INTEGER NOT NULL,
      reserved_input_bytes INTEGER NOT NULL,
      reserved_output_units INTEGER NOT NULL,
      actual_requests INTEGER NOT NULL DEFAULT 0,
      actual_input_bytes INTEGER NOT NULL DEFAULT 0,
      actual_output_units INTEGER NOT NULL DEFAULT 0,
      upstream_receipt_hash TEXT
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS usage_budget_period_principal ON usage_budget_reservations(period, principal_id)')
  }

  policyRevision(): string { return this.policy.revision }

  summary(principalId: string, installationId: string): UsageBudgetSummary {
    if (!principalId || !installationId) throw new UsageBudgetError(503, 'BUDGET_UNAVAILABLE')
    const period = periodAt(this.now())
    const rows = (this.db.query(
      'SELECT * FROM usage_budget_reservations WHERE period=? AND principal_id=? AND state<>\'released\'',
    ).all(period, principalId) as SqlRow[]).map(fromSql)
    const capabilities = Object.fromEntries(
      (['TextReasoning', 'VisualEvidence', 'SpeechTranscription'] as const).map((capability) => {
        const principal = { requests: 0, input_bytes: 0, output_units: 0 }
        const installation = { requests: 0, input_bytes: 0, output_units: 0 }
        for (const row of rows) {
          if (row.capability !== capability) continue
          const counted = row.state === 'settled' ? row.actual : row.reserved
          if (row.principal_id === principalId) Object.assign(principal, add(principal, counted))
          if (row.principal_id === principalId && row.installation_id === installationId) {
            Object.assign(installation, add(installation, counted))
          }
        }
        const limits = this.policy.capabilities[capability]
        return [capability, {
          remaining_percent: Math.min(
            remainingPercent(principal, limits.principal),
            remainingPercent(installation, limits.installation),
          ),
          exhausted: reached(principal, limits.principal) || reached(installation, limits.installation),
        }]
      }),
    ) as UsageBudgetSummary['capabilities']
    const resetsAt = new Date(Date.parse(`${period}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString()
    return { period, resets_at: resetsAt, capabilities }
  }

  reserve(input: UsageReserveInput): UsageReservation {
    validateReserveInput(input)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.getForReserve(input)
      if (existing) {
        if (!sameBinding(existing, input)) throw new UsageBudgetError(409, 'OPERATION_CONFLICT')
        this.db.exec('COMMIT')
        return { duplicate: true, receipt: publicReceipt(existing) }
      }
      const rows = this.db.query('SELECT * FROM usage_budget_reservations WHERE period=? AND capability=? AND state<>\'released\'').all(periodAt(this.now()), input.capability) as SqlRow[]
      this.assertWithinBudget(rows.map(fromSql), input)
      this.db.query(`INSERT INTO usage_budget_reservations(
        operation_key,operation_id,principal_id,installation_id,capability,policy_revision,period,state,fingerprint,
        reserved_requests,reserved_input_bytes,reserved_output_units
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        operationKey(input.principal_id, input.operation_id), input.operation_id, input.principal_id, input.installation_id, input.capability,
        this.policy.revision, periodAt(this.now()), 'reserved', input.fingerprint,
        input.amount.requests, input.amount.input_bytes, input.amount.output_units,
      )
      const row = this.getForReserve(input)!
      this.db.exec('COMMIT')
      return { duplicate: false, receipt: publicReceipt(row) }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  settle(operationId: string, fencingToken: number, actual: UsageAmount, upstreamReceiptHash?: string): UsageReceipt {
    return this.finalize(operationId, fencingToken, 'settled', actual, upstreamReceiptHash)
  }
  release(operationId: string, fencingToken: number): UsageReceipt {
    return this.finalize(operationId, fencingToken, 'released')
  }
  markOutcomeUnknown(operationId: string, fencingToken: number): UsageReceipt {
    return this.finalize(operationId, fencingToken, 'outcome_unknown')
  }
  private getForReserve(input: UsageReserveInput): StoredUsage | null {
    const row = this.db.query('SELECT * FROM usage_budget_reservations WHERE operation_key=?').get(operationKey(input.principal_id, input.operation_id)) as SqlRow | null
    return row ? fromSql(row) : null
  }
  private getForFinalize(operationId: string, fencingToken: number): StoredUsage | null {
    const row = this.db.query('SELECT * FROM usage_budget_reservations WHERE fencing_token=?').get(fencingToken) as SqlRow | null
    return row?.operation_id === operationId ? fromSql(row) : null
  }
  private assertWithinBudget(rows: Iterable<StoredUsage>, input: UsageReserveInput): void {
    const period = periodAt(this.now())
    const principal = { requests: 0, input_bytes: 0, output_units: 0 }
    const installation = { requests: 0, input_bytes: 0, output_units: 0 }
    for (const row of rows) {
      if (row.period !== period || row.capability !== input.capability || row.state === 'released') continue
      const counted = row.state === 'settled' ? row.actual : row.reserved
      if (row.principal_id === input.principal_id) Object.assign(principal, add(principal, counted))
      if (row.principal_id === input.principal_id && row.installation_id === input.installation_id) {
        Object.assign(installation, add(installation, counted))
      }
    }
    const limits = this.policy.capabilities[input.capability]
    if (exceeds(add(principal, input.amount), limits.principal)
      || exceeds(add(installation, input.amount), limits.installation)) {
      throw new UsageBudgetError(429, 'USAGE_LIMIT_REACHED')
    }
  }
  private finalizeRow(row: StoredUsage, fencingToken: number, state: UsageState, actual?: UsageAmount, upstreamReceiptHash?: string): UsageReceipt {
    if (row.fencing_token !== fencingToken) throw new UsageBudgetError(409, 'STALE_FENCING')
    if (row.state !== 'reserved') return publicReceipt(row)
    if (actual) validateAmount(actual)
    row.state = state
    row.actual = actual ? structuredClone(actual) : state === 'released' ? { requests: 0, input_bytes: 0, output_units: 0 } : structuredClone(row.reserved)
    if (upstreamReceiptHash) {
      if (!/^[a-f0-9]{64}$/.test(upstreamReceiptHash)) throw new UsageBudgetError(503, 'BUDGET_UNAVAILABLE')
      row.upstream_receipt_hash = upstreamReceiptHash
    }
    return publicReceipt(row)
  }
  private finalize(operationId: string, fencingToken: number, state: UsageState, actual?: UsageAmount, upstreamReceiptHash?: string): UsageReceipt {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.getForFinalize(operationId, fencingToken)
      if (!row) throw new UsageBudgetError(409, 'STALE_FENCING')
      const receipt = this.finalizeRow(row, fencingToken, state, actual, upstreamReceiptHash)
      this.db.query(`UPDATE usage_budget_reservations SET state=?,actual_requests=?,actual_input_bytes=?,actual_output_units=?,upstream_receipt_hash=? WHERE operation_id=? AND fencing_token=?`).run(
        receipt.state, receipt.actual.requests, receipt.actual.input_bytes, receipt.actual.output_units,
        receipt.upstream_receipt_hash ?? null, operationId, fencingToken,
      )
      this.db.exec('COMMIT')
      return receipt
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

export function usageFingerprint(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function fileUsageFingerprint(file: File): Promise<string> {
  const hash = createHash('sha256')
  const reader = file.stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    hash.update(value)
  }
  return hash.digest('hex')
}

export function usageOperationId(request: Request): string {
  const supplied = request.headers.get('x-bb-operation-id')?.trim()
    || request.headers.get('idempotency-key')?.trim()
  return supplied || `gateway:${randomBytes(18).toString('base64url')}`
}
