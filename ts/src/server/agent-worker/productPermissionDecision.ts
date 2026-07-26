import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { reviewAutomaticApproval } from '../product/automaticApprovalReviewer.js'
import { projectAgentWorkerApprovalReview } from '../product/taskApprovalProjection.js'
import type { ProductPermissionDecision, ProductTool, ProductToolContext } from './productTool.js'

/** Host-owned, frozen Turn permission policy. */
export async function decideProductToolPermission(
  envelope: PermissionExecutionEnvelope,
  tool: ProductTool,
  input: Record<string, unknown>,
  context: ProductToolContext,
): Promise<ProductPermissionDecision> {
  if (context.abortController.signal.aborted) throw new Error('PRODUCT_PERMISSION_ABORTED')
  const parsed = tool.inputSchema.parse(input)
  if (envelope.network_scope === 'denied' && tool.isOpenWorld(parsed)) {
    return { behavior: 'deny', message: 'Network access is disabled for this Turn', reason: `mode:${context.permissionContext.mode}` }
  }
  const toolDecision = await tool.checkPermissions(parsed, context)
  if (toolDecision.behavior === 'deny') return toolDecision
  if (toolDecision.behavior === 'allow') return toolDecision
  const reason = `mode:${context.permissionContext.mode}`
  if (envelope.approval_policy === 'never') {
    return { behavior: 'allow', updatedInput: parsed, reason }
  }
  if (envelope.approval_policy === 'automatic_reviewer') {
    const reviewed = reviewAutomaticApproval(projectAgentWorkerApprovalReview(tool, parsed))
    return reviewed.allowed
      ? { behavior: 'allow', updatedInput: parsed, reason }
      : { behavior: 'deny', message: `Automatic policy denied this operation: ${reviewed.reason}`, reason, toolUseID: context.toolUseId ?? '' }
  }
  if (tool.isReadOnly(parsed) && !tool.isMcp && !tool.isOpenWorld(parsed) && tool.name !== 'WebFetch') {
    return { behavior: 'allow', updatedInput: parsed, reason }
  }
  return {
    behavior: 'ask',
    message: toolDecision.message || `Approval required for ${tool.name}`,
    reason,
  }
}
