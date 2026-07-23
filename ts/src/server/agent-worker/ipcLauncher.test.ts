import { expect, test } from 'bun:test'
import { IpcAgentWorkerLauncher } from './ipcLauncher.js'
import { AgentWorkerSupervisor } from '../product/agentWorkerSupervisor.js'

const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['agent.worker'] as const, fencing_token: 1, lease: { owner_id: 'owner', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }

test('server-owned IPC launcher reaches child bootstrap and invokes one private Core factory', async () => {
  let claims = 0; let starts = 0; const settled: string[] = []
  const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed' as const, task_id: 'task' } }, settleTaskRunDispatch: async (_r: string, _g: number, state: string) => { settled.push(state) } }
  const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
  let resolves = 0
  const launcher = new IpcAgentWorkerLauncher(
    { resolveTaskRunCoreBinding: async (run, generation) => { resolves++; expect([run, generation]).toEqual(['run', 1]); return { session_id: 'session', work_dir: process.cwd() } } },
    { start: async (identity, binding) => { starts++; expect(identity).toEqual({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }); expect(binding.session_id).toBe('session'); return { input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} } } },
  )
  const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(100)
  expect(claims).toBe(1); expect(resolves).toBe(1); expect(starts).toBe(1); expect(settled).toEqual([]); await supervisor.stop('run', 1)
})

test('entrypoint without IPC bootstrap fails closed with framed output', async () => {
  const proc = Bun.spawn([process.execPath, new URL('../../entrypoints/agent-worker.ts', import.meta.url).pathname], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  proc.stdin.write('{}\n'); proc.stdin.end(); const output = await new Response(proc.stdout).text(); await proc.exited
  expect(JSON.parse(output.trim())).toEqual({ type: 'fatal', code: 'ENVELOPE_DENIED' })
})
