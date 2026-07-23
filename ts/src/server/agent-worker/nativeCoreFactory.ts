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
