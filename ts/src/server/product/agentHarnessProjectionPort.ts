import type { ProductAgentHarnessProjectionPort } from '../agent-worker/agentHarnessPorts.js'
import { projectAgentWorkerApprovalReview, projectProductTaskActionApproval } from './taskApprovalProjection.js'
import {
  productTaskActivityKindForTool,
  productTaskActivitySummary,
  projectProductTaskPlan,
  projectAnswerableAskUserQuestions,
} from './taskEventProjection.js'
import { buildProductTaskAskUserQuestionUpdatedInput } from './taskInboundPolicy.js'
import { classifyProductTaskRunFailure } from './taskRunFailure.js'

export const productAgentHarnessProjectionPort: ProductAgentHarnessProjectionPort = {
  classifyFailure: classifyProductTaskRunFailure,
  activityKindForTool: productTaskActivityKindForTool,
  activitySummary: productTaskActivitySummary,
  projectPlan: projectProductTaskPlan,
  projectQuestions: projectAnswerableAskUserQuestions,
  updateQuestionInput: buildProductTaskAskUserQuestionUpdatedInput,
  projectApproval: projectProductTaskActionApproval,
  projectApprovalReview: projectAgentWorkerApprovalReview,
}
