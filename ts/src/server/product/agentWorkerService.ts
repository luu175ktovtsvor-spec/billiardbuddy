import type { AgentWorkerStart, AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductResourceReceipt } from '../../../shared/product/resourceScheduler.js'
import { verifyAgentWorkerChildStartCapability, verifyPermissionExecutionEnvelope, type AgentWorkerChildStartCapability } from './permissionExecutionEnvelope.js'

export type AgentWorkerCore = { input(text: string): Promise<void>; approve(requestId: string, approved: boolean): Promise<void>; stop(): Promise<void>; shutdown(): Promise<void> }
/** Identity is closed over by the server-private factory, never serialized to the worker protocol. */
export type AgentWorkerCoreFactory = { start(input: { run_id: string; dispatch_generation: number; envelope_digest: string; scheduler_receipt: ProductResourceReceipt }): Promise<AgentWorkerCore> }
export type AgentWorkerBootstrap = { capability: AgentWorkerChildStartCapability; capability_key: Buffer; cores: AgentWorkerCoreFactory }

/** The launcher deliberately has no ProductTask mutation capability. */
export class AgentWorkerService {
  private core?: AgentWorkerCore
  private runId?: string
  constructor(private readonly bootstrap: AgentWorkerBootstrap, private readonly now: () => Date = () => new Date()) {}

  async start(input: AgentWorkerStart): Promise<AgentWorkerOutbound> {
    if (this.core || !verifyPermissionExecutionEnvelope(input.envelope) || !verifyAgentWorkerChildStartCapability(this.bootstrap.capability, this.bootstrap.capability_key)) return { type: 'fatal', code: 'ENVELOPE_DENIED' }
    const receipt = input.scheduler_receipt
    if (receipt.outcome !== 'admitted' || receipt.job_id !== `agent-worker:${input.run_id}:${input.dispatch_generation}` || !receipt.fencing_token || !receipt.lease || receipt.fencing_token !== receipt.lease.fencing_token || Date.parse(receipt.lease.expires_at) <= this.now().getTime() || !receipt.resource_keys.includes('agent.worker')) return { type: 'fatal', code: 'SCHEDULER_DENIED' }
    try {
      const capability = this.bootstrap.capability
      if (capability.run_id !== input.run_id || capability.dispatch_generation !== input.dispatch_generation || capability.fencing_token !== receipt.fencing_token || capability.envelope_digest !== input.envelope.digest) return { type: 'fatal', code: 'ENVELOPE_DENIED' }
      this.core = await this.bootstrap.cores.start({ run_id: input.run_id, dispatch_generation: input.dispatch_generation, envelope_digest: input.envelope.digest, scheduler_receipt: receipt })
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
