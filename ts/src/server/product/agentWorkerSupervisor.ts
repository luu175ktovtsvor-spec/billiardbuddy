import { AGENT_WORKER_PROTOCOL_VERSION, intersectsAgentWorkerVersions, type AgentWorkerInbound, type AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { ProductResourceScheduler } from './resourceScheduler.js'
import { productPermissionSnapshot, type ProductPermissionSnapshot } from '../../../shared/product/domain.js'
import { createAgentWorkerChildStartCapability, createPolicyBoundEnvelope } from './permissionExecutionEnvelope.js'

export type AgentWorkerCoreIdentity = {
  task_id: string
  lineage_id: string
  resume_binding_id: string
  initial_input: string
  initial_attachments?: string[]
  permission_snapshot?: ProductPermissionSnapshot
  auto_memory?: {
    storage_dir: string
    enabled: boolean
    entry_id: string
  }
  session_context?: {
    text: string
    event_sequence: number
    estimated_tokens: number
    compact_generation: number
  }
  harness_session?: {
    storage_dir: string
    binding_id: string
    lineage_id: string
  }
}
type DispatchStore = {
  readTaskRunDispatchIdentity(run: string, generation: number): Promise<AgentWorkerCoreIdentity>
  inspectTaskRunQueuePosition?(run: string, generation: number): Promise<'ready' | 'queued'>
  claimTaskRunDispatch(run: string, generation: number): Promise<{ outcome: 'claimed' | 'duplicate' | 'queued' | 'recovery_required'; task_id: string }>
  settleTaskRunDispatch(run: string, generation: number, state: 'recovery_required' | 'terminal', error?: string): Promise<void>
  advanceTaskRunQueue?(run: string, generation: number): Promise<void>
}
export type AgentWorkerChild = { send(message: AgentWorkerInbound): void; stop(): Promise<void> }
export type AgentWorkerChildLauncher = { launch(input: { run_id: string; core: AgentWorkerCoreIdentity; bootstrap: { capability: ReturnType<typeof createAgentWorkerChildStartCapability>; capability_key: Buffer }; onMessage: (message: AgentWorkerOutbound) => void; onExit: () => void }): Promise<AgentWorkerChild> }
export type AgentWorkerSafeMessageSink = {
  record(runId: string, generation: number, message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' | 'steer_consumed' }>): Promise<void>
}
export type AgentWorkerDispatchKind = 'interactive' | 'scheduled'

/** Single Local Product Server owner of durable TaskRun → child-worker launch. */
export class AgentWorkerSupervisor {
  private readonly active = new Map<string, { child: AgentWorkerChild; fencing: number; task_id: string; run_id: string; generation: number }>()
  private readonly starting = new Map<string, Promise<'started' | 'queued' | 'recovery_required'>>()
  private readonly settled = new Set<string>()
  private readonly terminalPending = new Set<string>()
  private readonly stopRequested = new Set<string>()
  private readonly releasedSchedulerClaims = new Set<string>()
  private readonly readyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly childCapabilityKey = randomBytes(32)
  constructor(private readonly runs: DispatchStore, private readonly scheduler: ProductResourceScheduler, private readonly launcher: AgentWorkerChildLauncher, private readonly readyTimeoutMs = 5_000, private readonly messages?: AgentWorkerSafeMessageSink) {}
  async dispatch(runId: string, generation: number, kind: AgentWorkerDispatchKind = 'interactive'): Promise<'started' | 'queued' | 'recovery_required'> {
    const key = `${runId}:${generation}`; if (this.settled.has(key)) return 'recovery_required'; if (this.active.has(key)) return 'started'
    const inProgress = this.starting.get(key); if (inProgress) return inProgress
    const start = Promise.resolve().then(() => this.startDispatch(runId, generation, kind))
    this.starting.set(key, start)
    try { return await start } finally { if (this.starting.get(key) === start) this.starting.delete(key) }
  }
  private async startDispatch(runId: string, generation: number, kind: AgentWorkerDispatchKind): Promise<'started' | 'queued' | 'recovery_required'> {
    const key = `${runId}:${generation}`
    if (this.stopRequested.has(key)) return this.fail(runId, generation, undefined, 'STOPPED', 'terminal')
    let identity: AgentWorkerCoreIdentity
    try { identity = await this.runs.readTaskRunDispatchIdentity(runId, generation) } catch { return 'recovery_required' }
    if (this.settled.has(key)) return 'recovery_required'
    if (this.stopRequested.has(key)) return this.fail(runId, generation, undefined, 'STOPPED', 'terminal')
    if (await this.runs.inspectTaskRunQueuePosition?.(runId, generation) === 'queued') return 'queued'
    let receipt: Awaited<ReturnType<ProductResourceScheduler['submit']>>
    const resources = kind === 'scheduled'
      ? [{ key: 'schedule.dispatch' as const, units: 1 }, { key: 'agent.worker' as const, units: 1 }]
      : [{ key: 'agent.worker' as const, units: 1 }]
    let attachmentBytes = 0
    try {
      attachmentBytes = (await Promise.all((identity.initial_attachments ?? []).map(async file => {
        const stat = await fs.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ATTACHMENT_COPY_INVALID')
        return stat.size
      }))).reduce((total, bytes) => total + bytes, 0)
    } catch {
      return this.fail(runId, generation, undefined, 'ATTACHMENT_COPY_INVALID')
    }
    const claim = { job_id: `agent-worker:${runId}:${generation}`, owner_id: `task:${identity.task_id}`, idempotency_key: `agent-worker:${runId}:${generation}`, scope: 'desktop-host' as const, resources, bytes: { memory: 0, input: attachmentBytes, temp: 0, output: 0 }, priority: kind, cancel_mode: 'cooperative' as const, resume_policy: 'idempotent' as const, profile_revision: this.scheduler.profileRevision(), task_run: { run_id: runId, dispatch_generation: generation } }
    try {
      receipt = await this.scheduler.submit(claim)
      while ((receipt.outcome === 'queued' || receipt.outcome === 'duplicate') && !receipt.fencing_token) {
        if (this.settled.has(key) || this.stopRequested.has(key)) { await this.scheduler.cancel(claim.job_id).catch(() => undefined); return 'recovery_required' }
        await new Promise(resolve => setTimeout(resolve, 25))
        receipt = await this.scheduler.submit(claim)
      }
    } catch { return this.fail(runId, generation, undefined, 'SCHEDULER_DENIED') }
    if (!['admitted', 'duplicate'].includes(receipt.outcome) || !receipt.fencing_token) return this.fail(runId, generation, undefined, 'SCHEDULER_DENIED')
    this.startSchedulerHeartbeat(runId, generation, receipt.fencing_token, receipt.lease?.expires_at)
    if (this.settled.has(key)) { await this.releaseSchedulerClaim(runId, generation, receipt.fencing_token); return 'recovery_required' }
    if (this.stopRequested.has(key)) return this.fail(runId, generation, receipt.fencing_token, 'STOPPED', 'terminal')
    const dispatchClaim = await this.runs.claimTaskRunDispatch(runId, generation)
    if (dispatchClaim.outcome === 'queued') { await this.releaseSchedulerClaim(runId, generation, receipt.fencing_token); return 'queued' }
    if (dispatchClaim.outcome !== 'claimed') return this.fail(runId, generation, receipt.fencing_token, dispatchClaim.outcome)
    if (this.settled.has(key)) { await this.releaseSchedulerClaim(runId, generation, receipt.fencing_token); return 'recovery_required' }
    if (this.stopRequested.has(key)) return this.fail(runId, generation, receipt.fencing_token, 'STOPPED', 'terminal')
    let child: AgentWorkerChild | undefined; let hello = false; let ready = false; let inputSent = false
    const envelope = createPolicyBoundEnvelope(
      identity.permission_snapshot ?? productPermissionSnapshot('ask_for_approval'),
    )
    const bootstrap = { capability: createAgentWorkerChildStartCapability({ run_id: runId, dispatch_generation: generation, fencing_token: receipt.fencing_token, envelope_digest: envelope.digest }, this.childCapabilityKey), capability_key: this.childCapabilityKey }
    const timeout = setTimeout(() => void this.fail(runId, generation, receipt.fencing_token, 'READY_TIMEOUT'), this.readyTimeoutMs)
    this.readyTimers.set(key, timeout)
    try {
      child = await this.launcher.launch({ run_id: runId, core: identity, bootstrap, onExit: () => void this.fail(runId, generation, receipt.fencing_token, 'CHILD_EXIT'), onMessage: message => {
        // A terminal transition is final. In particular, do not let buffered
        // IPC activity resurrect a completed/failed durable TaskRun.
        if (this.settled.has(key) || this.terminalPending.has(key)) return
        if (message.type === 'hello') { if (!intersectsAgentWorkerVersions(message.versions, { min: AGENT_WORKER_PROTOCOL_VERSION, max: AGENT_WORKER_PROTOCOL_VERSION })) return void this.fail(runId, generation, receipt.fencing_token, 'CAPABILITY_MISMATCH'); hello = true; child?.send({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: ['framed'] }); return }
        if (message.type === 'ready') { if (!hello || ready) return void this.fail(runId, generation, receipt.fencing_token, 'READY_INVALID'); ready = true; clearTimeout(timeout); this.readyTimers.delete(key); child?.send({ type: 'ready' }); child?.send({ type: 'start', run_id: runId, dispatch_generation: generation, scheduler_receipt: receipt, envelope }); return }
        if (message.type === 'claim_receipt') {
          if (!ready || inputSent || message.outcome !== 'claimed' || message.run_id !== runId) return void this.fail(runId, generation, receipt.fencing_token, 'CLAIM_RECEIPT_INVALID')
          inputSent = true
          child?.send({ type: 'input', text: identity.initial_input })
          return
        }
        if (message.type === 'event') {
          void Promise.resolve(this.messages?.record(runId, generation, message))
            .catch(() => this.fail(runId, generation, receipt.fencing_token, 'EVENT_PERSIST_FAILED'))
          return
        }
        if (message.type === 'steer_consumed') {
          void Promise.resolve(this.messages?.record(runId, generation, message))
            .catch(() => this.fail(runId, generation, receipt.fencing_token, 'EVENT_PERSIST_FAILED'))
          return
        }
        if (message.type === 'terminal') {
          // Close the relay synchronously, then persist the final safe
          // projection before settling durable dispatch state.
          this.terminalPending.add(key)
          void Promise.resolve(this.messages?.record(runId, generation, message))
            .then(() => this.fail(runId, generation, receipt.fencing_token, 'TERMINAL', message.state === 'recovery_required' ? 'recovery_required' : 'terminal'))
            .catch(() => this.fail(runId, generation, receipt.fencing_token, 'EVENT_PERSIST_FAILED', 'recovery_required'))
          return
        }
        if (message.type === 'fatal') void this.fail(runId, generation, receipt.fencing_token, message.code)
      } })
      if (this.settled.has(key)) { await child.stop(); await this.releaseSchedulerClaim(runId, generation, receipt.fencing_token); return 'recovery_required' }
      if (this.terminalPending.has(key) || this.stopRequested.has(key)) { await child.stop(); return this.fail(runId, generation, receipt.fencing_token, 'STOPPED', 'terminal') }
      this.active.set(key, { child, fencing: receipt.fencing_token, task_id: dispatchClaim.task_id, run_id: runId, generation }); return 'started'
    } catch { clearTimeout(timeout); this.readyTimers.delete(key); return this.fail(runId, generation, receipt.fencing_token, 'LAUNCH_FAILED') }
  }
  async approve(runId: string, generation: number, requestId: string, approved: boolean): Promise<boolean> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.terminalPending.has(key)) return false
    const active = this.active.get(key)
    if (!active || !requestId) return false
    active.child.send({ type: 'approval_response', request_id: requestId, approved })
    return true
  }
  async answer(runId: string, generation: number, requestId: string, answers: readonly string[]): Promise<boolean> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.terminalPending.has(key) || !requestId || answers.length === 0) return false
    const active = this.active.get(key)
    if (!active) return false
    active.child.send({ type: 'question_response', request_id: requestId, answers: [...answers] })
    return true
  }
  async steer(runId: string, generation: number, queueItemId: string, text: string): Promise<boolean> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.terminalPending.has(key) || !/^queue_[a-f0-9-]{36}$/.test(queueItemId) || !text) return false
    const active = this.active.get(key)
    if (!active) return false
    active.child.send({ type: 'steer', queue_item_id: queueItemId, text })
    return true
  }
  async stop(runId: string, generation: number): Promise<void> { const key = `${runId}:${generation}`; if (this.settled.has(key)) return; this.stopRequested.add(key); this.terminalPending.add(key); const active = this.active.get(key); try { if (active) { active.child.send({ type: 'stop' }); await active.child.stop() } else await this.scheduler.cancel(`agent-worker:${runId}:${generation}`).catch(() => undefined); await this.messages?.record(runId, generation, { type: 'terminal', state: 'stopped', run_id: runId }) } finally { await this.fail(runId, generation, active?.fencing, 'STOPPED', 'terminal') } }
  async shutdown(): Promise<void> {
    await Promise.all([...this.active.values()].map(active => this.stop(active.run_id, active.generation)))
  }
  private async fail(run: string, generation: number, fencing: number | undefined, error: string, state: 'recovery_required' | 'terminal' = 'recovery_required'): Promise<'recovery_required'> {
    const key = `${run}:${generation}`
    if (this.settled.has(key)) return 'recovery_required'
    this.settled.add(key); this.terminalPending.delete(key); this.stopRequested.delete(key); this.active.delete(key); const timer = this.readyTimers.get(key); if (timer) clearTimeout(timer); this.readyTimers.delete(key); const heartbeat = this.heartbeatTimers.get(key); if (heartbeat) clearInterval(heartbeat); this.heartbeatTimers.delete(key)
    try { await this.runs.settleTaskRunDispatch(run, generation, state, error === 'MODEL_CONFIGURATION_INVALID' ? '模型配置无效' : error) } catch {}
    // Durable terminal/recovery state is the fence for all later child IPC;
    // scheduler journal I/O must not delay that transition.
    await this.releaseSchedulerClaim(run, generation, fencing)
    if (state === 'terminal') await this.runs.advanceTaskRunQueue?.(run, generation).catch(() => undefined)
    return 'recovery_required'
  }
  private startSchedulerHeartbeat(run: string, generation: number, fencing: number, expiresAt?: string): void {
    const key = `${run}:${generation}`
    const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : 30_000
    const interval = Math.max(1, Math.min(10_000, Math.floor(remaining / 3)))
    const timer = setInterval(() => {
      void this.scheduler.heartbeat(`agent-worker:${run}:${generation}`, fencing).then(receipt => {
        if (receipt.outcome !== 'admitted') void this.fail(run, generation, fencing, 'SCHEDULER_LEASE_LOST')
      }).catch(() => this.fail(run, generation, fencing, 'SCHEDULER_HEARTBEAT_FAILED'))
    }, interval)
    timer.unref?.()
    this.heartbeatTimers.set(key, timer)
  }
  private async releaseSchedulerClaim(run: string, generation: number, fencing: number | undefined): Promise<void> {
    const heartbeatKey = `${run}:${generation}`
    const heartbeat = this.heartbeatTimers.get(heartbeatKey)
    if (heartbeat) clearInterval(heartbeat)
    this.heartbeatTimers.delete(heartbeatKey)
    if (!fencing) return
    const key = `${run}:${generation}:${fencing}`
    if (this.releasedSchedulerClaims.has(key)) return
    this.releasedSchedulerClaims.add(key)
    try { await this.scheduler.complete(`agent-worker:${run}:${generation}`, fencing) } catch {}
  }
}
