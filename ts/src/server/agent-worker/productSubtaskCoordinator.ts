import type { ProductHostEngineToolResult } from './productAgentHostRuntime.js'
import type { ProductTaskRunDispatchPort } from '../product/taskRunDispatchPort.js'
import type { ProductTaskRunLedger } from '../product/taskRunLedgerPort.js'

export type ProductAgentSubtaskCoordinator = {
  run(input: {
    parent_run_id: string
    parent_dispatch_generation: number
    parent_execution_claim_token: string
    parent_operation_id: string
    parent_tool_call_id: string
    prompt: string
    description: string
    signal: AbortSignal
  }): Promise<ProductHostEngineToolResult>
}

function waitForNextResult(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('SUBTASK_PARENT_STOPPED'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, 80)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new Error('SUBTASK_PARENT_STOPPED'))
    }
    function done() {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Coordinates one source-requested Subtask through a durable BilliardBuddy
 * child Run. The parent still owns its outer tool receipt; the child owns its
 * own worker, Thread, model/tool effects and terminal projection.
 */
export function createProductAgentSubtaskCoordinator(
  tasks: ProductTaskRunLedger,
  dispatcher: ProductTaskRunDispatchPort,
): ProductAgentSubtaskCoordinator {
  return {
    async run(input) {
      const child = await tasks.createTaskRunSubtask({
        parent_run_id: input.parent_run_id,
        parent_dispatch_generation: input.parent_dispatch_generation,
        parent_execution_claim_token: input.parent_execution_claim_token,
        parent_operation_id: input.parent_operation_id,
        parent_tool_call_id: input.parent_tool_call_id,
        prompt: input.prompt,
        description: input.description,
      })
      try {
        let admission = await dispatcher.dispatch(child.run_id, child.dispatch_generation)
        while (admission === 'queued') {
          await waitForNextResult(input.signal)
          admission = await dispatcher.dispatch(child.run_id, child.dispatch_generation)
        }
        if (admission === 'recovery_required') throw new Error('SUBTASK_DISPATCH_FAILED')
        while (true) {
          const result = await tasks.readTaskRunSubtaskResult({
            parent_run_id: input.parent_run_id,
            parent_dispatch_generation: input.parent_dispatch_generation,
            parent_execution_claim_token: input.parent_execution_claim_token,
            parent_operation_id: input.parent_operation_id,
            parent_tool_call_id: input.parent_tool_call_id,
            run_id: child.run_id,
          })
          if (result.state === 'running') {
            await waitForNextResult(input.signal)
            continue
          }
          if (result.state === 'completed') return { is_error: false, content: result.text }
          if (result.state === 'stopped') return { is_error: true, content: result.text || 'Subtask stopped before producing a result.' }
          if (result.state === 'recovery_required') return { is_error: true, content: result.text || 'Subtask requires recovery before its result can be used.' }
          return { is_error: true, content: 'Subtask outcome is unknown and will not be replayed automatically.' }
        }
      } catch (error) {
        if (input.signal.aborted) await dispatcher.stop?.(child.run_id, child.dispatch_generation).catch(() => undefined)
        throw error
      }
    },
  }
}
