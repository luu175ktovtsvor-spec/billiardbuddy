/** Internal framed worker entrypoint. Bootstrap arrives only over Bun private IPC. */
import { createInterface } from 'node:readline'
import { AgentWorkerProtocol } from '../server/agent-worker/framedProtocol.js'
import { createProductAgentHarness } from '../server/agent-worker/productAgentHarness.js'
import type { ProductHarnessSessionExternalOperationCheckpoint, ProductHarnessSessionExternalOperationCheckpointInput } from '../server/agent-worker/harnessSessionRepository.js'
import { productAgentHarnessProjectionPort } from '../server/product/agentHarnessProjectionPort.js'
import { productAgentHarnessModelPolicyPort } from '../server/product/agentHarnessModelPolicyPort.js'
import { ProductSkillTool } from '../server/agent-worker/productSkillTool.js'
import { ProductSubtaskTool } from '../server/agent-worker/productSubtaskTool.js'
import type { ProductHostEngineToolResult, ProductHostEngineToolSurface, ProductHostRuntimeSnapshot } from '../server/agent-worker/productAgentHostRuntime.js'
import type { TaskRunExternalOperationKind } from '../server/product/taskRunLedgerModel.js'
import { runProductTools } from '../server/agent-worker/productToolExecution.js'
import type { AgentWorkerBootstrap, AgentWorkerCore, AgentWorkerCoreFactory } from '../server/product/agentWorkerService.js'
import { AgentWorkerService } from '../server/product/agentWorkerService.js'
import type { AgentWorkerCoreIdentity } from '../server/product/agentWorkerSupervisor.js'
import type { ProductAgentHarnessPort } from '../server/agent-worker/productAgentHarness.js'
import { CodexEngineWorkerCore } from '../server/agent-engine/codexEngineWorkerCore.js'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductModelEvent, ProductToolCallBlock } from '../../shared/product/harnessMessages.js'
import type { AgentWorkerOutbound } from '../../shared/product/agentWorker.js'
import type { ProductCanUseTool, ProductCommand, ProductContentBlock, ProductThinkingConfig, ProductTool, ProductToolContext } from '../server/agent-worker/productTool.js'

type CoreBinding = { session_id: string; work_dir: string; provider: string; model: string; model_route_fingerprint: string; model_attempt_id: string }
type StartResult = { identity: AgentWorkerCoreIdentity; binding: CoreBinding }
type CoreRequest = {
  type: 'core_request'
  id: string
  operation: 'start' | 'prepare' | 'command_prompt' | 'chat_prompt' | 'model' | 'engine_tools' | 'engine_model' | 'engine_tool' | 'tools' | 'approval' | 'question' | 'stop' | 'shutdown' | 'external_operation_begin' | 'external_operation_result' | 'external_operation_checkpoint' | 'external_operation_mcp_checkpoint' | 'external_operation_unknown'
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

/**
 * Receipts move from definite result to clear only after a session snapshot
 * (or MCP extension snapshot) records the same opaque operation identity.
 * Parent-hosted and child-local effects share this coordinator; neither code
 * path may decide on its own that a returned Promise is durable.
 */
class ExternalOperationCheckpointCoordinator {
  private readonly sessionPending = new Map<string, TaskRunExternalOperationKind>()
  private mcpPrepare?: string

  constructor(private readonly dispatchGeneration: number) {}

  registerParentResult(kind: TaskRunExternalOperationKind, value: unknown): void {
    const operationId = parseOperationId(value)
    if (!operationId) throw new Error('TASK_RUN_EXTERNAL_OPERATION_RESULT_INVALID')
    this.registerResult(kind, operationId)
  }

  async recordLocalResult(kind: TaskRunExternalOperationKind, operationId: string): Promise<void> {
    await request('external_operation_result', { operation_id: operationId })
    this.registerResult(kind, operationId)
  }

  sessionCheckpointInputs(): ProductHarnessSessionExternalOperationCheckpointInput[] {
    return [...this.sessionPending.entries()].map(([operation_id, kind]) => ({
      operation_id,
      kind,
      dispatch_generation: this.dispatchGeneration,
    }))
  }

  /**
   * A crash can happen after the private session file fsyncs but before the
   * parent receives its checkpoint IPC. Re-submit only proofs from this exact
   * Run generation before an ACK or a new effect is allowed.
   */
  async reconcileSession(records: readonly ProductHarnessSessionExternalOperationCheckpoint[]): Promise<void> {
    for (const record of records) {
      if (record.dispatch_generation !== this.dispatchGeneration) continue
      await request('external_operation_checkpoint', {
        operation_id: record.operation_id,
        checkpoint_digest: record.checkpoint_digest,
      })
    }
  }

  async checkpointSession(records: readonly ProductHarnessSessionExternalOperationCheckpoint[]): Promise<void> {
    for (const record of records) {
      if (record.dispatch_generation !== this.dispatchGeneration || this.sessionPending.get(record.operation_id) !== record.kind) throw new Error('TASK_RUN_EXTERNAL_OPERATION_CHECKPOINT_INVALID')
      await request('external_operation_checkpoint', {
        operation_id: record.operation_id,
        checkpoint_digest: record.checkpoint_digest,
      })
      this.sessionPending.delete(record.operation_id)
    }
  }

  async checkpointMcpPrepare(snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number }): Promise<void> {
    const operationId = this.mcpPrepare
    if (!operationId) throw new Error('TASK_RUN_MCP_CHECKPOINT_MISSING')
    await request('external_operation_mcp_checkpoint', { operation_id: operationId, snapshot })
    this.mcpPrepare = undefined
  }

  async markPendingUnknown(): Promise<void> {
    const operationIds = [...this.sessionPending.keys(), ...(this.mcpPrepare ? [this.mcpPrepare] : [])]
    this.sessionPending.clear()
    this.mcpPrepare = undefined
    await Promise.all(operationIds.map(async operationId => {
      await request('external_operation_unknown', { operation_id: operationId }).catch(() => undefined)
    }))
  }

  private registerResult(kind: TaskRunExternalOperationKind, operationId: string): void {
    if (kind === 'mcp_prepare') {
      if (this.mcpPrepare && this.mcpPrepare !== operationId) throw new Error('TASK_RUN_MCP_CHECKPOINT_CONFLICT')
      this.mcpPrepare = operationId
      return
    }
    const prior = this.sessionPending.get(operationId)
    if (prior && prior !== kind) throw new Error('TASK_RUN_EXTERNAL_OPERATION_CHECKPOINT_CONFLICT')
    this.sessionPending.set(operationId, kind)
  }
}

function createExternalOperationRunner(coordinator: ExternalOperationCheckpointCoordinator) {
  return async function runWithExternalOperation<T>(
    kind: TaskRunExternalOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = await request('external_operation_begin', { kind })
    const operationId = parseOperationId(started)
    if (!operationId) throw new Error('TASK_RUN_EXTERNAL_OPERATION_DENIED')
    try {
      const value = await operation()
      await coordinator.recordLocalResult(kind, operationId)
      return value
    } catch (error) {
      await request('external_operation_unknown', { operation_id: operationId }).catch(() => undefined)
      throw error
    }
  }
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

function remoteCommands(
  snapshot: ProductHostRuntimeSnapshot,
  commandPrompt: (name: string, args: string) => Promise<ProductContentBlock[]>,
): ProductCommand[] {
  return snapshot.commands.map(descriptor => ({
    ...descriptor,
    type: 'prompt' as const,
    source: 'mcp' as const,
    progressMessage: '正在加载扩展',
    contentLength: 0,
    directTool: descriptor.directTool,
    getPromptForCommand: async (args: string) => await commandPrompt(descriptor.name, args),
  }))
}

function remoteTools(snapshot: ProductHostRuntimeSnapshot): ProductTool[] {
  return snapshot.tools.map(descriptor => descriptor.name === ProductSubtaskTool.name
    ? ProductSubtaskTool
    : descriptor.name === ProductSkillTool.name
      ? ProductSkillTool
      : { name: descriptor.name } as ProductTool)
}

async function createWorkerHarness(start: StartResult, input: Parameters<AgentWorkerCoreFactory['start']>[0]): Promise<ProductAgentHarnessPort> {
  const coordinator = new ExternalOperationCheckpointCoordinator(input.dispatch_generation)
  const requestEffect = async <T>(
    operation: Extract<CoreRequest['operation'], 'prepare' | 'command_prompt' | 'chat_prompt' | 'tools'>,
    kind: TaskRunExternalOperationKind,
    value?: unknown,
  ): Promise<T> => {
    const result = await request(operation, value)
    if (!result || typeof result !== 'object' || !('operation_id' in result) || !('value' in result)) throw new Error('TASK_RUN_EXTERNAL_OPERATION_RESULT_INVALID')
    coordinator.registerParentResult(kind, result)
    return (result as ParentEffectResult<T>).value
  }
  let snapshot: ProductHostRuntimeSnapshot | undefined
  const prepare = async () => snapshot ??= await requestEffect<ProductHostRuntimeSnapshot>('prepare', 'mcp_prepare')
  const runModel = (value: { messages: ProductHarnessMessage[]; systemPrompt: readonly string[]; thinkingConfig: ProductThinkingConfig; options: { model?: string } }) => requestStream('model', {
    messages: value.messages,
    systemPrompt: [...value.systemPrompt],
    thinkingConfig: value.thinkingConfig,
    model: value.options.model,
  }, async result => coordinator.registerParentResult('model', result)) as never
  const executeTools = async function* (
    blocks: ProductToolCallBlock[],
    assistantMessages: ProductAssistantMessage[],
    canUseTool: ProductCanUseTool,
    context: ProductToolContext,
  ) {
    for (const block of blocks) {
      if (block.name === ProductSubtaskTool.name || block.name === ProductSkillTool.name) {
        yield* runProductTools([block], assistantMessages, canUseTool, context)
        continue
      }
      const messages = await requestEffect<ProductHarnessMessage[]>('tools', 'tools', { blocks: [block], assistantMessages, messages: context.messages })
      for (const message of messages) yield { message, newContext: context }
    }
  }
  const harness = await createProductAgentHarness({
    run_id: input.run_id,
    dispatch_generation: input.dispatch_generation,
    task_id: start.identity.task_id,
    session_id: start.binding.session_id,
    work_dir: start.binding.work_dir,
    permission_envelope: input.permission_envelope,
    projection: productAgentHarnessProjectionPort,
    model_policy: productAgentHarnessModelPolicyPort,
    mcp_host: {
      connect: async () => {
        const current = await prepare()
        return {
          clients: current.mcp_clients as never,
          tools: remoteTools(current),
          commands: remoteCommands(current, async (name, args) => await requestEffect('command_prompt', 'command_prompt', { name, args })),
          resources: {},
        }
      },
    },
    load_commands: async () => [],
    load_tools: () => [],
    run_model: runModel as never,
    execute_tools: executeTools,
    build_chat_prompt: async (text, attachments) => await requestEffect('chat_prompt', 'chat_prompt', { text, attachments }),
    run_external_operation: createExternalOperationRunner(coordinator),
    external_operation_checkpoints: {
      pending: () => coordinator.sessionCheckpointInputs(),
      checkpoint: async records => {
        try {
          await coordinator.checkpointSession(records)
        } catch (error) {
          await coordinator.markPendingUnknown()
          throw error
        }
      },
    },
    reconcile_external_operation_checkpoints: async records => {
      try {
        await coordinator.reconcileSession(records)
      } catch (error) {
        await coordinator.markPendingUnknown()
        throw error
      }
    },
    checkpoint_mcp_prepare: async snapshot => {
      try {
        await coordinator.checkpointMcpPrepare(snapshot)
      } catch (error) {
        await coordinator.markPendingUnknown()
        throw error
      }
    },
    session_context: start.identity.session_context,
    harness_session: start.identity.harness_session,
    ...(start.identity.auto_memory ? {
      auto_memory: {
        storage_dir: start.identity.auto_memory.storage_dir,
        work_dir: start.binding.work_dir,
        enabled: start.identity.auto_memory.enabled,
        task_id: start.identity.task_id,
        entry_id: start.identity.auto_memory.entry_id,
      },
    } : {}),
  })
  return harness
}

function useCodexEngineRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  // This is a migration-only, host-private rollout boundary. It is not a
  // renderer setting and is removed when D/E supplies the complete consumer.
  return env.BB_AGENT_EXECUTION_RUNTIME === 'codex-engine'
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
            if (useCodexEngineRuntime()) {
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
                  engineTools: async () => {
                    const result = await request('engine_tools')
                    if (!result || typeof result !== 'object' || !('operation_id' in result) || !('value' in result)) throw new Error('CODEX_ENGINE_TOOL_SURFACE_UNAVAILABLE')
                    const operationId = parseOperationId(result)
                    const surface = (result as ParentEffectResult<ProductHostEngineToolSurface>).value
                    if (!operationId || !surface || typeof surface !== 'object') throw new Error('CODEX_ENGINE_TOOL_SURFACE_UNAVAILABLE')
                    return { operation_id: operationId, surface }
                  },
                  engineModel: (operationId, value) => requestStream('engine_model', { operation_id: operationId, ...value }) as AsyncGenerator<ProductModelEvent, void>,
                  engineTool: async (operationId, value) => await request('engine_tool', { operation_id: operationId, ...value }) as ProductHostEngineToolResult,
                  approve: async (requestId, approved) => { await request('approval', { requestId, approved }) },
                  answer: async (requestId, answers) => { await request('question', { requestId, answers }) },
                  stopHost: async () => { await request('stop') },
                  shutdownHost: async () => { await request('shutdown') },
                },
              })
              const unsubscribe = engine.subscribe(message => protocol?.relayCoreMessage(message))
              return {
                input: async (text, attachments, queueItemId) => await engine.input(text, attachments, queueItemId),
                approve: async (requestId, approved) => { await engine.approve(requestId, approved) },
                answer: async (requestId, answers) => { await engine.answer(requestId, answers) },
                stop: async () => { await engine.stop() },
                shutdown: async () => { unsubscribe(); await engine.shutdown() },
              }
            }
            const harness = await createWorkerHarness(start, input)
            const unsubscribe = harness.subscribe(message => protocol?.relayCoreMessage(message))
            let firstInput = true
            const core: AgentWorkerCore = {
              input: async (text, attachments, queueItemId) => {
                const initialAttachments = firstInput && !queueItemId ? start.identity.initial_attachments : attachments
                if (!queueItemId) firstInput = false
                return harness.input(text, initialAttachments, queueItemId)
              },
              approve: async (requestId, approved) => { await Promise.all([harness.approve(requestId, approved), request('approval', { requestId, approved })]) },
              answer: async (requestId, answers) => { await Promise.all([harness.answer(requestId, answers), request('question', { requestId, answers })]) },
              stop: async () => { await Promise.all([harness.stop(), request('stop')]) },
              shutdown: async () => { unsubscribe(); await Promise.all([harness.shutdown(), request('shutdown')]) },
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
