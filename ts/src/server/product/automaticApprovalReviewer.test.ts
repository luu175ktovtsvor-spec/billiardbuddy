import { describe, expect, it } from 'bun:test'
import { reviewAutomaticApproval } from './automaticApprovalReviewer.js'
import { projectAgentWorkerApprovalReview } from './taskApprovalProjection.js'

describe('BB-08C independent automatic reviewer', () => {
  it('allows only non-destructive local read operations', () => {
    expect(reviewAutomaticApproval({ category: 'filesystem', read_only: true, destructive: false, open_world: false })).toEqual({ allowed: true, reason: 'read_only_local' })
    expect(reviewAutomaticApproval({ category: 'command', read_only: true, destructive: false, open_world: false })).toEqual({ allowed: true, reason: 'read_only_local' })
    expect(reviewAutomaticApproval({ category: 'filesystem', read_only: false, destructive: false, open_world: false })).toEqual({ allowed: false, reason: 'write_boundary' })
    expect(reviewAutomaticApproval({ category: 'network', read_only: true, destructive: false, open_world: true })).toEqual({ allowed: false, reason: 'data_egress' })
    expect(reviewAutomaticApproval({ category: 'command', read_only: true, destructive: true, open_world: false })).toEqual({ allowed: false, reason: 'destructive' })
    expect(reviewAutomaticApproval({ category: 'other', read_only: true, destructive: false, open_world: false })).toEqual({ allowed: false, reason: 'unknown_capability' })
  })

  it('derives only bounded risk facts and fails closed when a tool classifier throws', () => {
    const input = { command: 'PRIVATE_COMMAND', path: '/private/secret' }
    const facts = projectAgentWorkerApprovalReview({
      name: 'Bash',
      isReadOnly: () => true,
      isDestructive: () => false,
      isOpenWorld: () => false,
    }, input)
    expect(facts).toEqual({ category: 'command', read_only: true, destructive: false, open_world: false })
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_COMMAND')
    expect(projectAgentWorkerApprovalReview({
      name: 'Bash',
      isReadOnly: () => { throw new Error('classifier failed') },
      isDestructive: () => { throw new Error('classifier failed') },
      isOpenWorld: () => { throw new Error('classifier failed') },
    }, input)).toEqual({ category: 'command', read_only: false, destructive: true, open_world: false })
  })
})
