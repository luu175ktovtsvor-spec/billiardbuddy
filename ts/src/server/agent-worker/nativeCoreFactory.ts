import type { ServerPrivateCoreFactory } from './ipcLauncher.js'
import { productTaskMcpHost } from './mcpHost.js'
import { StandardProductAgentHostRuntime } from './productAgentHostRuntime.js'
import { restoreProductTextReasoningRoute } from '../product/productGatewayRuntime.js'

/** The Local Product Server owns credentials, provider sampling and real Tool execution. */
export const serverPrivateNativeCoreFactory: ServerPrivateCoreFactory = {
  start: async (identity, binding, input) => {
    const route = restoreProductTextReasoningRoute(
      { provider: binding.provider, model: binding.model },
      binding.model_route_fingerprint,
    )
    return new StandardProductAgentHostRuntime({
      task_id: identity.task_id,
      work_dir: binding.work_dir,
      permission_envelope: input.permission_envelope,
      mcp_host: productTaskMcpHost,
      attachment_paths: identity.initial_attachments,
      model_binding: route.binding,
      personal_profile: route.personalProfile,
      model_attempt_id: binding.model_attempt_id,
    })
  },
}
