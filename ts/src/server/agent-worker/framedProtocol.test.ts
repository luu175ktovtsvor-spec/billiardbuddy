import { expect, test } from 'bun:test'
import { AgentWorkerProtocol } from './framedProtocol.js'
import { AgentWorkerService } from '../product/agentWorkerService.js'

test('framed protocol requires version negotiation and rejects bad, unknown, and oversized frames', async () => {
  const output: unknown[] = []; const service = new AgentWorkerService({ readTaskRunDispatchIdentity: async () => ({ task_id: 't', lineage_id: 'l', resume_binding_id: 'r' }), claimTaskRunDispatch: async () => ({ outcome: 'claimed', task_id: 't' }) }, { start: async () => ({ input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} }) })
  const protocol = new AgentWorkerProtocol(service, value => output.push(value))
  protocol.receive('{'); protocol.receive(JSON.stringify({ type: 'start' })); protocol.receive(JSON.stringify({ type: 'ready', extra: true })); protocol.receive('x'.repeat(70_000)); protocol.receive(JSON.stringify({ type: 'hello', versions: { min: 2, max: 2 }, capabilities: [] }))
  await Bun.sleep(0)
  expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FRAME_INVALID' }), expect.objectContaining({ code: 'PROTOCOL_INVALID' }), expect.objectContaining({ code: 'FRAME_TOO_LARGE' }), expect.objectContaining({ code: 'CAPABILITY_MISMATCH' })]))
})

test('valid hello, ready, and start ordering reaches one claim receipt', async () => {
  const output: unknown[] = []; const service = new AgentWorkerService({ readTaskRunDispatchIdentity: async () => ({ task_id: 't', lineage_id: 'l', resume_binding_id: 'r' }), claimTaskRunDispatch: async () => ({ outcome: 'claimed', task_id: 't' }) }, { start: async () => ({ input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} }) })
  const protocol = new AgentWorkerProtocol(service, value => output.push(value)); const envelope = (await import('../product/permissionExecutionEnvelope.js')).createLegacyDeferredEnvelope(); const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted', profile_revision: 'p', resource_keys: ['agent.worker'], fencing_token: 1, lease: { owner_id: 'o', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }
  protocol.receive(JSON.stringify({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] })); protocol.receive(JSON.stringify({ type: 'ready' })); protocol.receive(JSON.stringify({ type: 'start', run_id: 'run', dispatch_generation: 1, scheduler_receipt: receipt, envelope })); await Bun.sleep(0)
  expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'hello' }), expect.objectContaining({ type: 'ready' }), expect.objectContaining({ type: 'claim_receipt', outcome: 'claimed' })]))
})
