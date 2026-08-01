import type { ServerPrivateCoreFactory } from './ipcLauncher.js'
import { productTaskMcpHost } from './mcpHost.js'
import { StandardProductAgentHostRuntime } from './productAgentHostRuntime.js'
import { restoreProductTextReasoningRoute } from '../product/productGatewayRuntime.js'
import type { ProductAgentSubtaskCoordinator } from './productSubtaskCoordinator.js'

/** The Local Product Server owns credentials, provider sampling and real Tool execution. */
export function createServerPrivateNativeCoreFactory(
  subtaskCoordinator: ProductAgentSubtaskCoordinator,
): ServerPrivateCoreFactory {
  return {
    start: async (identity, binding, input) => {
      const route = restoreProductTextReasoningRoute(
        { provider: binding.provider, model: binding.model },
        binding.model_route_fingerprint,
      )
      return new StandardProductAgentHostRuntime({
        task_id: identity.task_id,
        run_id: input.run_id,
        dispatch_generation: input.dispatch_generation,
        execution_claim_token: input.execution_claim_token,
        work_dir: binding.work_dir,
        permission_envelope: input.permission_envelope,
        mcp_host: productTaskMcpHost,
        attachment_paths: identity.initial_attachments,
        model_binding: route.binding,
        personal_profile: route.personalProfile,
        managed_transport: route.managedTransport,
        model_attempt_id: binding.model_attempt_id,
        ...(identity.subtask ? { subtask: identity.subtask } : {}),
        subtask_coordinator: subtaskCoordinator,
      })
    },
  }
}
