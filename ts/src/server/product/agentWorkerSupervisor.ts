import { AGENT_WORKER_PROTOCOL_VERSION, intersectsAgentWorkerVersions, type AgentWorkerInbound, type AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import { randomBytes, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import type { ProductResourceScheduler } from './resourceScheduler.js'
import { productPermissionSnapshot, type ProductPermissionSnapshot } from '../../../shared/product/domain.js'
import { createAgentWorkerChildStartCapability, createPolicyBoundEnvelope } from './permissionExecutionEnvelope.js'
import { classifyProductTaskRunFailure, productTaskRunFailure } from './taskRunFailure.js'
import type { ProductTaskRunFailure } from '../../../shared/product/taskEvents.js'
import type { CodexEnginePrivateState } from '../agent-engine/codexEnginePrivateState.js'

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
  codex_engine: CodexEnginePrivateState
  subtask?: {
    parent_run_id: string
  }
}

type DispatchStore = {
  readTaskRunDispatchIdentity(run: string, generation: number): Promise<AgentWorkerCoreIdentity>
  inspectTaskRunQueuePosition?(run: string, generation: number): Promise<'ready' | 'queued'>
  claimTaskRunDispatch(run: string, generation: number, executionClaimToken: string): Promise<{ outcome: 'claimed' | 'duplicate' | 'queued' | 'recovery_required'; task_id: string }>
  prepareTaskRunRecoveryFence(run: string, generation: number, failure: ProductTaskRunFailure, executionClaimToken?: string): Promise<'prepared' | 'already_settled' | 'outcome_unknown' | 'not_owner'>
  requestTaskRunStop(run: string, generation: number, executionClaimToken?: string): Promise<'requested' | 'already_settled' | 'not_owner'>
  settleTaskRunDispatch(run: string, generation: number, state: 'recovery_required' | 'terminal', error?: string, failure?: ProductTaskRunFailure, executionClaimToken?: string): Promise<'settled' | 'already_settled' | 'outcome_unknown' | 'not_owner'>
  advanceTaskRunQueue?(run: string, generation: number): Promise<void>
}

export type AgentWorkerChild = { send(message: AgentWorkerInbound): void; stop(): Promise<void> }
export type AgentWorkerChildLauncher = { launch(input: { run_id: string; core: AgentWorkerCoreIdentity; bootstrap: { capability: ReturnType<typeof createAgentWorkerChildStartCapability>; capability_key: Buffer }; onMessage: (message: AgentWorkerOutbound) => void; onExit: () => void }): Promise<AgentWorkerChild> }
export type AgentWorkerSafeMessageSink = {
  record(runId: string, generation: number, message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' | 'steer_consumed' }>, executionClaimToken: string): Promise<void>
}
export type AgentWorkerDispatchKind = 'interactive' | 'scheduled'

type TerminalMessage = Extract<AgentWorkerOutbound, { type: 'terminal' }>
type LiveAgentWorker = {
  child: AgentWorkerChild
  fencing: number
  task_id: string
  run_id: string
  generation: number
  execution_claim_token: string
}
type ClaimedAgentWorker = Omit<LiveAgentWorker, 'child'>
type PendingDurableSettlement = {
  run_id: string
  generation: number
  fencing?: number
  owns_lease: boolean
  execution_claim_token?: string
  error: string
  state: 'recovery_required' | 'terminal'
  failure?: ProductTaskRunFailure
  /** The restart-safe fallback while an exact terminal projection is pending. */
  recovery_failure: ProductTaskRunFailure
  terminal_message?: TerminalMessage
  fence_prepared: boolean
  terminal_projection_attempted: boolean
  terminal_projection_recorded: boolean
  attempts: number
  child?: AgentWorkerChild
  retry?: ReturnType<typeof setTimeout>
  settling?: Promise<void>
  fence_preparing?: Promise<'prepared' | 'already_settled' | 'outcome_unknown' | 'not_owner'>
  lease_lost?: boolean
}
type FailureInput = {
  fencing?: number
  owns_lease?: boolean
  execution_claim_token?: string
  error: string
  state?: 'recovery_required' | 'terminal'
  failure?: ProductTaskRunFailure
  terminal_message?: TerminalMessage
}

/** Single Local Product Server owner of durable TaskRun → child-worker launch. */
export class AgentWorkerSupervisor {
  private readonly active = new Map<string, LiveAgentWorker>()
  private readonly launched = new Map<string, LiveAgentWorker>()
  /** Claimed before `launch()` yields, so a user stop always finds its token. */
  private readonly claimed = new Map<string, ClaimedAgentWorker>()
  private readonly starting = new Map<string, Promise<'started' | 'queued' | 'recovery_required'>>()
  private readonly settled = new Set<string>()
  /**
   * Finalization stays blocked in memory while its durable recovery fence and
   * exact terminal projection are written. The persisted fence, not this map
   * or a cooperative lease, is the restart/replay boundary.
   */
  private readonly finalizing = new Map<string, PendingDurableSettlement>()
  private readonly terminalPending = new Set<string>()
  private readonly stopRequested = new Set<string>()
  private readonly releasedSchedulerClaims = new Set<string>()
  private readonly readyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly childCapabilityKey = randomBytes(32)

  constructor(
    private readonly runs: DispatchStore,
    private readonly scheduler: ProductResourceScheduler,
    private readonly launcher: AgentWorkerChildLauncher,
    private readonly readyTimeoutMs = 5_000,
    private readonly messages?: AgentWorkerSafeMessageSink,
  ) {}

  async dispatch(runId: string, generation: number, kind: AgentWorkerDispatchKind = 'interactive'): Promise<'started' | 'queued' | 'recovery_required'> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.finalizing.has(key)) return 'recovery_required'
    if (this.active.has(key)) return 'started'
    const inProgress = this.starting.get(key)
    if (inProgress) return inProgress
    const start = Promise.resolve().then(() => this.startDispatch(runId, generation, kind))
    this.starting.set(key, start)
    try {
      return await start
    } finally {
      if (this.starting.get(key) === start) this.starting.delete(key)
    }
  }

  private async startDispatch(runId: string, generation: number, kind: AgentWorkerDispatchKind): Promise<'started' | 'queued' | 'recovery_required'> {
    const key = `${runId}:${generation}`
    const executionClaimToken = randomUUID()
    if (this.stopRequested.has(key)) return 'recovery_required'

    let identity: AgentWorkerCoreIdentity
    try {
      identity = await this.runs.readTaskRunDispatchIdentity(runId, generation)
    } catch { return 'recovery_required' }
    if (this.settled.has(key) || this.finalizing.has(key)) return 'recovery_required'
    if (this.stopRequested.has(key)) return 'recovery_required'

    try {
      if (await this.runs.inspectTaskRunQueuePosition?.(runId, generation) === 'queued') return 'queued'
    } catch {
      return 'recovery_required'
    }

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
    } catch { return 'recovery_required' }
    if (this.settled.has(key) || this.finalizing.has(key)) return 'recovery_required'
    if (this.stopRequested.has(key)) return 'recovery_required'

    const jobId = `agent-worker:${runId}:${generation}`
    const claim = {
      job_id: jobId,
      owner_id: `task:${identity.task_id}`,
      idempotency_key: jobId,
      scope: 'desktop-host' as const,
      resources,
      bytes: { memory: 0, input: attachmentBytes, temp: 0, output: 0 },
      priority: kind,
      cancel_mode: 'cooperative' as const,
      resume_policy: 'idempotent' as const,
      profile_revision: this.scheduler.profileRevision(),
      task_run: { run_id: runId, dispatch_generation: generation },
    }

    let receipt: Awaited<ReturnType<ProductResourceScheduler['submit']>>
    try {
      receipt = await this.scheduler.submit(claim)
      // Only the invocation that first created a queued job is permitted to
      // poll it. A duplicate may belong to another local Product Server.
      const createdQueued = receipt.outcome === 'queued'
      while (createdQueued && (receipt.outcome === 'queued' || (receipt.outcome === 'duplicate' && !receipt.fencing_token))) {
        if (this.settled.has(key) || this.finalizing.has(key) || this.stopRequested.has(key)) return 'recovery_required'
        if (receipt.outcome === 'duplicate' && receipt.reason_code === 'ALREADY_SETTLED') return 'recovery_required'
        await new Promise(resolve => setTimeout(resolve, 25))
        receipt = await this.scheduler.submit(claim)
      }
    } catch { return 'recovery_required' }

    if (receipt.outcome === 'duplicate' && receipt.reason_code === 'ALREADY_SETTLED') return 'recovery_required'
    if (receipt.outcome === 'rejected') return 'recovery_required'
    if (receipt.outcome === 'queued') return 'queued'
    if (receipt.outcome === 'duplicate') {
      // Never operate another process's lease. If this process genuinely owns
      // the duplicate reservation, heartbeat turns it into the only receipt a
      // Worker is allowed to receive: outcome=admitted.
      if (!receipt.fencing_token || !this.scheduler.ownsLease(receipt.lease)) return 'queued'
      try {
        receipt = await this.scheduler.heartbeat(jobId, receipt.fencing_token)
      } catch {
        return 'recovery_required'
      }
    }
    if (receipt.outcome !== 'admitted' || !receipt.fencing_token || !this.scheduler.ownsLease(receipt.lease)) return 'recovery_required'

    const fencing = receipt.fencing_token
    this.startSchedulerHeartbeat(runId, generation, fencing, receipt.lease?.expires_at)
    if (this.settled.has(key)) {
      await this.releaseSchedulerClaim(runId, generation, fencing, true)
      return 'recovery_required'
    }
    if (this.rememberFinalizingClaim(runId, generation, fencing)) return 'recovery_required'
    if (this.stopRequested.has(key)) {
      await this.releaseSchedulerClaim(runId, generation, fencing, true)
      return 'recovery_required'
    }

    let dispatchClaim: Awaited<ReturnType<DispatchStore['claimTaskRunDispatch']>>
    try {
      dispatchClaim = await this.runs.claimTaskRunDispatch(runId, generation, executionClaimToken)
    } catch {
      await this.releaseSchedulerClaim(runId, generation, fencing, true)
      return 'recovery_required'
    }
    if (dispatchClaim.outcome === 'queued') {
      await this.releaseSchedulerClaim(runId, generation, fencing, true)
      return 'queued'
    }
    // Duplicate/recovery outcomes are a different owner's durable state. Do
    // not turn them into a failure or terminal projection from this process.
    if (dispatchClaim.outcome !== 'claimed') {
      // `ownsLease` is process-scoped, so a second supervisor in this process
      // can still be the real owner. Do not complete its reservation here.
      this.stopSchedulerHeartbeat(key)
      return 'recovery_required'
    }
    // No await may appear before this assignment. A stop can arrive as soon
    // as the authority claim commits, but the child has not been launched yet.
    this.claimed.set(key, {
      fencing,
      task_id: dispatchClaim.task_id,
      run_id: runId,
      generation,
      execution_claim_token: executionClaimToken,
    })
    this.startSchedulerHeartbeat(runId, generation, fencing, receipt.lease?.expires_at, executionClaimToken)
    if (this.settled.has(key)) {
      this.claimed.delete(key)
      await this.releaseSchedulerClaim(runId, generation, fencing, true)
      return 'recovery_required'
    }
    if (this.rememberFinalizingClaim(runId, generation, fencing)) {
      this.claimed.delete(key)
      return 'recovery_required'
    }
    if (this.stopRequested.has(key)) return this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'STOPPED', state: 'terminal', terminal_message: { type: 'terminal', state: 'stopped', run_id: runId } })

    let child: AgentWorkerChild | undefined
    let hello = false
    let ready = false
    let inputSent = false
    const envelope = createPolicyBoundEnvelope(
      identity.permission_snapshot ?? productPermissionSnapshot('ask_for_approval'),
    )
    const bootstrap = {
      capability: createAgentWorkerChildStartCapability({ run_id: runId, dispatch_generation: generation, fencing_token: fencing, envelope_digest: envelope.digest, execution_claim_token: executionClaimToken }, this.childCapabilityKey),
      capability_key: this.childCapabilityKey,
    }
    const timeout = setTimeout(() => {
      void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'READY_TIMEOUT' })
    }, this.readyTimeoutMs)
    this.readyTimers.set(key, timeout)

    const recordWorkerMessage = (message: Extract<AgentWorkerOutbound, { type: 'event' | 'steer_consumed' }>) => {
      void Promise.resolve(this.messages?.record(runId, generation, message, executionClaimToken)).catch(() => {
        void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'EVENT_PERSIST_FAILED' })
      })
    }

    try {
      child = await this.launcher.launch({
        run_id: runId,
        core: identity,
        bootstrap,
        onExit: () => {
          // A terminal message owns its outcome. Any other exit becomes a
          // durable recovery record after the child has actually stopped.
          if (!this.terminalPending.has(key) && !this.finalizing.has(key) && !this.settled.has(key)) {
            void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'CHILD_EXIT' })
          }
        },
        onMessage: message => {
          // No buffered IPC activity may resurrect a finalizing TaskRun.
          if (this.settled.has(key) || this.finalizing.has(key) || this.terminalPending.has(key)) return
          if (message.type === 'hello') {
            if (!intersectsAgentWorkerVersions(message.versions, { min: AGENT_WORKER_PROTOCOL_VERSION, max: AGENT_WORKER_PROTOCOL_VERSION })) {
              void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'CAPABILITY_MISMATCH' })
              return
            }
            hello = true
            child?.send({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: ['framed'] })
            return
          }
          if (message.type === 'ready') {
            if (!hello || ready) {
              void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'READY_INVALID' })
              return
            }
            ready = true
            clearTimeout(timeout)
            this.readyTimers.delete(key)
            child?.send({ type: 'ready' })
            child?.send({ type: 'start', run_id: runId, dispatch_generation: generation, execution_claim_token: executionClaimToken, scheduler_receipt: receipt, envelope })
            return
          }
          if (message.type === 'claim_receipt') {
            if (!ready || inputSent || message.outcome !== 'claimed' || message.run_id !== runId) {
              void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'CLAIM_RECEIPT_INVALID' })
              return
            }
            inputSent = true
            child?.send({ type: 'input', text: identity.initial_input })
            return
          }
          if (message.type === 'event' || message.type === 'steer_consumed') {
            recordWorkerMessage(message)
            return
          }
          if (message.type === 'terminal') {
            // The supervisor first revokes this execution token with a durable
            // fence, then terminates the child before it projects terminal UI.
            void this.fail(runId, generation, {
              fencing,
              owns_lease: true,
              execution_claim_token: executionClaimToken,
              error: message.state === 'stopped' ? 'STOPPED' : 'TERMINAL',
              state: message.state === 'recovery_required' ? 'recovery_required' : 'terminal',
              failure: message.failure,
              terminal_message: message,
            })
            return
          }
          if (message.type === 'fatal') {
            void this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: message.code })
          }
        },
      })
      const live: LiveAgentWorker = { child, fencing, task_id: dispatchClaim.task_id, run_id: runId, generation, execution_claim_token: executionClaimToken }
      this.launched.set(key, live)
      this.active.set(key, live)
      this.claimed.delete(key)
      if (this.settled.has(key)) {
        this.active.delete(key)
        this.launched.delete(key)
        await child.stop().catch(() => undefined)
        await this.releaseSchedulerClaim(runId, generation, fencing, true)
        return 'recovery_required'
      }
      if (this.rememberFinalizingClaim(runId, generation, fencing)) {
        this.active.delete(key)
        this.launched.delete(key)
        await child.stop().catch(() => undefined)
        return 'recovery_required'
      }
      if (this.stopRequested.has(key)) return this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'STOPPED', state: 'terminal', terminal_message: { type: 'terminal', state: 'stopped', run_id: runId } })
      return 'started'
    } catch {
      clearTimeout(timeout)
      this.readyTimers.delete(key)
      return this.fail(runId, generation, { fencing, owns_lease: true, execution_claim_token: executionClaimToken, error: 'LAUNCH_FAILED' })
    }
  }

  async approve(runId: string, generation: number, requestId: string, approved: boolean): Promise<boolean> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.finalizing.has(key) || this.terminalPending.has(key) || !requestId) return false
    const active = this.active.get(key)
    if (!active) return false
    active.child.send({ type: 'approval_response', request_id: requestId, approved })
    return true
  }

  async answer(runId: string, generation: number, requestId: string, answers: readonly string[]): Promise<boolean> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.finalizing.has(key) || this.terminalPending.has(key) || !requestId || answers.length === 0) return false
    const active = this.active.get(key)
    if (!active) return false
    active.child.send({ type: 'question_response', request_id: requestId, answers: [...answers] })
    return true
  }

  async steer(runId: string, generation: number, queueItemId: string, text: string): Promise<boolean> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.finalizing.has(key) || this.terminalPending.has(key) || !/^queue_[a-f0-9-]{36}$/.test(queueItemId) || !text) return false
    const active = this.active.get(key)
    if (!active) return false
    active.child.send({ type: 'steer', queue_item_id: queueItemId, text })
    return true
  }

  async stop(runId: string, generation: number): Promise<void> {
    const key = `${runId}:${generation}`
    if (this.settled.has(key) || this.finalizing.has(key) || this.terminalPending.has(key)) return
    this.stopRequested.add(key)
    const active = this.active.get(key) ?? this.launched.get(key)
    const claimed = this.claimed.get(key)
    const owner = active ?? claimed
    const stopLocalExecutor = async () => {
      if (!active) return
      this.active.delete(key)
      this.launched.delete(key)
      this.stopSchedulerHeartbeat(key)
      await active.child.stop().catch(() => undefined)
    }
    let outcome: 'requested' | 'already_settled' | 'not_owner'
    try {
      outcome = await this.runs.requestTaskRunStop(runId, generation, owner?.execution_claim_token)
    } catch {
      await stopLocalExecutor()
      this.stopRequested.delete(key)
      return
    }
    if (outcome !== 'requested') {
      await stopLocalExecutor()
      this.stopRequested.delete(key)
      return
    }
    if (!active && !claimed) {
      await this.scheduler.cancel(`agent-worker:${runId}:${generation}`).catch(() => undefined)
    }
    await this.fail(runId, generation, {
      fencing: owner?.fencing,
      owns_lease: owner !== undefined,
      execution_claim_token: owner?.execution_claim_token,
      error: 'STOPPED',
      state: 'terminal',
      terminal_message: { type: 'terminal', state: 'stopped', run_id: runId },
    })
  }

  async shutdown(): Promise<void> {
    const owned = new Map<string, ClaimedAgentWorker>()
    for (const active of this.active.values()) owned.set(`${active.run_id}:${active.generation}`, active)
    for (const launched of this.launched.values()) owned.set(`${launched.run_id}:${launched.generation}`, launched)
    for (const claimed of this.claimed.values()) owned.set(`${claimed.run_id}:${claimed.generation}`, claimed)
    await Promise.all([...owned.values()].map(owner => this.fail(owner.run_id, owner.generation, {
      fencing: owner.fencing,
      owns_lease: true,
      execution_claim_token: owner.execution_claim_token,
      error: 'SERVER_SHUTDOWN',
    })))
    await Promise.all([...this.finalizing.values()].map(pending => this.persistDurableSettlement(pending)))
  }

  private async fail(run: string, generation: number, input: FailureInput): Promise<'recovery_required'> {
    const key = `${run}:${generation}`
    if (this.settled.has(key)) return 'recovery_required'
    const claimed = this.claimed.get(key)
    const fencing = input.fencing ?? claimed?.fencing
    const ownsLease = input.owns_lease === true || claimed !== undefined
    const executionClaimToken = input.execution_claim_token ?? claimed?.execution_claim_token
    const alreadyFinalizing = this.finalizing.get(key)
    if (alreadyFinalizing) {
      if (fencing !== undefined && alreadyFinalizing.fencing === undefined) alreadyFinalizing.fencing = fencing
      if (ownsLease) alreadyFinalizing.owns_lease = true
      if (executionClaimToken !== undefined && alreadyFinalizing.execution_claim_token === undefined) alreadyFinalizing.execution_claim_token = executionClaimToken
      return 'recovery_required'
    }

    const state = input.state ?? 'recovery_required'
    const failure = state === 'recovery_required'
      ? input.failure ?? classifyProductTaskRunFailure(new Error(input.error))
      : undefined
    const pending: PendingDurableSettlement = {
      run_id: run,
      generation,
      ...(fencing === undefined ? {} : { fencing }),
      owns_lease: ownsLease,
      ...(executionClaimToken === undefined ? {} : { execution_claim_token: executionClaimToken }),
      error: input.error,
      state,
      ...(failure === undefined ? {} : { failure }),
      recovery_failure: state === 'recovery_required'
        ? failure!
        : productTaskRunFailure('task_execution_environment_failed'),
      ...(input.terminal_message === undefined ? {} : { terminal_message: input.terminal_message }),
      fence_prepared: false,
      terminal_projection_attempted: false,
      terminal_projection_recorded: false,
      attempts: 0,
    }
    this.finalizing.set(key, pending)
    this.terminalPending.add(key)
    const active = this.active.get(key) ?? this.launched.get(key)
    if (active) pending.child = active.child
    this.active.delete(key)
    this.launched.delete(key)
    this.claimed.delete(key)
    const timer = this.readyTimers.get(key)
    if (timer) clearTimeout(timer)
    this.readyTimers.delete(key)

    // Write the durable fence before stopping the child. Once it is committed,
    // the token is revoked for every later Core model/tool request.
    const fence = this.prepareRecoveryFence(pending)
    let fenceOutcome: 'prepared' | 'already_settled' | 'outcome_unknown' | 'not_owner'
    try {
      fenceOutcome = await fence
    } catch {
      this.retryDurableSettlement(pending)
      return 'recovery_required'
    }
    if (fenceOutcome !== 'prepared') {
      await this.stopFinalizingChild(pending)
      if (fenceOutcome === 'outcome_unknown') {
        await this.releaseSchedulerClaim(pending.run_id, pending.generation, pending.fencing, pending.owns_lease)
      }
      this.abandonDurableSettlement(pending)
      return 'recovery_required'
    }
    pending.fence_prepared = true
    await this.stopFinalizingChild(pending)
    await this.persistDurableSettlement(pending)
    return 'recovery_required'
  }

  private rememberFinalizingClaim(run: string, generation: number, fencing: number): boolean {
    const pending = this.finalizing.get(`${run}:${generation}`)
    if (!pending) return false
    if (pending.fencing === undefined) pending.fencing = fencing
    pending.owns_lease = true
    return true
  }

  private persistDurableSettlement(pending: PendingDurableSettlement): Promise<void> {
    const key = `${pending.run_id}:${pending.generation}`
    if (this.finalizing.get(key) !== pending || this.settled.has(key)) return Promise.resolve()
    if (pending.settling) return pending.settling
    const settling = this.writeDurableSettlement(pending)
    pending.settling = settling
    return settling.finally(() => {
      if (pending.settling === settling) pending.settling = undefined
    })
  }

  private prepareRecoveryFence(pending: PendingDurableSettlement): Promise<'prepared' | 'already_settled' | 'outcome_unknown' | 'not_owner'> {
    if (pending.fence_prepared) return Promise.resolve('prepared')
    if (pending.fence_preparing) return pending.fence_preparing
    const preparing = this.runs.prepareTaskRunRecoveryFence(
      pending.run_id,
      pending.generation,
      pending.recovery_failure,
      pending.execution_claim_token,
    )
    pending.fence_preparing = preparing
    return preparing.finally(() => {
      if (pending.fence_preparing === preparing) pending.fence_preparing = undefined
    })
  }

  private async stopFinalizingChild(pending: PendingDurableSettlement): Promise<void> {
    const child = pending.child
    if (!child) return
    try {
      await child.stop()
      if (pending.child === child) pending.child = undefined
    } catch {
      pending.error = 'WORKER_STOP_UNCONFIRMED'
      pending.state = 'recovery_required'
      pending.failure = productTaskRunFailure('task_execution_environment_failed')
      pending.recovery_failure = pending.failure
      pending.lease_lost = true
      delete pending.terminal_message
    }
  }

  /** A foreign owner/terminal record wins; never complete or advance its job. */
  private abandonDurableSettlement(pending: PendingDurableSettlement): void {
    const key = `${pending.run_id}:${pending.generation}`
    if (this.finalizing.get(key) !== pending) return
    this.finalizing.delete(key)
    this.terminalPending.delete(key)
    this.stopRequested.delete(key)
    this.claimed.delete(key)
    if (pending.retry) clearTimeout(pending.retry)
    pending.retry = undefined
    this.stopSchedulerHeartbeat(key)
  }

  private async writeDurableSettlement(pending: PendingDurableSettlement): Promise<void> {
    const key = `${pending.run_id}:${pending.generation}`
    if (this.finalizing.get(key) !== pending || this.settled.has(key)) return
    pending.attempts += 1

    if (!pending.fence_prepared) {
      let outcome: 'prepared' | 'already_settled' | 'outcome_unknown' | 'not_owner'
      try {
        outcome = await this.prepareRecoveryFence(pending)
      } catch {
        this.retryDurableSettlement(pending)
        return
      }
      if (outcome !== 'prepared') {
        if (outcome === 'outcome_unknown') {
          await this.stopFinalizingChild(pending)
          await this.releaseSchedulerClaim(pending.run_id, pending.generation, pending.fencing, pending.owns_lease)
        }
        this.abandonDurableSettlement(pending)
        return
      }
      pending.fence_prepared = true
    }

    await this.stopFinalizingChild(pending)

    if (pending.terminal_message && this.messages && pending.execution_claim_token && !pending.terminal_projection_attempted) {
      pending.terminal_projection_attempted = true
      try {
        await this.messages.record(pending.run_id, pending.generation, pending.terminal_message, pending.execution_claim_token)
        pending.terminal_projection_recorded = true
      } catch {
        // The sink may have committed before failing to publish. Its terminal
        // path closes after the first attempt, so retries use the idempotent
        // ledger settlement below rather than issuing another sink write.
      }
    }

    if (!pending.terminal_projection_recorded) {
      try {
        const outcome = await this.runs.settleTaskRunDispatch(
          pending.run_id,
          pending.generation,
          pending.state,
          pending.error,
          pending.failure,
          pending.execution_claim_token,
        )
        if (outcome === 'outcome_unknown') {
          await this.releaseSchedulerClaim(pending.run_id, pending.generation, pending.fencing, pending.owns_lease)
          this.abandonDurableSettlement(pending)
          return
        }
        if (outcome !== 'settled') {
          this.abandonDurableSettlement(pending)
          return
        }
      } catch {
        this.retryDurableSettlement(pending)
        return
      }
    }

    if (this.finalizing.get(key) !== pending || this.settled.has(key)) return
    this.finalizing.delete(key)
    this.settled.add(key)
    this.terminalPending.delete(key)
    this.stopRequested.delete(key)
    this.claimed.delete(key)
    if (pending.retry) clearTimeout(pending.retry)
    pending.retry = undefined
    this.stopSchedulerHeartbeat(key)
    if (!pending.lease_lost) {
      await this.releaseSchedulerClaim(pending.run_id, pending.generation, pending.fencing, pending.owns_lease)
    }
    if (pending.state === 'terminal') {
      await this.runs.advanceTaskRunQueue?.(pending.run_id, pending.generation).catch(() => undefined)
    }
  }

  private retryDurableSettlement(pending: PendingDurableSettlement): void {
    const key = `${pending.run_id}:${pending.generation}`
    if (this.finalizing.get(key) !== pending || pending.retry || this.settled.has(key)) return
    const delay = Math.min(30_000, 200 * 2 ** Math.min(7, pending.attempts - 1))
    pending.retry = setTimeout(() => {
      pending.retry = undefined
      void this.persistDurableSettlement(pending)
    }, delay)
    pending.retry.unref?.()
  }

  private startSchedulerHeartbeat(run: string, generation: number, fencing: number, expiresAt?: string, executionClaimToken?: string): void {
    const key = `${run}:${generation}`
    this.stopSchedulerHeartbeat(key)
    const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : 30_000
    const interval = Math.max(1, Math.min(10_000, Math.floor(remaining / 3)))
    let inFlight = false
    let timer!: ReturnType<typeof setInterval>
    const current = () => this.heartbeatTimers.get(key) === timer
    const loseLease = (error: 'SCHEDULER_LEASE_LOST' | 'SCHEDULER_HEARTBEAT_FAILED') => {
      if (!current()) return
      const pending = this.finalizing.get(key)
      if (pending) {
        pending.lease_lost = true
        this.stopSchedulerHeartbeat(key)
        return
      }
      void this.fail(run, generation, { fencing, owns_lease: true, ...(executionClaimToken === undefined ? {} : { execution_claim_token: executionClaimToken }), error })
    }
    timer = setInterval(() => {
      if (!current() || inFlight) return
      inFlight = true
      void this.scheduler.heartbeat(`agent-worker:${run}:${generation}`, fencing).then(receipt => {
        if (current() && (receipt.outcome !== 'admitted' || !this.scheduler.ownsLease(receipt.lease))) loseLease('SCHEDULER_LEASE_LOST')
      }).catch(() => {
        if (current()) loseLease('SCHEDULER_HEARTBEAT_FAILED')
      }).finally(() => {
        inFlight = false
      })
    }, interval)
    timer.unref?.()
    this.heartbeatTimers.set(key, timer)
  }

  private stopSchedulerHeartbeat(key: string): void {
    const heartbeat = this.heartbeatTimers.get(key)
    if (heartbeat) clearInterval(heartbeat)
    this.heartbeatTimers.delete(key)
  }

  private async releaseSchedulerClaim(run: string, generation: number, fencing: number | undefined, ownsLease: boolean): Promise<void> {
    const heartbeatKey = `${run}:${generation}`
    this.stopSchedulerHeartbeat(heartbeatKey)
    if (!fencing || !ownsLease) return
    const key = `${run}:${generation}:${fencing}`
    if (this.releasedSchedulerClaims.has(key)) return
    try {
      const receipt = await this.scheduler.complete(`agent-worker:${run}:${generation}`, fencing)
      if (receipt.outcome === 'admitted') this.releasedSchedulerClaims.add(key)
    } catch {
      // A stale or unavailable scheduler cannot change the already-durable
      // TaskRun terminal state. Its own lease reaper remains the fallback.
    }
  }
}
