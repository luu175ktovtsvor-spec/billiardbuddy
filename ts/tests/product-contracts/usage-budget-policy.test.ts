import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFAULT_GATEWAY_USAGE_POLICY } from '../../../gateway/usageBudget'

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

test('usage budget policy is the module 04 policy and matches the Gateway registry', () => {
  const source = json('ts/product-contracts/contract-source.json')
  expect(source.policy_schemas).toContainEqual(['usage-budget-policy', '04'])
  const policy = json('ts/product-contracts/usage-budget-policy.json')
  expect(policy).toMatchObject({
    policy_schema_version: 1,
    policy_revision: DEFAULT_GATEWAY_USAGE_POLICY.revision,
    owner_module: '04',
    period: DEFAULT_GATEWAY_USAGE_POLICY.period,
    capabilities: DEFAULT_GATEWAY_USAGE_POLICY.capabilities,
  })
  expect(policy.sha256).toBe(unsignedHash(policy))
})

test('usage budget policy evidence points to runnable behavior tests', () => {
  const policy = json('ts/product-contracts/usage-budget-policy.json')
  for (const evidence of policy.evidence as Array<{ path: string; test_id: string }>) {
    const source = readFileSync(resolve(root, evidence.path), 'utf8')
    expect(source).toContain(evidence.test_id)
  }
  expect(policy.external_verification).toEqual({
    provider_invoice_reconciliation: 'NOT_VERIFIED_EXTERNALLY',
    production_plan_limits: 'NOT_VERIFIED_EXTERNALLY',
  })
})

test('gateway resource profile is signed and does not claim production capacity', () => {
  const profile = json('ts/product-contracts/gateway-resource-profile.json')
  expect(profile).toMatchObject({
    profile_schema_version: 1,
    profile_revision: DEFAULT_GATEWAY_USAGE_POLICY.revision,
    owner_module: '04',
    scope: 'gateway-account',
    status: 'local_fake_verified',
    production_capacity: 'NOT_VERIFIED_EXTERNALLY',
  })
  expect(profile.resources.SpeechTranscription).toEqual({
    max_active: 1,
    max_active_per_installation: 1,
    max_queued: 12,
  })
  expect(profile.sha256).toBe(unsignedHash(profile))
})
