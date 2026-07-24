import { describe, expect, it } from 'bun:test'
import { productPermissionSnapshot } from '../../../shared/product/domain.js'
import {
  createPolicyBoundEnvelope,
  verifyPermissionExecutionEnvelope,
} from './permissionExecutionEnvelope.js'

describe('BB-08A policy-bound permission envelope', () => {
  it('keeps user and automatic review inside the same workspace sandbox', () => {
    const user = createPolicyBoundEnvelope(productPermissionSnapshot('ask_for_approval'))
    const automatic = createPolicyBoundEnvelope(productPermissionSnapshot('approve_for_me'))

    expect(user).toMatchObject({
      mode: 'policy_bound',
      sandbox_profile: 'workspace',
      approval_policy: 'user_reviewer',
      reviewer: 'user',
      network_scope: 'approved',
    })
    expect(automatic).toMatchObject({
      mode: 'policy_bound',
      sandbox_profile: 'workspace',
      approval_policy: 'automatic_reviewer',
      reviewer: 'automatic',
      network_scope: 'approved',
    })
    expect(verifyPermissionExecutionEnvelope(user)).toBeTrue()
    expect(verifyPermissionExecutionEnvelope(automatic)).toBeTrue()
  })

  it('binds full access to unrestricted execution with no routine reviewer', () => {
    const full = createPolicyBoundEnvelope(productPermissionSnapshot('full_access'))
    expect(full).toMatchObject({
      mode: 'policy_bound',
      sandbox_profile: 'unrestricted',
      approval_policy: 'never',
      reviewer: 'none',
      network_scope: 'unrestricted',
    })
    expect(verifyPermissionExecutionEnvelope(full)).toBeTrue()
    expect(verifyPermissionExecutionEnvelope({ ...full, sandbox_profile: 'workspace' })).toBeFalse()
    expect(verifyPermissionExecutionEnvelope({ ...full, approval_policy: 'user_reviewer' })).toBeFalse()
  })
})
