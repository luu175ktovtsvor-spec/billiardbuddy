import { IpcAgentWorkerLauncher } from './ipcLauncher.js'
import { serverPrivateNativeCoreFactory } from './nativeCoreFactory.js'
import { AgentWorkerSupervisor } from '../product/agentWorkerSupervisor.js'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'
import { ProductTaskWorkerMessageSink } from '../product/taskRunDispatchBridge.js'
import type { ProductTaskRunDispatchPort } from '../product/taskRunDispatchPort.js'
import type { ProductTaskService } from '../product/taskService.js'

export type ProductTaskRunComposition = {
  dispatcher: ProductTaskRunDispatchPort
  shutdown(): Promise<void>
}

/** Server Composition Root for one Local Product Server task-runtime lifetime. */
export function createProductTaskRunComposition(resolveTasks: () => ProductTaskService): ProductTaskRunComposition {
  let supervisor: AgentWorkerSupervisor | undefined
  const resolveSupervisor = () => {
    if (supervisor) return supervisor
    const tasks = resolveTasks()
    const scheduler = new ProductResourceScheduler({ statePath: tasks.workerSchedulerStatePath() })
    supervisor = new AgentWorkerSupervisor(
      tasks,
      scheduler,
      new IpcAgentWorkerLauncher(tasks, serverPrivateNativeCoreFactory),
      5_000,
      new ProductTaskWorkerMessageSink(tasks),
    )
    return supervisor
  }
  return {
    dispatcher: {
      dispatch: (...input) => resolveSupervisor().dispatch(...input),
      stop: (...input) => resolveSupervisor().stop(...input),
      approve: (...input) => resolveSupervisor().approve(...input),
      answer: (...input) => resolveSupervisor().answer(...input),
      steer: (...input) => resolveSupervisor().steer(...input),
    },
    async shutdown() {
      const active = supervisor
      supervisor = undefined
      await active?.shutdown()
    },
  }
}
