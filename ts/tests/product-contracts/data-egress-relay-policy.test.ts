import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, any>
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])]))
  }
  return value
}

function unsignedHash(document: Record<string, any>): string {
  const unsigned = { ...document }
  delete unsigned.sha256
  return createHash('sha256').update(`${JSON.stringify(stable(unsigned), null, 2)}\n`).digest('hex')
}

test('module 04 data egress and relay retention policies are registered and signed', () => {
  const source = json('ts/product-contracts/contract-source.json')
  expect(source.policy_schemas).toContainEqual(['data-egress-policy', '04'])
  expect(source.policy_schemas).toContainEqual(['relay-retention-policy', '04'])
  for (const path of [
    'ts/product-contracts/data-egress-policy.json',
    'ts/product-contracts/relay-retention-policy.json',
  ]) {
    const policy = json(path)
    expect(policy.owner_module).toBe('04')
    expect(policy.sha256).toBe(unsignedHash(policy))
  }
})

test('data egress and relay policy evidence points to runnable behavior tests', () => {
  for (const policyPath of [
    'ts/product-contracts/data-egress-policy.json',
    'ts/product-contracts/relay-retention-policy.json',
  ]) {
    const policy = json(policyPath)
    for (const evidence of policy.evidence as Array<{ path: string, test_id: string }>) {
      expect(readFileSync(resolve(root, evidence.path), 'utf8')).toContain(evidence.test_id)
    }
  }
})

test('account retention overrides and production invoice reconciliation remain externally unverified', () => {
  const egress = json('ts/product-contracts/data-egress-policy.json')
  expect(egress.external_verification).toEqual({
    openai_account_retention_override: 'NOT_VERIFIED_EXTERNALLY',
    ark_account_retention_term: 'NOT_VERIFIED_EXTERNALLY',
  })
  const relay = json('ts/product-contracts/relay-retention-policy.json')
  expect(relay.external_verification).toEqual({
    production_relay_storage: 'NOT_VERIFIED_EXTERNALLY',
    provider_invoice_reconciliation: 'NOT_VERIFIED_EXTERNALLY',
  })
})
