import { createHash } from 'node:crypto'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductAssistantMessage, ProductModelEvent } from '../../../shared/product/harnessMessages.js'
import { productTaskRunFailure } from '../product/taskRunFailure.js'
import type { AgentWorkerCore } from '../product/agentWorkerService.js'
import type { AgentWorkerCoreIdentity } from '../product/agentWorkerSupervisor.js'
import { resolveManagedCodexEngineCommand } from './codexEngineCommand.js'
import { CodexEngineRuntime, type CodexEngineAcceptedTurn } from './codexEngineRuntime.js'
import { CodexEngineThreadStore } from './codexEngineThreadStore.js'
import type { CodexAppServerNotification, JsonValue } from './codexAppServerClient.js'
import type { CodexResponsesModelRequest } from './codexResponsesModelBridge.js'
import type { TaskRunExternalOperationKind } from '../product/taskRunLedgerModel.js'

type CoreBinding = {
  session_id: string
  work_dir: string
  model: string
}

export type CodexEngineWorkerParentPort = {
  beginExternalOperation(kind: TaskRunExternalOperationKind): Promise<string>
  recordExternalOperationResult(operationId: string): Promise<void>
  checkpointExternalOperation(operationId: string, checkpointDigest: string): Promise<void>
  markExternalOperationUnknown(operationId: string): Promise<void>
  engineModel(operationId: string, request: { messages: CodexResponsesModelRequest['messages']; systemPrompt: string[]; thinkingConfig: CodexResponsesModelRequest['thinking_config']; model?: string }): AsyncGenerator<ProductModelEvent, void>
  stopHost(): Promise<void>
  shutdownHost(): Promise<void>
}

type PendingModelReceipt = {
  operation_id: string
  assistant: ProductAssistantMessage
  result_digest: string
}

type Deferred = {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

const ENGINE_BASE_INSTRUCTIONS = [
  '你是 BilliardBuddy 的受管 Agent 执行内核。',
  '只完成用户任务；模型访问、状态、权限和最终结果均由 BilliardBuddy 管理。',
  '当前运行没有可直接调用的工具。不要假设拥有终端、浏览器、文件或网络访问能力。',
].join('\n')

function record(value: JsonValue | undefined): Record<string, JsonValue | undefined> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue | undefined> : undefined
}

function text(value: unknown, limit = 4 * 1024 * 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((next, fail) => { resolve = next; reject = fail })
  return { promise, resolve, reject }
}

function assistantResultDigest(assistant: ProductAssistantMessage): string {
  return createHash('sha256').update(JSON.stringify(assistant.message)).digest('hex')
}

function acceptedTurn(notification: CodexAppServerNotification): { thread_id: string; turn_id: string; status: string } | undefined {
  const params = record(notification.params)
  const turn = record(params?.turn)
  const threadId = text(params?.threadId, 512)
  const turnId = text(turn?.id, 512)
  const status = text(turn?.status, 128)
  return threadId && turnId && status ? { thread_id: threadId, turn_id: turnId, status } : undefined
}

/**
 * Product-side C bridge.  The Codex source handles one private Thread/Turn;
 * this core owns the product receipts that make the source result admissible.
 * It intentionally has no tool or approval adapter yet: that is the next
 * contract module, rather than another copy of the old Harness loop.
 */
export class CodexEngineWorkerCore implements AgentWorkerCore {
  private readonly listeners = new Set<(message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void>()
  private runtime?: CodexEngineRuntime
  private activeTurn?: CodexEngineAcceptedTurn
  private turnReceipt?: Deferred
  private pendingModel?: PendingModelReceipt
  private readonly checkpointedModelOperations = new Set<string>()
  private readonly agentMessageText = new Map<string, string>()
  private modelReceiptCheckpointed = false
  private inputStarted = false
  private terminal = false
  private stopping = false

  private constructor(
    private readonly options: {
      identity: AgentWorkerCoreIdentity
      binding: CoreBinding
      run_id: string
      parent: CodexEngineWorkerParentPort
    },
  ) {}

  static async create(input: {
    identity: AgentWorkerCoreIdentity
    binding: CoreBinding
    run_id: string
    parent: CodexEngineWorkerParentPort
  }): Promise<CodexEngineWorkerCore> {
    // C owns text Run→Turn only. Reject rather than silently dropping an
    // attachment while the dedicated attachment bridge is still pending.
    if (input.identity.initial_attachments?.length) throw new Error('CODEX_ENGINE_ATTACHMENTS_UNSUPPORTED')
    const core = new CodexEngineWorkerCore(input)
    await core.start()
    return core
  }

  subscribe(listener: (message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async input(textInput: string, attachments: readonly string[] = [], queueItemId?: string): Promise<boolean | void> {
    if (queueItemId || this.inputStarted || this.terminal || this.stopping || attachments.length > 0 || !text(textInput)) return false
    const runtime = this.runtime
    if (!runtime) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    this.inputStarted = true
    this.emit({ type: 'event', event: 'started' })
    const receipt = deferred()
    this.turnReceipt = receipt
    let operationId: string | undefined
    try {
      operationId = await this.options.parent.beginExternalOperation('engine_turn')
      const accepted = await runtime.startTurn({ run_id: this.options.run_id, text: textInput })
      // The source can request its model immediately after returning from
      // `turn/start`; retain the identity before releasing the model gate.
      this.activeTurn = accepted
      const digest = await runtime.checkpointAcceptedTurn(this.options.run_id, accepted.turn_id, operationId)
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      receipt.resolve()
    } catch (error) {
      receipt.reject(error instanceof Error ? error : new Error('CODEX_ENGINE_TURN_START_FAILED'))
      if (operationId) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      else this.emitTerminal('recovery_required', 'task_execution_environment_failed')
    }
  }

  async approve(_requestId: string, _approved: boolean): Promise<void> {}

  async answer(_requestId: string, _answers: readonly string[]): Promise<void> {}

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.emit({ type: 'event', event: 'stopping' })
    const activeTurn = this.activeTurn
    await Promise.all([
      activeTurn && this.runtime ? this.runtime.interruptTurn(activeTurn).catch(() => undefined) : undefined,
      this.options.parent.stopHost(),
    ])
  }

  async shutdown(): Promise<void> {
    this.turnReceipt?.reject(new Error('CODEX_ENGINE_WORKER_SHUTDOWN'))
    const pendingModel = this.pendingModel
    this.pendingModel = undefined
    if (pendingModel) await this.options.parent.markExternalOperationUnknown(pendingModel.operation_id).catch(() => undefined)
    await this.runtime?.close().catch(() => undefined)
    this.runtime = undefined
    await this.options.parent.shutdownHost()
  }

  private async start(): Promise<void> {
    const command = await resolveManagedCodexEngineCommand()
    const state = this.options.identity.codex_engine
    const runtime = new CodexEngineRuntime({
      command,
      engine_home: state.engine_home,
      base_instructions: ENGINE_BASE_INSTRUCTIONS,
      thread_store: new CodexEngineThreadStore(),
      binding: {
        storage_dir: state.thread_storage_dir,
        binding_id: state.binding_id,
        lineage_id: state.lineage_id,
      },
      source_revision: state.source_revision,
      work_dir: this.options.binding.work_dir,
      model: this.options.binding.model,
      run_model: request => this.runModel(request),
      checkpoint_model_result: async assistant => await this.checkpointModelResult(assistant),
      on_notification: notification => this.onNotification(notification),
    })
    await runtime.start()
    this.runtime = runtime
  }

  private async *runModel(request: CodexResponsesModelRequest): AsyncGenerator<ProductModelEvent, void> {
    await this.turnReceipt?.promise
    const operationId = await this.options.parent.beginExternalOperation('model')
    let final: ProductAssistantMessage | undefined
    try {
      for await (const event of this.options.parent.engineModel(operationId, {
        messages: request.messages,
        systemPrompt: request.system_prompt,
        thinkingConfig: request.thinking_config,
        ...(request.model ? { model: request.model } : {}),
      })) {
        if (event.type === 'model_delta') {
          yield event
          continue
        }
        if (final) throw new Error('CODEX_ENGINE_MODEL_RESULT_DUPLICATED')
        final = event
        this.pendingModel = {
          operation_id: operationId,
          assistant: final,
          result_digest: assistantResultDigest(final),
        }
        yield final
      }
      if (!final) throw new Error('CODEX_ENGINE_MODEL_RESULT_MISSING')
    } catch (error) {
      if (this.pendingModel?.operation_id === operationId) this.pendingModel = undefined
      if (!this.checkpointedModelOperations.has(operationId)) {
        await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      }
      throw error
    }
  }

  private async checkpointModelResult(assistant: ProductAssistantMessage): Promise<void> {
    const pending = this.pendingModel
    const runtime = this.runtime
    if (!pending || !runtime || pending.assistant !== assistant || this.terminal) throw new Error('CODEX_ENGINE_MODEL_RECEIPT_INVALID')
    try {
      const digest = await runtime.checkpointModelResult(this.options.run_id, pending.operation_id, pending.result_digest)
      await this.options.parent.recordExternalOperationResult(pending.operation_id)
      await this.options.parent.checkpointExternalOperation(pending.operation_id, digest)
      this.pendingModel = undefined
      this.checkpointedModelOperations.add(pending.operation_id)
      this.modelReceiptCheckpointed = true
    } catch (error) {
      this.pendingModel = undefined
      await this.options.parent.markExternalOperationUnknown(pending.operation_id).catch(() => undefined)
      throw error
    }
  }

  private onNotification(notification: CodexAppServerNotification): void {
    if (notification.method === 'item/agentMessage/delta') {
      const params = record(notification.params)
      const itemId = text(params?.itemId, 512)
      const delta = text(params?.delta)
      if (itemId && delta && !this.terminal && !this.stopping) {
        this.agentMessageText.set(itemId, `${this.agentMessageText.get(itemId) ?? ''}${delta}`)
        this.emit({ type: 'event', event: 'delta', data: delta })
      }
      return
    }
    if (notification.method === 'item/completed') {
      const params = record(notification.params)
      const item = record(params?.item)
      const itemId = text(item?.id, 512)
      const itemText = text(item?.text)
      if (item?.type === 'agentMessage' && itemId && itemText && !this.terminal && !this.stopping) {
        const streamed = this.agentMessageText.get(itemId) ?? ''
        if (itemText.startsWith(streamed) && itemText.length > streamed.length) {
          this.agentMessageText.set(itemId, itemText)
          this.emit({ type: 'event', event: 'delta', data: itemText.slice(streamed.length) })
        }
      }
      return
    }
    if (notification.method !== 'turn/completed') return
    const completed = acceptedTurn(notification)
    if (!completed || !this.activeTurn) return
    if (completed.thread_id !== this.activeTurn.thread_id || completed.turn_id !== this.activeTurn.turn_id) return
    if (completed.status === 'completed' && this.modelReceiptCheckpointed) {
      this.emitTerminal('completed')
      return
    }
    if (completed.status === 'interrupted' && this.stopping) return
    this.emitTerminal('recovery_required', 'task_model_response_invalid')
  }

  private emit(message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>): void {
    for (const listener of this.listeners) listener(message)
  }

  private emitTerminal(state: 'completed' | 'recovery_required', failureCode?: 'task_execution_environment_failed' | 'task_model_response_invalid'): void {
    if (this.terminal || this.stopping) return
    this.terminal = true
    this.emit({
      type: 'terminal',
      state,
      run_id: this.options.run_id,
      ...(state === 'recovery_required' && failureCode ? { failure: productTaskRunFailure(failureCode) } : {}),
    })
  }
}
