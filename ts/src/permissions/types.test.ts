import { expect, test } from 'bun:test'
import type { PermissionDecision, PermissionMode } from './types'

test('PermissionDecision 三态可构造,behavior 判别可用', () => {
  const modes: PermissionMode[] = ['ask', 'auto_files', 'full', 'plan', 'bypassPermissions']
  expect(modes.length).toBe(5)
  const decisions: PermissionDecision[] = [
    { behavior: 'allow', reason: { type: 'mode', mode: 'full' } },
    { behavior: 'ask', message: 'x', approvalClass: 'outreach', reason: { type: 'forceConfirm' } },
    { behavior: 'ask', message: 'z', reason: { type: 'requiresUserInteraction' } },
    { behavior: 'deny', message: 'y', reason: { type: 'fatal', text: '删根' } },
  ]
  expect(decisions.map(d => d.behavior)).toEqual(['allow', 'ask', 'ask', 'deny'])
})
