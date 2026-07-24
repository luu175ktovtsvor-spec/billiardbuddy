import type { AgentWorkerApprovalReviewFacts } from '../../../shared/product/agentWorker.js'

export type AutomaticApprovalDecision = {
  allowed: boolean
  reason: 'read_only_local' | 'destructive' | 'data_egress' | 'write_boundary' | 'unknown_capability'
}

/** Independent, deterministic and intentionally conservative auto reviewer. */
export function reviewAutomaticApproval(facts: AgentWorkerApprovalReviewFacts): AutomaticApprovalDecision {
  if (facts.destructive) return { allowed: false, reason: 'destructive' }
  if (facts.open_world || facts.category === 'network' || facts.category === 'extension') return { allowed: false, reason: 'data_egress' }
  if (!facts.read_only) return { allowed: false, reason: 'write_boundary' }
  if (facts.category !== 'filesystem' && facts.category !== 'command') return { allowed: false, reason: 'unknown_capability' }
  return { allowed: true, reason: 'read_only_local' }
}
