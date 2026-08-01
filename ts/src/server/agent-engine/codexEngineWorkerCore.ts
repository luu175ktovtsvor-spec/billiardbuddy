import { createHash } from 'node:crypto'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductAssistantMessage, ProductModelEvent, ProductPrompt } from '../../../shared/product/harnessMessages.js'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import type { ProductHostEngineToolResult, ProductHostEngineToolSurface } from '../agent-worker/productAgentHostRuntime.js'
import {
  createProductHarnessLifecycleHookHost,
  type ProductHarnessLifecycleHookHost,
  type ProductHookRunActivity,
} from '../agent-worker/productLifecycleHooks.js'
import { createProductHookSnapshot } from '../agent-worker/productHookSnapshot.js'
import { productTaskRunFailure } from '../product/taskRunFailure.js'
import { productTaskActivityKindForTool, productTaskActivitySummary, projectProductTaskPlan } from '../product/taskEventProjection.js'
import type { AgentWorkerCore } from '../product/agentWorkerService.js'
import type { AgentWorkerCoreIdentity } from '../product/agentWorkerSupervisor.js'
import { resolveManagedCodexEngineCommand } from './codexEngineCommand.js'
import { CodexEngineRuntime, type CodexEngineAcceptedTurn, type CodexEngineTurnInput } from './codexEngineRuntime.js'
import { CodexEngineThreadStore } from './codexEngineThreadStore.js'
import type { CodexAppServerNotification, CodexAppServerRequest, JsonValue } from './codexAppServerClient.js'
import type { CodexResponsesModelRequest } from './codexResponsesModelBridge.js'
import type { TaskRunExternalOperationKind } from '../product/taskRunLedgerModel.js'
import type { ProductTaskPlan } from '../../../shared/product/taskEvents.js'

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
  chatPrompt(text: string, attachments: readonly string[]): Promise<{ operation_id: string; prompt: ProductPrompt }>
  engineTools(): Promise<{ operation_id: string; surface: ProductHostEngineToolSurface }>
  engineModel(operationId: string, request: { messages: CodexResponsesModelRequest['messages']; systemPrompt: string[]; thinkingConfig: CodexResponsesModelRequest['thinking_config']; model?: string; engine_tool_names: string[]; engine_tool_surface_digest: string }): AsyncGenerator<ProductModelEvent, void>
  engineTool(operationId: string, request: { tool_call_id: string; tool_name: string; arguments: Record<string, unknown>; tool_surface_digest: string }): Promise<ProductHostEngineToolResult>
  /** Persist a TodoWrite projection before the source receives its tool result. */
  recordPlan(operationId: string, plan: ProductTaskPlan): Promise<void>
  approve(requestId: string, approved: boolean): Promise<void>
  answer(requestId: string, answers: readonly string[]): Promise<void>
  stopHost(): Promise<void>
  shutdownHost(): Promise<void>
}

type PendingModelReceipt = {
  operation_id: string
  assistant: ProductAssistantMessage
  result_digest: string
}

type PendingToolReceipt = {
  operation_id: string
  call_id: string
}

type PendingHookReceipt = {
  operation_id: string
}

type PendingInputReceipt = {
  operation_id: string
  result_digest: string
}

type PendingSteerReceipt = {
  operation_id: string
}

type Deferred = {
  promise: Promise<void>
  resolve(): void
  reject(error: Error): void
}

const ENGINE_BASE_INSTRUCTIONS = [
  '你是 BilliardBuddy 的受管 Agent 执行内核。',
  '只完成用户任务；模型访问、状态、权限和最终结果均由 BilliardBuddy 管理。',
  '只能调用本轮由 BilliardBuddy 明确提供的工具。工具执行、权限确认、MCP 和工作区边界均由 BilliardBuddy 宿主负责。',
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

function toolResultDigest(value: { call_id: string; tool_name: string; result: ProductHostEngineToolResult }): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function hookResultDigest(kind: Extract<TaskRunExternalOperationKind, 'hook_command' | 'hook_http'>, result: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, result }) ?? '{"result":"undefined"}').digest('hex')
}

function attachmentInput(prompt: ProductPrompt): { input: CodexEngineTurnInput[]; result_digest: string } {
  const blocks = typeof prompt === 'string' ? [{ type: 'text' as const, text: prompt }] : prompt
  const input: CodexEngineTurnInput[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text) continue
      input.push({ type: 'text', text: block.text })
      continue
    }
    input.push({ type: 'image', url: `data:${block.media_type};base64,${block.data}` })
  }
  if (!input.length) throw new Error('CODEX_ENGINE_ATTACHMENT_INPUT_EMPTY')
  return {
    input,
    result_digest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  }
}

function acceptedTurn(notification: CodexAppServerNotification): { thread_id: string; turn_id: string; status: string } | undefined {
  const params = record(notification.params)
  const turn = record(params?.turn)
  const threadId = text(params?.threadId, 512)
  const turnId = text(turn?.id, 512)
  const status = text(turn?.status, 128)
  return threadId && turnId && status ? { thread_id: threadId, turn_id: turnId, status } : undefined
}

function dynamicToolContent(result: ProductHostEngineToolResult): Array<Record<string, string>> {
  const content = typeof result.content === 'string' ? [{ type: 'text' as const, text: result.content }] : result.content
  const output: Array<Record<string, string>> = []
  for (const block of content) {
    if (block.type === 'text') {
      output.push({ type: 'inputText', text: block.text.slice(0, 3_000_000) })
      continue
    }
    if (block.type === 'image') {
      output.push({ type: 'inputImage', imageUrl: `data:${block.media_type};base64,${block.data}` })
    }
  }
  return output.length ? output : [{ type: 'inputText', text: '(Tool returned no content)' }]
}

function dynamicToolHookContext(result: ProductHostEngineToolResult, contexts: readonly (string | undefined)[]): Array<Record<string, string>> {
  const context = contexts
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n\n')
    .slice(0, 20_000)
  return [
    ...dynamicToolContent(result),
    ...(context ? [{ type: 'inputText', text: `项目 Hook 反馈：\n${context}` }] : []),
  ]
}

/**
 * Product-side C bridge.  The Codex source handles one private Thread/Turn;
 * this core owns the product receipts that make the source result admissible.
 * Dynamic tools and project command/HTTP Hooks re-enter only through the
 * product Host; source code never receives direct local execution authority.
 */
export class CodexEngineWorkerCore implements AgentWorkerCore {
  private readonly listeners = new Set<(message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void>()
  private runtime?: CodexEngineRuntime
  private activeTurn?: CodexEngineAcceptedTurn
  private turnReceipt?: Deferred
  private steerReceipt?: Deferred
  private pendingModel?: PendingModelReceipt
  private pendingTool?: PendingToolReceipt
  private pendingHook?: PendingHookReceipt
  private pendingInput?: PendingInputReceipt
  private pendingSteer?: PendingSteerReceipt
  private toolSurface?: ProductHostEngineToolSurface
  private lifecycleHooks?: ProductHarnessLifecycleHookHost
  private readonly hookAbortController = new AbortController()
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
      permission_envelope: PermissionExecutionEnvelope
      parent: CodexEngineWorkerParentPort
    },
  ) {}

  static async create(input: {
    identity: AgentWorkerCoreIdentity
    binding: CoreBinding
    run_id: string
    permission_envelope: PermissionExecutionEnvelope
    parent: CodexEngineWorkerParentPort
  }): Promise<CodexEngineWorkerCore> {
    const core = new CodexEngineWorkerCore(input)
    await core.start()
    return core
  }

  subscribe(listener: (message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async input(textInput: string, attachments: readonly string[] = [], queueItemId?: string): Promise<boolean | void> {
    if (queueItemId) return await this.steer(queueItemId, textInput)
    if (this.inputStarted || this.terminal || this.stopping || !text(textInput)) return false
    const runtime = this.runtime
    if (!runtime) throw new Error('CODEX_ENGINE_RUNTIME_UNAVAILABLE')
    this.inputStarted = true
    this.emit({ type: 'event', event: 'started' })
    const receipt = deferred()
    this.turnReceipt = receipt
    let operationId: string | undefined
    let inputCheckpointed = false
    try {
      await this.prepareToolSurface(runtime)
      const sourceInput = attachments.length > 0
        ? await this.prepareAttachmentInput(textInput, attachments)
        : { input: [{ type: 'text' as const, text: textInput }] }
      operationId = await this.options.parent.beginExternalOperation('engine_turn')
      const accepted = await runtime.startTurn({ run_id: this.options.run_id, input: sourceInput.input })
      // The source can request its model immediately after returning from
      // `turn/start`; retain the identity before releasing the model gate.
      this.activeTurn = accepted
      const digest = await runtime.checkpointAcceptedTurn(
        this.options.run_id,
        accepted.turn_id,
        operationId,
        this.pendingInput,
      )
      if (this.pendingInput) {
        await this.options.parent.checkpointExternalOperation(this.pendingInput.operation_id, digest)
        this.pendingInput = undefined
        inputCheckpointed = true
      }
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      receipt.resolve()
    } catch (error) {
      receipt.reject(error instanceof Error ? error : new Error('CODEX_ENGINE_TURN_START_FAILED'))
      if (operationId) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      else this.emitTerminal('recovery_required', 'task_execution_environment_failed')
      if (!inputCheckpointed && this.pendingInput) {
        const pendingInput = this.pendingInput
        this.pendingInput = undefined
        await this.options.parent.markExternalOperationUnknown(pendingInput.operation_id).catch(() => undefined)
      }
    }
  }

  async approve(requestId: string, approved: boolean): Promise<void> {
    await this.options.parent.approve(requestId, approved)
  }

  async answer(requestId: string, answers: readonly string[]): Promise<void> {
    await this.options.parent.answer(requestId, answers)
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.hookAbortController.abort()
    this.emit({ type: 'event', event: 'stopping' })
    const activeTurn = this.activeTurn
    await Promise.all([
      activeTurn && this.runtime ? this.runtime.interruptTurn(activeTurn).catch(() => undefined) : undefined,
      this.options.parent.stopHost(),
    ])
  }

  async shutdown(): Promise<void> {
    this.hookAbortController.abort()
    this.turnReceipt?.reject(new Error('CODEX_ENGINE_WORKER_SHUTDOWN'))
    this.steerReceipt?.reject(new Error('CODEX_ENGINE_WORKER_SHUTDOWN'))
    const pendingModel = this.pendingModel
    this.pendingModel = undefined
    if (pendingModel) await this.options.parent.markExternalOperationUnknown(pendingModel.operation_id).catch(() => undefined)
    const pendingTool = this.pendingTool
    this.pendingTool = undefined
    if (pendingTool) await this.options.parent.markExternalOperationUnknown(pendingTool.operation_id).catch(() => undefined)
    const pendingHook = this.pendingHook
    this.pendingHook = undefined
    if (pendingHook) await this.options.parent.markExternalOperationUnknown(pendingHook.operation_id).catch(() => undefined)
    const pendingInput = this.pendingInput
    this.pendingInput = undefined
    if (pendingInput) await this.options.parent.markExternalOperationUnknown(pendingInput.operation_id).catch(() => undefined)
    const pendingSteer = this.pendingSteer
    this.pendingSteer = undefined
    if (pendingSteer) await this.options.parent.markExternalOperationUnknown(pendingSteer.operation_id).catch(() => undefined)
    await this.runtime?.close().catch(() => undefined)
    this.runtime = undefined
    await this.options.parent.shutdownHost()
  }

  private async start(): Promise<void> {
    const command = await resolveManagedCodexEngineCommand()
    const state = this.options.identity.codex_engine
    const hookSnapshot = await createProductHookSnapshot(this.options.binding.work_dir)
    this.lifecycleHooks = createProductHarnessLifecycleHookHost({
      snapshot: hookSnapshot,
      cwd: this.options.binding.work_dir,
      run_external_operation: async (kind, operation) => await this.runHookExternalOperation(kind, operation),
      on_hook_run: activity => this.onHookRun(activity),
    })
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
      on_server_request: async request => await this.onServerRequest(request),
    })
    await runtime.start()
    this.runtime = runtime
  }

  /**
   * Attachment paths terminate in the Host. The source receives only the
   * Host-produced bounded prompt, and the exact result digest is persisted in
   * the product Thread binding before that source Turn can invoke a model.
   */
  private async prepareAttachmentInput(textInput: string, attachments: readonly string[]): Promise<{ input: CodexEngineTurnInput[] }> {
    const prepared = await this.options.parent.chatPrompt(textInput, attachments)
    try {
      const converted = attachmentInput(prepared.prompt)
      this.pendingInput = {
        operation_id: prepared.operation_id,
        result_digest: converted.result_digest,
      }
      return { input: converted.input }
    } catch (error) {
      // The Host already holds a definite chat_prompt result. If its bounded
      // conversion cannot be admitted by this source bridge, it is not safe
      // to retry or discard that result on a later recovery.
      await this.options.parent.markExternalOperationUnknown(prepared.operation_id).catch(() => undefined)
      throw error
    }
  }

  /** Accept one already-durable queue item into the active source Turn. */
  private async steer(queueItemId: string, textInput: string): Promise<boolean> {
    const runtime = this.runtime
    const activeTurn = this.activeTurn
    if (
      !runtime
      || !activeTurn
      || !this.inputStarted
      || this.terminal
      || this.stopping
      || this.pendingSteer
      || !/^queue_[a-f0-9-]{36}$/.test(queueItemId)
      || !text(textInput, 1 << 20)
    ) return false
    const receipt = deferred()
    this.steerReceipt = receipt
    let operationId: string | undefined
    try {
      operationId = await this.options.parent.beginExternalOperation('engine_steer')
      this.pendingSteer = { operation_id: operationId }
      const acceptedTurnId = await runtime.steerTurn({
        run_id: this.options.run_id,
        queue_item_id: queueItemId,
        expected_turn_id: activeTurn.turn_id,
        text: textInput,
      })
      const inputDigest = createHash('sha256').update(JSON.stringify({ queue_item_id: queueItemId, text: textInput })).digest('hex')
      const digest = await runtime.checkpointSteerInput(
        this.options.run_id,
        acceptedTurnId,
        operationId,
        queueItemId,
        inputDigest,
      )
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      this.pendingSteer = undefined
      receipt.resolve()
      return true
    } catch (error) {
      receipt.reject(error instanceof Error ? error : new Error('CODEX_ENGINE_STEER_FAILED'))
      this.pendingSteer = undefined
      if (operationId) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      this.emitTerminal('recovery_required', 'task_execution_environment_failed')
      return false
    }
  }

  private async *runModel(request: CodexResponsesModelRequest): AsyncGenerator<ProductModelEvent, void> {
    await this.turnReceipt?.promise
    await this.steerReceipt?.promise
    if (this.terminal || this.stopping) throw new Error('CODEX_ENGINE_RUN_TERMINAL')
    const surface = this.toolSurface
    const toolNames = request.tools.map(tool => tool.name).sort((left, right) => left.localeCompare(right))
    if (
      !surface
      || toolNames.length !== surface.tools.length
      || toolNames.some((name, index) => name !== surface.tools[index]?.name)
    ) throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISMATCH')
    const operationId = await this.options.parent.beginExternalOperation('model')
    let final: ProductAssistantMessage | undefined
    try {
      for await (const event of this.options.parent.engineModel(operationId, {
        messages: request.messages,
        systemPrompt: request.system_prompt,
        thinkingConfig: request.thinking_config,
        engine_tool_names: toolNames,
        engine_tool_surface_digest: surface.digest,
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

  private async prepareToolSurface(runtime: CodexEngineRuntime): Promise<void> {
    if (this.toolSurface) return
    const prepared = await this.options.parent.engineTools()
    let accepted = false
    try {
      const digest = await runtime.checkpointToolSurface(prepared.surface)
      await this.options.parent.checkpointExternalOperation(prepared.operation_id, digest)
      this.toolSurface = prepared.surface
      accepted = true
    } finally {
      if (!accepted) await this.options.parent.markExternalOperationUnknown(prepared.operation_id).catch(() => undefined)
    }
  }

  private async onServerRequest(request: CodexAppServerRequest): Promise<JsonValue | undefined> {
    try {
      if (request.method !== 'item/tool/call') throw new Error('CODEX_ENGINE_SERVER_REQUEST_UNSUPPORTED')
      const params = record(request.params)
      const activeTurn = this.activeTurn
      const surface = this.toolSurface
      const threadId = text(params?.threadId, 512)
      const turnId = text(params?.turnId, 512)
      const callId = text(params?.callId, 512)
      const namespace = params?.namespace
      const toolName = text(params?.tool, 128)
      const argumentsValue = record(params?.arguments)
      if (
        !activeTurn || !surface || this.terminal || this.stopping || this.pendingTool
        || threadId !== activeTurn.thread_id || turnId !== activeTurn.turn_id
        || !callId || !/^[A-Za-z0-9_-]{1,512}$/.test(callId)
        || namespace !== null && namespace !== undefined
        || !toolName || !surface.tools.some(tool => tool.name === toolName)
        || !argumentsValue
      ) throw new Error('CODEX_ENGINE_DYNAMIC_TOOL_INVALID')
      const lifecycleHooks = this.lifecycleHooks
      if (!lifecycleHooks) throw new Error('CODEX_ENGINE_HOOK_RUNTIME_UNAVAILABLE')
      const activityId = `activity_${createHash('sha256').update(`${this.options.run_id}:${callId}`).digest('hex').slice(0, 32)}`
      const activityKind = productTaskActivityKindForTool(toolName)
      const planRelated = toolName.trim().toLowerCase() === 'todowrite'
      const preHook = await lifecycleHooks.preTool({
        toolName,
        toolInput: argumentsValue,
        toolUseId: callId,
        signal: this.hookAbortController.signal,
      })
      if (preHook.blocked) {
        this.emit({
          type: 'event',
          event: 'activity',
          activity: {
            id: activityId,
            kind: activityKind,
            phase: 'failed',
            summary: productTaskActivitySummary(activityKind, 'failed', planRelated),
          },
        })
        return {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: `PreToolUse Hook blocked ${toolName}: ${(preHook.reason || 'project automation rule').slice(0, 8_000)}`,
          }],
        }
      }
      const operationId = await this.options.parent.beginExternalOperation('tools')
      this.pendingTool = { operation_id: operationId, call_id: callId }
      this.emit({ type: 'event', event: 'activity', activity: { id: activityId, kind: activityKind, phase: 'started', summary: productTaskActivitySummary(activityKind, 'started', planRelated) } })
      let toolCheckpointed = false
      try {
        const result = await this.options.parent.engineTool(operationId, {
          tool_call_id: callId,
          tool_name: toolName,
          arguments: argumentsValue,
          tool_surface_digest: surface.digest,
        })
        const plan = planRelated && !result.is_error
          ? projectProductTaskPlan(argumentsValue, this.options.run_id, callId)
          : null
        if (planRelated && !result.is_error && !plan) throw new Error('CODEX_ENGINE_PLAN_INVALID')
        // The product plan must be durable before the source sees a successful
        // TodoWrite result. It is tied to this exact in-flight tools receipt.
        if (plan) await this.options.parent.recordPlan(operationId, plan)
        const digest = await this.runtime?.checkpointToolResult(this.options.run_id, operationId, callId, toolResultDigest({ call_id: callId, tool_name: toolName, result }))
        if (!digest) throw new Error('CODEX_ENGINE_TOOL_RUNTIME_UNAVAILABLE')
        await this.options.parent.recordExternalOperationResult(operationId)
        await this.options.parent.checkpointExternalOperation(operationId, digest)
        toolCheckpointed = true
        this.pendingTool = undefined
        const phase = result.is_error ? 'failed' as const : 'completed' as const
        if (plan) this.emit({ type: 'event', event: 'plan_updated', plan })
        this.emit({ type: 'event', event: 'activity', activity: { id: activityId, kind: activityKind, phase, summary: productTaskActivitySummary(activityKind, phase, planRelated) } })
        const postHook = await lifecycleHooks.postTool({
          toolName,
          toolInput: argumentsValue,
          toolUseId: callId,
          success: !result.is_error,
          result: result.content,
          signal: this.hookAbortController.signal,
        })
        return {
          success: !result.is_error,
          contentItems: dynamicToolHookContext(result, [
            preHook.additionalContext,
            postHook.additionalContext,
            postHook.blocked ? postHook.reason || 'Project PostToolUse Hook reported a failure' : undefined,
          ]),
        }
      } catch (error) {
        this.pendingTool = undefined
        if (!toolCheckpointed) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
        this.emit({ type: 'event', event: 'activity', activity: { id: activityId, kind: activityKind, phase: 'failed', summary: productTaskActivitySummary(activityKind, 'failed', planRelated) } })
        throw error
      }
    } catch (error) {
      this.emitTerminal('recovery_required', 'task_execution_environment_failed')
      throw error
    }
  }

  private async runHookExternalOperation<T>(kind: TaskRunExternalOperationKind, operation: () => Promise<T>): Promise<T> {
    if (kind !== 'hook_command' && kind !== 'hook_http') throw new Error('CODEX_ENGINE_HOOK_OPERATION_INVALID')
    const runtime = this.runtime
    if (!runtime || this.pendingHook || this.terminal || this.stopping) throw new Error('CODEX_ENGINE_HOOK_RUNTIME_UNAVAILABLE')
    const operationId = await this.options.parent.beginExternalOperation(kind)
    this.pendingHook = { operation_id: operationId }
    try {
      const result = await runWithProductPermissionEnvelope(
        this.options.permission_envelope,
        () => runWithCwdOverride(this.options.binding.work_dir, operation),
      )
      const digest = await runtime.checkpointHookResult(
        this.options.run_id,
        operationId,
        hookResultDigest(kind, result),
      )
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      this.pendingHook = undefined
      return result
    } catch (error) {
      this.pendingHook = undefined
      await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      throw error
    }
  }

  private onHookRun(activity: ProductHookRunActivity): void {
    const id = `activity_${createHash('sha256').update(`${this.options.run_id}:${activity.id}`).digest('hex').slice(0, 32)}`
    this.emit({
      type: 'event',
      event: 'activity',
      activity: {
        id,
        kind: 'automation',
        phase: activity.phase,
        summary: productTaskActivitySummary('automation', activity.phase),
      },
    })
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
