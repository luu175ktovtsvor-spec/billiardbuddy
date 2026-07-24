import { createServerPrivateNativeCorePort } from '../../cli/print.js'
import type { ServerPrivateCoreFactory } from './ipcLauncher.js'

/**
 * The Local Product Server's only production Core factory.  It invokes the
 * native QueryEngine port directly; public CLI argv parsing is never reached.
 */
export const serverPrivateNativeCoreFactory: ServerPrivateCoreFactory = {
  start: async (identity, binding, input) => createServerPrivateNativeCorePort({
    run_id: input.run_id,
    session_id: binding.session_id,
    work_dir: binding.work_dir,
    permission_envelope: input.permission_envelope,
    ...(identity.auto_memory ? {
      auto_memory: {
        storage_dir: identity.auto_memory.storage_dir,
        work_dir: binding.work_dir,
        enabled: identity.auto_memory.enabled,
        task_id: identity.task_id,
        entry_id: identity.auto_memory.entry_id,
      },
    } : {}),
    ...(identity.session_memory ? {
      session_memory: {
        storage_dir: identity.session_memory.storage_dir,
        task_id: identity.task_id,
        lineage_id: identity.lineage_id,
        resume_binding_id: identity.resume_binding_id,
        work_dir: binding.work_dir,
        entry_id: identity.session_memory.entry_id,
        ancestors: identity.session_memory.ancestors,
      },
    } : {}),
  }),
}
