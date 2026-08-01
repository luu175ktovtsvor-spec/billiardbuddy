import type { AgentWorkerApprovalReviewFacts } from '../../../shared/product/agentWorker.js'
import type {
  ProductTaskActionApproval,
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskPlan,
  ProductTaskQuestion,
  ProductTaskRunFailure,
} from '../../../shared/product/taskEvents.js'
import type { ProductTool } from './productTool.js'

export type ProductAgentHarnessProjectionPort = {
  classifyFailure(error: unknown): ProductTaskRunFailure
  activityKindForTool(toolName: string | undefined): ProductTaskActivityKind
  activitySummary(kind: ProductTaskActivityKind, phase: ProductTaskActivityPhase): string
  projectPlan(input: unknown, runId: string, toolUseId: string): ProductTaskPlan | null
  projectQuestions(input: unknown): ProductTaskQuestion[]
  updateQuestionInput(input: Record<string, unknown>, answers: readonly string[]): Record<string, unknown> | null
  projectApproval(toolName: string): ProductTaskActionApproval
  projectApprovalReview(tool: ProductTool, input: unknown): AgentWorkerApprovalReviewFacts
}

export type ProductAgentHarnessModelPolicyPort = {
  resolve(requested?: string): string | null
  compactThreshold(model: string): number
}
