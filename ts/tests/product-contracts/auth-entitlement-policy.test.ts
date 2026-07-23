import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  REQUIRED_AUTH_POLICY_CONSTRAINTS,
  render,
  validate,
  validateAuthEntitlementPolicy,
  validateAuthEntitlementPolicyFile,
} from '../../scripts/product-contracts/check'

const sourcePath = path.resolve(import.meta.dir, '../../product-contracts/contract-source.json')
const policyPath = path.resolve(import.meta.dir, '../../product-contracts/auth-entitlement-policy.json')

function source() {
  return JSON.parse(readFileSync(sourcePath, 'utf8'))
}

function policy() {
  return JSON.parse(readFileSync(policyPath, 'utf8'))
}

test('auth entitlement policy is registered and validates with the product contracts', () => {
  const contractSource = source()
  expect(contractSource.auth_entitlement_policy.path).toBe('ts/product-contracts/auth-entitlement-policy.json')
  validate(contractSource, render(contractSource))
})

test('auth entitlement policy registration rejects a wrong path and a missing policy file', () => {
  const contractSource = source()
  contractSource.auth_entitlement_policy.path = 'ts/product-contracts/missing-auth-policy.json'
  expect(() => validate(contractSource, render(contractSource))).toThrow('auth entitlement policy path is invalid')
  const registered = source().auth_entitlement_policy
  expect(() => validateAuthEntitlementPolicyFile(registered, path.resolve(import.meta.dir, 'missing-auth-policy.json'))).toThrow('missing auth entitlement policy')
})

test('auth entitlement policy registers the concrete race evidence IDs', () => {
  const evidence = source().auth_entitlement_policy.required_evidence
  expect(evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ constraint: 'cross_process_transaction', test_id: 'a healthy multi-process lock survives longer than staleLockMs and a killed owner is reclaimed' }),
    expect.objectContaining({ constraint: 'host_env_scrub', path: 'ts/src/server/agent-worker/ipcLauncher.test.ts' }),
    expect.objectContaining({ constraint: 'refresh_proof_logout', test_id: 'uses the rotated refresh proof when logout races an in-flight refresh without updating the sidecar' }),
    expect.objectContaining({ constraint: 'sidecar_rotation', test_id: 'waits for the old child exit before spawning exactly one replacement' }),
  ]))
})

test('auth entitlement policy rejects hash tampering and a wrong owner', () => {
  const contractSource = source()
  const hashTampered = policy()
  hashTampered.sha256 = '0'.repeat(64)
  expect(() => validateAuthEntitlementPolicy(hashTampered, contractSource.auth_entitlement_policy)).toThrow('hash mismatch')

  const wrongOwner = policy()
  wrongOwner.owner_module = '99'
  expect(() => validateAuthEntitlementPolicy(wrongOwner, contractSource.auth_entitlement_policy)).toThrow('owner is invalid')
})

test('auth entitlement policy rejects each missing critical constraint and behavior evidence', () => {
  const contractSource = source()
  for (const constraint of REQUIRED_AUTH_POLICY_CONSTRAINTS) {
    const missingConstraint = policy()
    delete missingConstraint.constraints[constraint]
    expect(() => validateAuthEntitlementPolicy(missingConstraint, contractSource.auth_entitlement_policy)).toThrow(`missing constraint: ${constraint}`)

    const missingEvidence = policy()
    missingEvidence.evidence = missingEvidence.evidence.filter((entry: { constraint: string }) => entry.constraint !== constraint)
    expect(() => validateAuthEntitlementPolicy(missingEvidence, contractSource.auth_entitlement_policy)).toThrow('evidence drift')
  }
})
