import { createHash, timingSafeEqual } from 'node:crypto'
import { LEGACY_DEFERRED_ENVELOPE, type PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'

function digest(value: Omit<PermissionExecutionEnvelope, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createLegacyDeferredEnvelope(): PermissionExecutionEnvelope {
  return { ...LEGACY_DEFERRED_ENVELOPE, digest: digest(LEGACY_DEFERRED_ENVELOPE) }
}

/** Module 08 owns any non-legacy policy mapping; this boundary only verifies it. */
export function verifyPermissionExecutionEnvelope(value: unknown): value is PermissionExecutionEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort()
  if (keys.join(',') !== 'approval_policy,digest,mode,network_scope,reviewer,sandbox_profile,version') return false
  if (input.version !== 1 || !['legacy_deferred', 'policy_bound'].includes(input.mode as string) || !['workspace', 'unrestricted'].includes(input.sandbox_profile as string) || !['user_reviewer', 'automatic_reviewer'].includes(input.approval_policy as string) || !['user', 'automatic'].includes(input.reviewer as string) || !['denied', 'approved', 'unrestricted'].includes(input.network_scope as string) || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) return false
  const body = { version: input.version as 1, mode: input.mode as PermissionExecutionEnvelope['mode'], sandbox_profile: input.sandbox_profile as PermissionExecutionEnvelope['sandbox_profile'], approval_policy: input.approval_policy as PermissionExecutionEnvelope['approval_policy'], reviewer: input.reviewer as PermissionExecutionEnvelope['reviewer'], network_scope: input.network_scope as PermissionExecutionEnvelope['network_scope'] }
  const expected = Buffer.from(digest(body), 'hex'); const actual = Buffer.from(input.digest, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false
  return input.mode !== 'legacy_deferred' || (input.sandbox_profile === 'workspace' && input.approval_policy === 'user_reviewer' && input.reviewer === 'user' && input.network_scope === 'denied')
}
