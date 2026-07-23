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
  }),
}
