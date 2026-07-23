import type { AgentWorkerStart, AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductResourceReceipt } from '../../../shared/product/resourceScheduler.js'
import { verifyPermissionExecutionEnvelope } from './permissionExecutionEnvelope.js'

export type AgentWorkerRunReader = { readTaskRunDispatchIdentity(runId: string, generation: number): Promise<{ task_id: string; lineage_id: string; resume_binding_id: string }>; claimTaskRunDispatch(runId: string, generation: number): Promise<{ outcome: 'claimed' | 'duplicate' | 'recovery_required'; task_id: string }> }
export type AgentWorkerCore = { input(text: string): Promise<void>; approve(requestId: string, approved: boolean): Promise<void>; stop(): Promise<void>; shutdown(): Promise<void> }
export type AgentWorkerCoreFactory = { start(input: { task_id: string; run_id: string; lineage_id: string; resume_binding_id: string; envelope_digest: string; scheduler_receipt: ProductResourceReceipt }): Promise<AgentWorkerCore> }

/** The launcher deliberately has no ProductTask mutation capability. */
export class AgentWorkerService {
  private core?: AgentWorkerCore
  private runId?: string
  constructor(private readonly runs: AgentWorkerRunReader, private readonly cores: AgentWorkerCoreFactory, private readonly now: () => Date = () => new Date()) {}

  async start(input: AgentWorkerStart): Promise<AgentWorkerOutbound> {
    if (this.core || !verifyPermissionExecutionEnvelope(input.envelope)) return { type: 'fatal', code: 'ENVELOPE_DENIED' }
    const receipt = input.scheduler_receipt
    if (receipt.outcome !== 'admitted' || receipt.job_id !== `agent-worker:${input.run_id}:${input.dispatch_generation}` || !receipt.fencing_token || !receipt.lease || receipt.fencing_token !== receipt.lease.fencing_token || Date.parse(receipt.lease.expires_at) <= this.now().getTime() || !receipt.resource_keys.includes('agent.worker')) return { type: 'fatal', code: 'SCHEDULER_DENIED' }
    try {
      const identity = await this.runs.readTaskRunDispatchIdentity(input.run_id, input.dispatch_generation)
      const claimed = await this.runs.claimTaskRunDispatch(input.run_id, input.dispatch_generation)
      if (claimed.outcome !== 'claimed') return { type: 'claim_receipt', outcome: claimed.outcome, run_id: input.run_id }
      this.core = await this.cores.start({ ...identity, run_id: input.run_id, envelope_digest: input.envelope.digest, scheduler_receipt: receipt })
      this.runId = input.run_id
      return { type: 'claim_receipt', outcome: 'claimed', run_id: input.run_id }
    } catch {
      return { type: 'fatal', code: 'CORE_FAILED' }
    }
  }
  async input(text: string): Promise<AgentWorkerOutbound | undefined> { if (!this.core || !text) return { type: 'fatal', code: 'NOT_READY' }; await this.core.input(text) }
  async approval(requestId: string, approved: boolean): Promise<AgentWorkerOutbound | undefined> { if (!this.core || !requestId) return { type: 'fatal', code: 'NOT_READY' }; await this.core.approve(requestId, approved) }
  async stop(): Promise<AgentWorkerOutbound> { if (!this.core || !this.runId) return { type: 'fatal', code: 'NOT_READY' }; await this.core.stop(); return { type: 'terminal', state: 'stopped', run_id: this.runId } }
  async shutdown(): Promise<void> { await this.core?.shutdown(); this.core = undefined }
}
