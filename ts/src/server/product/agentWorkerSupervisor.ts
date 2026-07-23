import { AGENT_WORKER_PROTOCOL_VERSION, intersectsAgentWorkerVersions, type AgentWorkerInbound, type AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductResourceScheduler } from './resourceScheduler.js'
import { createLegacyDeferredEnvelope } from './permissionExecutionEnvelope.js'

type DispatchStore = { readTaskRunDispatchIdentity(run: string, generation: number): Promise<{ task_id: string; lineage_id: string; resume_binding_id: string }>; claimTaskRunDispatch(run: string, generation: number): Promise<{ outcome: 'claimed' | 'duplicate' | 'recovery_required'; task_id: string }>; settleTaskRunDispatch(run: string, generation: number, state: 'recovery_required' | 'terminal', error?: string): Promise<void> }
export type AgentWorkerChild = { send(message: AgentWorkerInbound): void; stop(): Promise<void> }
export type AgentWorkerChildLauncher = { launch(input: { run_id: string; core: { task_id: string; lineage_id: string; resume_binding_id: string }; onMessage: (message: AgentWorkerOutbound) => void; onExit: () => void }): Promise<AgentWorkerChild> }

/** Single Local Product Server owner of durable TaskRun → child-worker launch. */
export class AgentWorkerSupervisor {
  private readonly active = new Map<string, { child: AgentWorkerChild; fencing: number }>()
  private readonly starting = new Map<string, Promise<'started' | 'recovery_required'>>()
  private readonly settled = new Set<string>()
  private readonly readyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(private readonly runs: DispatchStore, private readonly scheduler: ProductResourceScheduler, private readonly launcher: AgentWorkerChildLauncher, private readonly readyTimeoutMs = 5_000) {}
  async dispatch(runId: string, generation: number): Promise<'started' | 'recovery_required'> {
    const key = `${runId}:${generation}`; if (this.settled.has(key)) return 'recovery_required'; if (this.active.has(key)) return 'started'
    const inProgress = this.starting.get(key); if (inProgress) return inProgress
    const start = Promise.resolve().then(() => this.startDispatch(runId, generation))
    this.starting.set(key, start)
    try { return await start } finally { if (this.starting.get(key) === start) this.starting.delete(key) }
  }
  private async startDispatch(runId: string, generation: number): Promise<'started' | 'recovery_required'> {
    const key = `${runId}:${generation}`
    let identity: { task_id: string; lineage_id: string; resume_binding_id: string }
    try { identity = await this.runs.readTaskRunDispatchIdentity(runId, generation) } catch { return 'recovery_required' }
    let receipt: Awaited<ReturnType<ProductResourceScheduler['submit']>>
    try { receipt = await this.scheduler.submit({ job_id: `agent-worker:${runId}:${generation}`, owner_id: `task:${identity.task_id}`, idempotency_key: `agent-worker:${runId}:${generation}`, scope: 'desktop-host', resources: [{ key: 'agent.worker', units: 1 }], bytes: { memory: 0, input: 0, temp: 0, output: 0 }, priority: 'interactive', cancel_mode: 'cooperative', resume_policy: 'idempotent', profile_revision: this.scheduler.profileRevision(), task_run: { run_id: runId, dispatch_generation: generation } }) } catch { return 'recovery_required' }
    if (receipt.outcome !== 'admitted' || !receipt.fencing_token) return this.fail(runId, generation, undefined, 'SCHEDULER_DENIED')
    const claim = await this.runs.claimTaskRunDispatch(runId, generation)
    if (claim.outcome !== 'claimed') return this.fail(runId, generation, receipt.fencing_token, claim.outcome)
    let child: AgentWorkerChild | undefined; let hello = false; let ready = false
    const timeout = setTimeout(() => void this.fail(runId, generation, receipt.fencing_token, 'READY_TIMEOUT'), this.readyTimeoutMs)
    this.readyTimers.set(key, timeout)
    try {
      child = await this.launcher.launch({ run_id: runId, core: identity, onExit: () => void this.fail(runId, generation, receipt.fencing_token, 'CHILD_EXIT'), onMessage: message => {
        if (message.type === 'hello') { if (!intersectsAgentWorkerVersions(message.versions, { min: AGENT_WORKER_PROTOCOL_VERSION, max: AGENT_WORKER_PROTOCOL_VERSION })) return void this.fail(runId, generation, receipt.fencing_token, 'CAPABILITY_MISMATCH'); hello = true; child?.send({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: ['framed'] }); return }
        if (message.type === 'ready') { if (!hello || ready) return void this.fail(runId, generation, receipt.fencing_token, 'READY_INVALID'); ready = true; clearTimeout(timeout); this.readyTimers.delete(key); child?.send({ type: 'ready' }); child?.send({ type: 'start', run_id: runId, dispatch_generation: generation, scheduler_receipt: receipt, envelope: createLegacyDeferredEnvelope() }); return }
        if (message.type === 'terminal' || message.type === 'fatal') void this.fail(runId, generation, receipt.fencing_token, message.type === 'terminal' ? 'TERMINAL' : message.code)
      } })
      if (this.settled.has(key)) { await child.stop(); return 'recovery_required' }
      this.active.set(key, { child, fencing: receipt.fencing_token }); return 'started'
    } catch { clearTimeout(timeout); this.readyTimers.delete(key); return this.fail(runId, generation, receipt.fencing_token, 'LAUNCH_FAILED') }
  }
  async stop(runId: string, generation: number): Promise<void> { const key = `${runId}:${generation}`; const active = this.active.get(key); if (!active) return; try { active.child.send({ type: 'stop' }); await active.child.stop() } finally { await this.fail(runId, generation, active.fencing, 'STOPPED', 'terminal') } }
  private async fail(run: string, generation: number, fencing: number | undefined, error: string, state: 'recovery_required' | 'terminal' = 'recovery_required'): Promise<'recovery_required'> {
    const key = `${run}:${generation}`
    if (this.settled.has(key)) return 'recovery_required'
    this.settled.add(key); this.active.delete(key); const timer = this.readyTimers.get(key); if (timer) clearTimeout(timer); this.readyTimers.delete(key)
    try { if (fencing) await this.scheduler.complete(`agent-worker:${run}:${generation}`, fencing) } catch {}
    try { await this.runs.settleTaskRunDispatch(run, generation, state, error) } catch {}
    return 'recovery_required'
  }
}
