import type { PermissionExecutionEnvelope } from './permissionExecutionEnvelope.js'
import type { ProductResourceReceipt } from './resourceScheduler.js'
import type { ProductTaskActionApproval, ProductTaskQuestion, ProductTaskRunActivity, ProductTaskRunFailure } from './taskEvents.js'

export const AGENT_WORKER_PROTOCOL_VERSION = 1 as const
export const AGENT_WORKER_MAX_FRAME_BYTES = 64 * 1024

export type AgentWorkerApprovalReviewFacts = {
  category: 'filesystem' | 'command' | 'network' | 'extension' | 'other'
  read_only: boolean
  destructive: boolean
  open_world: boolean
}

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
  | { type: 'steer'; queue_item_id: string; text: string }
  | { type: 'approval_response'; request_id: string; approved: boolean }
  | { type: 'question_response'; request_id: string; answers: string[] }
  | { type: 'stop' }
  | { type: 'shutdown' }

export type AgentWorkerOutbound =
  | { type: 'hello'; versions: AgentWorkerVersionRange; capabilities: string[] }
  | { type: 'ready' }
  | { type: 'claim_receipt'; outcome: 'claimed' | 'duplicate' | 'recovery_required' | 'rejected'; run_id: string; code?: string }
  | { type: 'event'; event: 'started' | 'delta' | 'stopping'; data?: string }
  | { type: 'event'; event: 'activity'; activity: ProductTaskRunActivity }
  | { type: 'event'; event: 'extension_snapshot'; digest: string; tool_count: number; command_count: number; mcp_server_count: number }
  | { type: 'event'; event: 'approval'; request_id: string; action: ProductTaskActionApproval; review: AgentWorkerApprovalReviewFacts }
  | { type: 'event'; event: 'question'; request_id: string; questions: ProductTaskQuestion[] }
  | { type: 'event'; event: 'context_compaction'; phase: 'started'; source: 'automatic' | 'manual'; generation: number; input_tokens: number }
  | { type: 'event'; event: 'context_compaction'; phase: 'completed'; source: 'automatic' | 'manual'; generation: number; input_tokens: number; output_tokens: number; summary: string; compacted_through_event_sequence: number }
  | { type: 'event'; event: 'context_compaction'; phase: 'failed'; source: 'automatic' | 'manual'; generation: number; input_tokens: number }
  | { type: 'steer_consumed'; queue_item_id: string }
  | { type: 'terminal'; state: 'completed' | 'stopped' | 'recovery_required'; run_id: string; failure?: ProductTaskRunFailure }
  | { type: 'fatal'; code: 'FRAME_INVALID' | 'FRAME_TOO_LARGE' | 'PROTOCOL_INVALID' | 'CAPABILITY_MISMATCH' | 'MODEL_CONFIGURATION_INVALID' | 'NOT_READY' | 'ENVELOPE_DENIED' | 'SCHEDULER_DENIED' | 'CORE_FAILED'; message?: string }
  | { type: 'shutdown' }

export function intersectsAgentWorkerVersions(left: AgentWorkerVersionRange, right: AgentWorkerVersionRange): boolean {
  return Number.isInteger(left.min) && Number.isInteger(left.max) && Number.isInteger(right.min) && Number.isInteger(right.max) && left.min <= left.max && right.min <= right.max && Math.max(left.min, right.min) <= Math.min(left.max, right.max)
}
