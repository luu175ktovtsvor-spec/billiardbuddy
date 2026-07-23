import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  REMOTE_DATA_EGRESS_POLICY_REVISION,
} from '../../shared/product/dataEgress'
import { PROVIDER_GATEWAY_PROTOCOL_VALUE as gatewayProtocol } from '../../../gateway/app'
import { PROVIDER_GATEWAY_PROTOCOL_VALUE as relayProtocol } from '../../../relay/app'

const root = resolve(import.meta.dir, '../../..')
const manifestPath = resolve(root, 'ts/product-contracts/provider-deployment-manifest.json')

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, stable(record[key])]))
  }
  return value
}

test('provider deployment manifest is signed and every component uses the same protocol', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
  const unsigned = { ...manifest }
  delete unsigned.sha256
  expect(manifest.sha256).toBe(createHash('sha256').update(`${JSON.stringify(stable(unsigned), null, 2)}\n`).digest('hex'))
  expect(manifest.protocol.header_value).toBe(PROVIDER_GATEWAY_PROTOCOL.headerValue)
  expect(gatewayProtocol).toBe(PROVIDER_GATEWAY_PROTOCOL.headerValue)
  expect(relayProtocol).toBe(PROVIDER_GATEWAY_PROTOCOL.headerValue)
  expect(readFileSync(resolve(root, 'gateway/deploy.sh'), 'utf8')).toContain('qf-gateway component manifest incompatible')
  expect(readFileSync(resolve(root, 'relay/deploy.sh'), 'utf8')).toContain('qf-relay component manifest incompatible')
})

test('deployment manifest binds every policy hash and the current managed consent revision', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>
  for (const [policyName, expectedHash] of Object.entries(manifest.policy_hashes as Record<string, string>)) {
    const policy = JSON.parse(readFileSync(resolve(root, `ts/product-contracts/${policyName}.json`), 'utf8')) as { sha256: string }
    expect(policy.sha256, policyName).toBe(expectedHash)
  }
  const dataEgress = JSON.parse(readFileSync(resolve(root, 'ts/product-contracts/data-egress-policy.json'), 'utf8')) as Record<string, any>
  expect(dataEgress.managed_remote_consent.policy_revision).toBe(REMOTE_DATA_EGRESS_POLICY_REVISION)
})
