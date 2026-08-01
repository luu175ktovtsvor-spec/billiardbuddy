import { IpcAgentWorkerLauncher } from './ipcLauncher.js'
import { createServerPrivateNativeCoreFactory } from './nativeCoreFactory.js'
import { createProductAgentSubtaskCoordinator } from './productSubtaskCoordinator.js'
import { AgentWorkerSupervisor } from '../product/agentWorkerSupervisor.js'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'
import { ProductTaskWorkerMessageSink } from '../product/taskRunDispatchBridge.js'
import type { ProductTaskRunDispatchPort } from '../product/taskRunDispatchPort.js'
import type { ProductTaskRuntimeEventPort } from '../product/taskRuntimeEventPort.js'
import type { ProductTaskRunLedger } from '../product/taskRunLedgerPort.js'

export type ProductTaskRunComposition = {
  dispatcher: ProductTaskRunDispatchPort
  shutdown(): Promise<void>
}

/** Server Composition Root for one Local Product Server task-runtime lifetime. */
export function createProductTaskRunComposition(
  tasks: ProductTaskRunLedger,
  scheduler: ProductResourceScheduler,
  runtimeEvents: ProductTaskRuntimeEventPort,
): ProductTaskRunComposition {
  let supervisor: AgentWorkerSupervisor | undefined
  const resolveSupervisor = (): AgentWorkerSupervisor => {
    if (supervisor) return supervisor
    supervisor = new AgentWorkerSupervisor(
      tasks,
      scheduler,
      new IpcAgentWorkerLauncher(
        tasks,
        createServerPrivateNativeCoreFactory(
          createProductAgentSubtaskCoordinator(tasks, {
            dispatch: (runId, generation, kind) => resolveSupervisor().dispatch(runId, generation, kind),
            stop: (runId, generation) => resolveSupervisor().stop(runId, generation),
          }),
        ),
      ),
      5_000,
      new ProductTaskWorkerMessageSink(tasks, runtimeEvents),
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
