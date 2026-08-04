import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'

import { SqliteUsageBudgetService } from './usageBudget.ts'

const roots: string[] = []
const fingerprint = createHash('sha256').update('gateway usage account binding').digest('hex')
const amount = { requests: 1, input_bytes: 10, output_units: 2, total_tokens: 12 }
const input = (operationId: string, accountKey: string) => ({
  operation_id: operationId,
  principal_id: 'principal-account-audit',
  installation_id: 'installation-account-audit',
  capability: 'TextReasoning' as const,
  account_key: accountKey,
  fingerprint,
  amount,
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('DeepSeek flash and pro share one physical audit account, while a rebind fences an old operation', () => {
  const service = new SqliteUsageBudgetService(':memory:')
  const deepseekA = 'gateway-deepseek-account:deepseek-prod-a:binding-v1'
  const deepseekB = 'gateway-deepseek-account:deepseek-prod-b:binding-v2'

  // The catalog may select flash or pro, but both are one DeepSeek credential
  // account. Product quota remains principal/installation scoped, not model or
  // provider-account scoped.
  const flash = service.reserve(input('operation-deepseek-flash-0001', deepseekA))
  const pro = service.reserve(input('operation-deepseek-pro-00001', deepseekA))
  expect(flash.receipt.account_key).toBe(deepseekA)
  expect(pro.receipt.account_key).toBe(deepseekA)
  expect(service.summary('principal-account-audit', 'installation-account-audit').capabilities.TextReasoning.remaining_percent).toBeLessThan(100)

  expect(service.reserve(input('operation-deepseek-flash-0001', deepseekA))).toMatchObject({ duplicate: true })
  expect(() => service.reserve(input('operation-deepseek-flash-0001', deepseekB)))
    .toThrow('OPERATION_CONFLICT')
  // A rotation accepts new work under its new audit binding but cannot rewrite
  // or replay the historical account's operation.
  expect(service.reserve(input('operation-deepseek-newbind-0001', deepseekB)).receipt.account_key).toBe(deepseekB)
})

test('an old SQLite row stays permanently legacy and only permits exact duplicate replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billiardbuddy-usage-budget-legacy-'))
  roots.push(root)
  const path = join(root, 'gateway.db')
  const db = new Database(path)
  db.exec(`CREATE TABLE usage_budget_reservations(
    fencing_token INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL,
    principal_id TEXT NOT NULL, installation_id TEXT NOT NULL, capability TEXT NOT NULL, policy_revision TEXT NOT NULL,
    period TEXT NOT NULL, state TEXT NOT NULL, fingerprint TEXT NOT NULL, reserved_requests INTEGER NOT NULL,
    reserved_input_bytes INTEGER NOT NULL, reserved_output_units INTEGER NOT NULL, reserved_total_tokens INTEGER NOT NULL DEFAULT 0,
    actual_requests INTEGER NOT NULL DEFAULT 0, actual_input_bytes INTEGER NOT NULL DEFAULT 0,
    actual_output_units INTEGER NOT NULL DEFAULT 0, actual_total_tokens INTEGER NOT NULL DEFAULT 0, upstream_receipt_hash TEXT
  )`)
  const operation = 'operation-legacy-replay-0001'
  const key = createHash('sha256').update(`principal-account-audit\0${operation}`).digest('hex')
  db.query(`INSERT INTO usage_budget_reservations(
    operation_key,operation_id,principal_id,installation_id,capability,policy_revision,period,state,fingerprint,
    reserved_requests,reserved_input_bytes,reserved_output_units,reserved_total_tokens
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    key, operation, 'principal-account-audit', 'installation-account-audit', 'TextReasoning', 'legacy-v1', '2026-08-04', 'reserved', fingerprint,
    1, 10, 2, 12,
  )
  db.close()

  const service = new SqliteUsageBudgetService(path, undefined, () => Date.parse('2026-08-04T12:00:00.000Z'))
  const current = 'gateway-deepseek-account:deepseek-prod-a:binding-v2'
  const replay = service.reserve(input(operation, current))
  expect(replay).toMatchObject({ duplicate: true, receipt: { account_key: 'legacy:unbound' } })
  // A later credential cannot relabel the old paid operation; a replay does
  // not issue a provider request, so its current account key is irrelevant.
  expect(service.reserve(input(operation, 'gateway-deepseek-account:deepseek-prod-b:binding-v3')))
    .toMatchObject({ duplicate: true, receipt: { account_key: 'legacy:unbound' } })
  expect(() => service.reserve({ ...input(operation, current), fingerprint: 'b'.repeat(64) }))
    .toThrow('OPERATION_CONFLICT')
})
