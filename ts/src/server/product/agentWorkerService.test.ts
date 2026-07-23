import { describe, expect, test } from 'bun:test'
import { AgentWorkerService } from './agentWorkerService.js'
import { createLegacyDeferredEnvelope } from './permissionExecutionEnvelope.js'

const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['agent.worker'] as const, fencing_token: 1, lease: { owner_id: 'owner', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }

test('worker claims only existing dispatch after an admitted scheduler receipt and never resends input', async () => {
  const calls: string[] = []
  const service = new AgentWorkerService({ readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }), claimTaskRunDispatch: async () => { calls.push('claim'); return { outcome: 'claimed', task_id: 'task' } } }, { start: async () => ({ input: async text => { calls.push(`input:${text}`) }, approve: async () => {}, stop: async () => {}, shutdown: async () => {} }) })
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: createLegacyDeferredEnvelope() })).toMatchObject({ type: 'claim_receipt', outcome: 'claimed' })
  expect(await service.input('user turn')).toBeUndefined(); expect(calls).toEqual(['claim', 'input:user turn'])
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: createLegacyDeferredEnvelope() })).toMatchObject({ type: 'fatal', code: 'ENVELOPE_DENIED' })
})

test('worker rejects an inconsistent, expired, or foreign scheduler receipt before dispatch claim', async () => {
  let claims = 0; const service = new AgentWorkerService({ readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed', task_id: 'task' } } }, { start: async () => { throw new Error('must not start') } }, () => new Date('2026-01-01T00:00:00.000Z'))
  for (const bad of [{ ...receipt, job_id: 'other' }, { ...receipt, lease: { ...receipt.lease, fencing_token: 2 } }, { ...receipt, lease: { ...receipt.lease, expires_at: '2025-01-01T00:00:00.000Z' } }]) expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: bad, envelope: createLegacyDeferredEnvelope() })).toMatchObject({ type: 'fatal', code: 'SCHEDULER_DENIED' })
  expect(claims).toBe(0)
})

test('worker rejects forged legacy envelopes before durable claim', async () => {
  let claims = 0
  const service = new AgentWorkerService({ readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed', task_id: 'task' } } }, { start: async () => { throw new Error('must not start') } })
  const forged = { ...createLegacyDeferredEnvelope(), network_scope: 'unrestricted' as const }
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: forged })).toMatchObject({ type: 'fatal', code: 'ENVELOPE_DENIED' }); expect(claims).toBe(0)
})
