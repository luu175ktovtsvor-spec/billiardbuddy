import type { PermissionExecutionEnvelope } from './permissionExecutionEnvelope.js'
import type { ProductResourceReceipt } from './resourceScheduler.js'

export const AGENT_WORKER_PROTOCOL_VERSION = 1 as const
export const AGENT_WORKER_MAX_FRAME_BYTES = 64 * 1024

export type AgentWorkerVersionRange = { min: number; max: number }
export type AgentWorkerStart = {
  type: 'start'
  run_id: string
  dispatch_generation: number
  scheduler_receipt: ProductResourceReceipt
  envelope: PermissionExecutionEnvelope
}
export type AgentWorkerInbound =
  | { type: 'hello'; versions: AgentWorkerVersionRange; capabilities: string[] }
  | { type: 'ready' }
  | AgentWorkerStart
  | { type: 'input'; text: string }
  | { type: 'approval_response'; request_id: string; approved: boolean }
  | { type: 'stop' }
  | { type: 'shutdown' }

export type AgentWorkerOutbound =
  | { type: 'hello'; versions: AgentWorkerVersionRange; capabilities: string[] }
  | { type: 'ready' }
  | { type: 'claim_receipt'; outcome: 'claimed' | 'duplicate' | 'recovery_required' | 'rejected'; run_id: string; code?: string }
  | { type: 'event'; event: 'started' | 'delta' | 'tool' | 'approval' | 'stopping'; data?: string }
  | { type: 'terminal'; state: 'completed' | 'stopped' | 'recovery_required'; run_id: string }
  | { type: 'fatal'; code: 'FRAME_INVALID' | 'FRAME_TOO_LARGE' | 'PROTOCOL_INVALID' | 'CAPABILITY_MISMATCH' | 'MODEL_CONFIGURATION_INVALID' | 'NOT_READY' | 'ENVELOPE_DENIED' | 'SCHEDULER_DENIED' | 'CORE_FAILED'; message?: string }
  | { type: 'shutdown' }

export function intersectsAgentWorkerVersions(left: AgentWorkerVersionRange, right: AgentWorkerVersionRange): boolean {
  return Number.isInteger(left.min) && Number.isInteger(left.max) && Number.isInteger(right.min) && Number.isInteger(right.max) && left.min <= left.max && right.min <= right.max && Math.max(left.min, right.min) <= Math.min(left.max, right.max)
}
