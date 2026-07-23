import { expect, test } from 'bun:test'
import { AgentWorkerService, type AgentWorkerCoreFactory } from './agentWorkerService.js'
import { createAgentWorkerChildStartCapability, createLegacyDeferredEnvelope } from './permissionExecutionEnvelope.js'

const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['agent.worker'] as const, fencing_token: 1, lease: { owner_id: 'owner', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }

function bootstrap(cores: AgentWorkerCoreFactory, overrides: Partial<{ run_id: string; dispatch_generation: number; fencing_token: number; envelope_digest: string }> = {}) {
  const envelope = createLegacyDeferredEnvelope(); const key = Buffer.alloc(32, 7)
  const value = { run_id: 'run', dispatch_generation: 1, fencing_token: 1, envelope_digest: envelope.digest, ...overrides }
  return { capability: createAgentWorkerChildStartCapability(value, key), capability_key: key, cores, envelope }
}

test('worker consumes one supervisor-issued capability and never claims or replays input', async () => {
  const calls: string[] = []; const prepared = bootstrap({ start: async () => ({ input: async text => { calls.push(`input:${text}`) }, approve: async () => {}, stop: async () => {}, shutdown: async () => {} }) })
  const service = new AgentWorkerService(prepared)
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })).toMatchObject({ type: 'claim_receipt', outcome: 'claimed' })
  expect(await service.input('user turn')).toBeUndefined(); expect(calls).toEqual(['input:user turn'])
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })).toMatchObject({ type: 'fatal', code: 'ENVELOPE_DENIED' })
})

test('worker rejects forged, cross-run, and expired receipt bootstrap before Core start', async () => {
  let starts = 0; const cores = { start: async () => { starts++; throw new Error('must not start') } }; const prepared = bootstrap(cores)
  const service = new AgentWorkerService(prepared, () => new Date('2026-01-01T00:00:00.000Z'))
  for (const bad of [
    { type: 'start' as const, run_id: 'other', dispatch_generation: 1, scheduler_receipt: { ...receipt, job_id: 'agent-worker:other:1' }, envelope: prepared.envelope },
    { type: 'start' as const, run_id: 'run', dispatch_generation: 2, scheduler_receipt: { ...receipt, job_id: 'agent-worker:run:2' }, envelope: prepared.envelope },
    { type: 'start' as const, run_id: 'run', dispatch_generation: 1, scheduler_receipt: { ...receipt, lease: { ...receipt.lease, expires_at: '2025-01-01T00:00:00.000Z' } }, envelope: prepared.envelope },
    { type: 'start' as const, run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: { ...prepared.envelope, network_scope: 'unrestricted' as const } },
  ]) expect(await service.start(bad)).toMatchObject({ type: 'fatal' })
  expect(starts).toBe(0)
})

test('tampered capability cannot start a private Core', async () => {
  let starts = 0; const prepared = bootstrap({ start: async () => { starts++; throw new Error('must not start') } }); prepared.capability.signature = '0'.repeat(64)
  const service = new AgentWorkerService(prepared)
  expect(await service.start({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope: prepared.envelope })).toMatchObject({ type: 'fatal', code: 'ENVELOPE_DENIED' }); expect(starts).toBe(0)
})
