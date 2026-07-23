import { IpcAgentWorkerLauncher } from '../agent-worker/ipcLauncher.js'
import { serverPrivateNativeCoreFactory } from '../agent-worker/nativeCoreFactory.js'
import { AgentWorkerSupervisor } from './agentWorkerSupervisor.js'
import { ProductResourceScheduler } from './resourceScheduler.js'
import type { ProductTaskService } from './taskService.js'

const supervisors = new WeakMap<ProductTaskService, AgentWorkerSupervisor>()

/** One server-private bridge per live ProductTaskService/data root. */
export function dispatcherFor(tasks: ProductTaskService): AgentWorkerSupervisor {
  let supervisor = supervisors.get(tasks)
  if (!supervisor) {
    const scheduler = new ProductResourceScheduler({ statePath: tasks.workerSchedulerStatePath() })
    supervisor = new AgentWorkerSupervisor(
      tasks,
      scheduler,
      new IpcAgentWorkerLauncher(tasks, serverPrivateNativeCoreFactory),
    )
    supervisors.set(tasks, supervisor)
  }
  return supervisor
}
