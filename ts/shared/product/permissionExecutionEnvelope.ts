export type PermissionExecutionEnvelope = {
  version: 1
  mode: 'legacy_deferred' | 'policy_bound'
  sandbox_profile: 'workspace' | 'unrestricted'
  approval_policy: 'user_reviewer' | 'automatic_reviewer' | 'never'
  reviewer: 'user' | 'automatic' | 'none'
  network_scope: 'denied' | 'approved' | 'unrestricted'
  digest: string
}

export const LEGACY_DEFERRED_ENVELOPE = {
  version: 1,
  mode: 'legacy_deferred',
  sandbox_profile: 'workspace',
  approval_policy: 'user_reviewer',
  reviewer: 'user',
  network_scope: 'denied',
} as const
