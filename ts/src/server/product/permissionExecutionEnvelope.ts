import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { LEGACY_DEFERRED_ENVELOPE, type PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import type { ProductPermissionSnapshot } from '../../../shared/product/domain.js'

function digest(value: Omit<PermissionExecutionEnvelope, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createLegacyDeferredEnvelope(): PermissionExecutionEnvelope {
  return { ...LEGACY_DEFERRED_ENVELOPE, digest: digest(LEGACY_DEFERRED_ENVELOPE) }
}

export function createPolicyBoundEnvelope(
  snapshot: ProductPermissionSnapshot,
): PermissionExecutionEnvelope {
  const body: Omit<PermissionExecutionEnvelope, 'digest'> = {
    version: 1,
    mode: 'policy_bound',
    sandbox_profile: snapshot.sandbox === 'danger-full-access' ? 'unrestricted' : 'workspace',
    approval_policy: snapshot.approval === 'never'
      ? 'never'
      : snapshot.reviewer === 'automatic'
        ? 'automatic_reviewer'
        : 'user_reviewer',
    reviewer: snapshot.reviewer,
    network_scope: snapshot.sandbox === 'danger-full-access' ? 'unrestricted' : 'approved',
  }
  return { ...body, digest: digest(body) }
}

export type AgentWorkerChildStartCapability = { run_id: string; dispatch_generation: number; fencing_token: number; envelope_digest: string; execution_claim_token: string; signature: string }

function childStartPayload(value: Omit<AgentWorkerChildStartCapability, 'signature'>): string {
  return JSON.stringify([value.run_id, value.dispatch_generation, value.fencing_token, value.envelope_digest, value.execution_claim_token])
}

/** Server-private, signed hand-off. Its five bound values are all a child may use. */
export function createAgentWorkerChildStartCapability(value: Omit<AgentWorkerChildStartCapability, 'signature'>, key: Buffer): AgentWorkerChildStartCapability {
  return { ...value, signature: createHmac('sha256', key).update(childStartPayload(value)).digest('hex') }
}

export function verifyAgentWorkerChildStartCapability(value: unknown, key: Buffer): value is AgentWorkerChildStartCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const capability = value as Record<string, unknown>
  if (Object.keys(capability).sort().join(',') !== 'dispatch_generation,envelope_digest,execution_claim_token,fencing_token,run_id,signature' || typeof capability.run_id !== 'string' || !Number.isSafeInteger(capability.dispatch_generation) || (capability.dispatch_generation as number) < 1 || !Number.isSafeInteger(capability.fencing_token) || (capability.fencing_token as number) < 1 || typeof capability.envelope_digest !== 'string' || !/^[a-f0-9]{64}$/.test(capability.envelope_digest) || typeof capability.execution_claim_token !== 'string' || !/^[a-f0-9-]{36}$/.test(capability.execution_claim_token) || typeof capability.signature !== 'string' || !/^[a-f0-9]{64}$/.test(capability.signature)) return false
  const expected = Buffer.from(createHmac('sha256', key).update(childStartPayload(capability as AgentWorkerChildStartCapability)).digest('hex'), 'hex'); const actual = Buffer.from(capability.signature, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Module 08 owns any non-legacy policy mapping; this boundary only verifies it. */
export function verifyPermissionExecutionEnvelope(value: unknown): value is PermissionExecutionEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort()
  if (keys.join(',') !== 'approval_policy,digest,mode,network_scope,reviewer,sandbox_profile,version') return false
  if (input.version !== 1 || !['legacy_deferred', 'policy_bound'].includes(input.mode as string) || !['workspace', 'unrestricted'].includes(input.sandbox_profile as string) || !['user_reviewer', 'automatic_reviewer', 'never'].includes(input.approval_policy as string) || !['user', 'automatic', 'none'].includes(input.reviewer as string) || !['denied', 'approved', 'unrestricted'].includes(input.network_scope as string) || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) return false
  const body = { version: input.version as 1, mode: input.mode as PermissionExecutionEnvelope['mode'], sandbox_profile: input.sandbox_profile as PermissionExecutionEnvelope['sandbox_profile'], approval_policy: input.approval_policy as PermissionExecutionEnvelope['approval_policy'], reviewer: input.reviewer as PermissionExecutionEnvelope['reviewer'], network_scope: input.network_scope as PermissionExecutionEnvelope['network_scope'] }
  const expected = Buffer.from(digest(body), 'hex'); const actual = Buffer.from(input.digest, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
  if (input.mode === 'legacy_deferred') return input.sandbox_profile === 'workspace' && input.approval_policy === 'user_reviewer' && input.reviewer === 'user' && input.network_scope === 'denied'
  if (input.sandbox_profile === 'unrestricted') return input.approval_policy === 'never' && input.reviewer === 'none' && input.network_scope === 'unrestricted'
  return input.network_scope === 'approved' && (
    (input.approval_policy === 'user_reviewer' && input.reviewer === 'user')
    || (input.approval_policy === 'automatic_reviewer' && input.reviewer === 'automatic')
  )
}
