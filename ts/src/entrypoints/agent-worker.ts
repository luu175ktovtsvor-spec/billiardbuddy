/** Internal framed worker entrypoint. Bootstrap arrives only over Bun private IPC. */
import { createInterface } from 'node:readline'
import { AgentWorkerProtocol } from '../server/agent-worker/framedProtocol.js'
import type { ProductHostEngineToolResult, ProductHostEngineToolSurface, ProductHostHookModelRequest, ProductHostRuntimeSnapshot } from '../server/agent-worker/productAgentHostRuntime.js'
import type { TaskRunExternalOperationKind } from '../server/product/taskRunLedgerModel.js'
import type { AgentWorkerBootstrap, AgentWorkerCore } from '../server/product/agentWorkerService.js'
import { AgentWorkerService } from '../server/product/agentWorkerService.js'
import type { AgentWorkerCoreIdentity } from '../server/product/agentWorkerSupervisor.js'
import { CodexEngineWorkerCore } from '../server/agent-engine/codexEngineWorkerCore.js'
import type { ProductModelEvent, ProductModelOperationReceipt, ProductPrompt } from '../../shared/product/harnessMessages.js'
import type { ProductTaskPlan } from '../../shared/product/taskEvents.js'
import type { AgentWorkerOutbound } from '../../shared/product/agentWorker.js'

type CoreBinding = { session_id: string; work_dir: string; provider: string; model: string; model_route_fingerprint: string; model_attempt_id: string }
type StartResult = { identity: AgentWorkerCoreIdentity; binding: CoreBinding }
type CoreRequest = {
  type: 'core_request'
  id: string
  operation: 'start' | 'chat_prompt' | 'command_prompt' | 'engine_tools' | 'engine_model' | 'hook_model' | 'model_ack' | 'engine_tool' | 'plan' | 'context_compaction' | 'approval' | 'question' | 'stop' | 'shutdown' | 'external_operation_begin' | 'external_operation_result' | 'external_operation_checkpoint' | 'external_operation_mcp_checkpoint' | 'external_operation_unknown'
  execution_claim_token?: string
  value?: unknown
}
type PendingRequest = {
  chunks: unknown[]
  done: boolean
  error?: Error
  resolve(value?: unknown): void
  reject(error: Error): void
  wake?: () => void
}

let sequence = 0
const pending = new Map<string, PendingRequest>()
let activeExecutionClaimToken: string | undefined

function beginRequest(operation: CoreRequest['operation'], value?: unknown): { id: string; promise: Promise<unknown>; entry: PendingRequest } {
  const id = `core_${++sequence}`
  let resolve!: (value?: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((next, fail) => { resolve = next; reject = fail })
  const entry: PendingRequest = { chunks: [], done: false, resolve, reject }
  pending.set(id, entry)
  process.send?.({ type: 'core_request', id, operation, ...(activeExecutionClaimToken ? { execution_claim_token: activeExecutionClaimToken } : {}), value } satisfies CoreRequest)
  return { id, promise, entry }
}

function request(operation: CoreRequest['operation'], value?: unknown): Promise<unknown> {
  return beginRequest(operation, value).promise
}

type ParentEffectResult<T> = { value: T; operation_id: string }

function parseOperationId(value: unknown): string | undefined {
  return value && typeof value === 'object' && /^effect_[a-f0-9-]{36}$/.test(String((value as { operation_id?: unknown }).operation_id))
    ? (value as { operation_id: string }).operation_id
    : undefined
}

async function* requestStream(
  operation: CoreRequest['operation'],
  value?: unknown,
  onComplete?: (value: unknown) => Promise<void>,
): AsyncGenerator<unknown, void> {
  const { id, entry, promise } = beginRequest(operation, value)
  void promise.catch(() => undefined)
  try {
    while (!entry.done || entry.chunks.length > 0) {
      if (entry.chunks.length > 0) { yield entry.chunks.shift(); continue }
      if (entry.error) throw entry.error
      await new Promise<void>(resolve => { entry.wake = resolve })
    }
    if (entry.error) throw entry.error
    const result = await promise
    if (onComplete) await onComplete(result)
  } finally {
    pending.delete(id)
  }
}


let protocol: AgentWorkerProtocol | undefined
function emit(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
  process.send?.({ type: 'worker_outbound', message })
}

process.on('message', (message: unknown) => {
  const record = message && typeof message === 'object' ? message as Record<string, unknown> : undefined
  if (record?.type === 'bootstrap' && record.bootstrap && !protocol) {
    const bootstrap = record.bootstrap as AgentWorkerBootstrap
    const service = new AgentWorkerService({
      ...bootstrap,
      cores: {
        start: async input => {
          activeExecutionClaimToken = input.execution_claim_token
          try {
            const start = await request('start', input) as StartResult
            const engine = await CodexEngineWorkerCore.create({
              identity: start.identity,
              binding: start.binding,
              run_id: input.run_id,
              permission_envelope: input.permission_envelope,
              parent: {
                  beginExternalOperation: async kind => {
                    const started = await request('external_operation_begin', { kind })
                    const operationId = parseOperationId(started)
                    if (!operationId) throw new Error('TASK_RUN_EXTERNAL_OPERATION_DENIED')
                    return operationId
                  },
                  recordExternalOperationResult: async operationId => { await request('external_operation_result', { operation_id: operationId }) },
                  checkpointExternalOperation: async (operationId, checkpointDigest) => { await request('external_operation_checkpoint', { operation_id: operationId, checkpoint_digest: checkpointDigest }) },
                  markExternalOperationUnknown: async operationId => { await request('external_operation_unknown', { operation_id: operationId }) },
                  chatPrompt: async (text, attachments) => {
                    const result = await request('chat_prompt', { text, attachments })
                    if (!result || typeof result !== 'object' || !('operation_id' in result) || !('value' in result)) throw new Error('CODEX_ENGINE_ATTACHMENT_PROMPT_UNAVAILABLE')
                    const operationId = parseOperationId(result)
                    const prompt = (result as ParentEffectResult<ProductPrompt>).value
                    if (!operationId || (typeof prompt !== 'string' && !Array.isArray(prompt))) throw new Error('CODEX_ENGINE_ATTACHMENT_PROMPT_UNAVAILABLE')
                    return { operation_id: operationId, prompt }
                  },
                  commandPrompt: async (name, args) => {
                    const result = await request('command_prompt', { name, args })
                    if (!result || typeof result !== 'object' || !('operation_id' in result) || !('value' in result)) throw new Error('CODEX_ENGINE_COMMAND_PROMPT_UNAVAILABLE')
                    const operationId = parseOperationId(result)
                    const prompt = (result as ParentEffectResult<ProductPrompt>).value
                    if (!operationId || (typeof prompt !== 'string' && !Array.isArray(prompt))) throw new Error('CODEX_ENGINE_COMMAND_PROMPT_UNAVAILABLE')
                    return { operation_id: operationId, prompt }
                  },
                  engineTools: async () => {
                    const result = await request('engine_tools')
                    if (!result || typeof result !== 'object' || !('operation_id' in result) || !('value' in result)) throw new Error('CODEX_ENGINE_TOOL_SURFACE_UNAVAILABLE')
                    const operationId = parseOperationId(result)
                    const value = (result as ParentEffectResult<{ surface: ProductHostEngineToolSurface; snapshot: ProductHostRuntimeSnapshot }>).value
                    const surface = value?.surface
                    const snapshot = value?.snapshot
                    if (
                      !operationId || !surface || typeof surface !== 'object'
                      || !snapshot || typeof snapshot !== 'object'
                      || !Array.isArray(snapshot.commands) || !Array.isArray(snapshot.tools) || !Array.isArray(snapshot.mcp_clients)
                    ) throw new Error('CODEX_ENGINE_TOOL_SURFACE_UNAVAILABLE')
                    return { operation_id: operationId, surface, snapshot }
                  },
                  checkpointMcpPrepare: async (operationId, snapshot) => {
                    await request('external_operation_mcp_checkpoint', { operation_id: operationId, snapshot })
                  },
                  engineModel: (operationId, value) => requestStream('engine_model', { operation_id: operationId, ...value }) as AsyncGenerator<ProductModelEvent, void>,
                  hookModel: (operationId, value) => requestStream('hook_model', { operation_id: operationId, ...value } satisfies { operation_id: string } & ProductHostHookModelRequest) as AsyncGenerator<ProductModelEvent, void>,
                  acknowledgeModelResult: async (operationId, receipt) => { await request('model_ack', { operation_id: operationId, receipt } satisfies { operation_id: string; receipt: ProductModelOperationReceipt }) },
                  engineTool: async (operationId, value) => await request('engine_tool', { operation_id: operationId, ...value }) as ProductHostEngineToolResult,
                  recordPlan: async (operationId, plan) => { await request('plan', { operation_id: operationId, plan } satisfies { operation_id: string; plan: ProductTaskPlan }) },
                  recordContextCompaction: async compaction => { await request('context_compaction', compaction) },
                  approve: async (requestId, approved) => { await request('approval', { requestId, approved }) },
                  answer: async (requestId, answers) => { await request('question', { requestId, answers }) },
                  stopHost: async () => { await request('stop') },
                  shutdownHost: async () => { await request('shutdown') },
              },
            })
            const unsubscribe = engine.subscribe(message => protocol?.relayCoreMessage(message))
            let firstInput = true
            const core: AgentWorkerCore = {
              input: async (text, attachments, queueItemId) => {
                const initialAttachments = firstInput && !queueItemId ? start.identity.initial_attachments : attachments
                if (!queueItemId) firstInput = false
                return await engine.input(text, initialAttachments, queueItemId)
              },
              approve: async (requestId, approved) => { await engine.approve(requestId, approved) },
              answer: async (requestId, answers) => { await engine.answer(requestId, answers) },
              stop: async () => { await engine.stop() },
              shutdown: async () => { unsubscribe(); await engine.shutdown() },
            }
            return core
          } catch (error) {
            activeExecutionClaimToken = undefined
            throw error
          }
        },
      },
    })
    protocol = new AgentWorkerProtocol(service, emit)
    protocol.announce()
    return
  }
  if (record?.type === 'core_result' && typeof record.id === 'string') {
    const entry = pending.get(record.id)
    if (!entry) return
    entry.done = true
    if (record.ok === true) entry.resolve(record.value)
    else { entry.error = new Error('CORE_PORT_DENIED'); entry.reject(entry.error) }
    entry.wake?.()
    if (entry.chunks.length === 0) pending.delete(record.id)
    return
  }
  if (record?.type === 'runtime_chunk' && typeof record.id === 'string') {
    const entry = pending.get(record.id)
    if (!entry) return
    entry.chunks.push(record.value)
    entry.wake?.()
    entry.wake = undefined
    return
  }
  if (record?.type === 'runtime_event' && protocol) {
    protocol.relayCoreMessage(record.message as AgentWorkerOutbound)
  }
})

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => protocol ? protocol.receive(line) : emit({ type: 'fatal', code: 'ENVELOPE_DENIED' }))
