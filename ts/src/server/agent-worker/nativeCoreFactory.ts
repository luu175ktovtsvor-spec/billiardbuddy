import type { ServerPrivateCoreFactory } from './ipcLauncher.js'
import { productTaskMcpHost } from './mcpHost.js'
import { StandardProductAgentHostRuntime } from './productAgentHostRuntime.js'

/** The Local Product Server owns credentials, provider sampling and real Tool execution. */
export const serverPrivateNativeCoreFactory: ServerPrivateCoreFactory = {
  start: async (identity, binding, input) => new StandardProductAgentHostRuntime({
    task_id: identity.task_id,
    work_dir: binding.work_dir,
    permission_envelope: input.permission_envelope,
    mcp_host: productTaskMcpHost,
    attachment_paths: identity.initial_attachments,
  }),
}
