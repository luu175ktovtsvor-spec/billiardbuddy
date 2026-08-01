import { createHash, randomUUID } from 'node:crypto'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductAssistantMessage, ProductModelEvent, ProductModelOperationReceipt, ProductPrompt } from '../../../shared/product/harnessMessages.js'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import type { ProductHostEngineToolResult, ProductHostEngineToolSurface, ProductHostHookModelRequest, ProductHostRuntimeSnapshot } from '../agent-worker/productAgentHostRuntime.js'
import {
  createProductHarnessLifecycleHookHost,
  type ProductHarnessLifecycleHookHost,
  type ProductLifecycleHookResult,
  type ProductHookRunActivity,
} from '../agent-worker/productLifecycleHooks.js'
import { createProductHookSnapshot } from '../agent-worker/productHookSnapshot.js'
import { createProductInstructionSnapshot } from '../services/productInstructions.js'
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
import type { ProductToolContext, ProductToolPermissionContext } from '../agent-worker/productTool.js'
import type { CodexEngineRunInstructionSnapshot } from './codexEngineSession.js'

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
  engineTools(): Promise<{ operation_id: string; surface: ProductHostEngineToolSurface; snapshot: ProductHostRuntimeSnapshot }>
  checkpointMcpPrepare(operationId: string, snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number }): Promise<void>
  engineModel(operationId: string, request: { messages: CodexResponsesModelRequest['messages']; systemPrompt: string[]; thinkingConfig: CodexResponsesModelRequest['thinking_config']; model?: string; engine_tool_names: string[]; engine_tool_surface_digest: string }): AsyncGenerator<ProductModelEvent, void>
  hookModel(operationId: string, request: ProductHostHookModelRequest): AsyncGenerator<ProductModelEvent, void>
  acknowledgeModelResult(operationId: string, receipt: ProductModelOperationReceipt): Promise<void>
  engineTool(operationId: string, request: { tool_call_id: string; tool_name: string; arguments: Record<string, unknown>; tool_surface_digest: string }): Promise<ProductHostEngineToolResult>
  /** Persist a TodoWrite projection before the source receives its tool result. */
  recordPlan(operationId: string, plan: ProductTaskPlan): Promise<void>
  /** Persist source compaction before its next model sampling may begin. */
  recordContextCompaction(compaction: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }>): Promise<void>
  approve(requestId: string, approved: boolean): Promise<void>
  answer(requestId: string, answers: readonly string[]): Promise<void>
  stopHost(): Promise<void>
  shutdownHost(): Promise<void>
}

type PendingModelReceipt = {
  kind: 'sampling' | 'context_compaction'
  operation_id: string
  assistant: ProductAssistantMessage
  result_digest: string
}

type ActiveContextCompaction = {
  source: 'automatic' | 'manual'
  generation: number
  input_tokens: number
  model_started: boolean
  pre_compact_instructions?: string
}

type PendingToolReceipt = {
  operation_id: string
  call_id: string
}

type PendingHookReceipt = {
  operation_id: string
}

type PendingModelAcknowledgement = {
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

const MAX_STOP_HOOK_CONTINUATIONS = 3

function stopHookContinuationPrompt(result: ProductLifecycleHookResult): string {
  const reason = result.reason?.trim() || '当前结果尚未满足项目自动化规则。'
  const context = result.additionalContext?.trim()
  return [
    '项目 Stop Hook 要求继续处理。',
    `原因：${reason}`,
    ...(context ? [`补充约束：\n${context}`] : []),
    '请依据当前任务和已确认的工具结果继续完成；不要把 Stop Hook 的阻止误报为完成。',
  ].join('\n\n').slice(0, 40_000)
}

function record(value: JsonValue | undefined): Record<string, JsonValue | undefined> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue | undefined> : undefined
}

function text(value: unknown, limit = 4 * 1024 * 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
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

function hookResultDigest(kind: Extract<TaskRunExternalOperationKind, 'hook_command' | 'hook_http' | 'model' | 'model_ack'>, result: unknown): string {
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

function sourceContextCompaction(notification: CodexAppServerNotification): {
  phase: 'started' | 'completed'
  thread_id: string
  turn_id: string
  item_id: string
  source: 'automatic' | 'manual'
  input_tokens: number
  output_tokens?: number
  summary?: string
} | undefined {
  const phase = notification.method === 'item/started' ? 'started' : notification.method === 'item/completed' ? 'completed' : undefined
  if (!phase) return undefined
  const params = record(notification.params)
  const item = record(params?.item)
  if (item?.type !== 'contextCompaction') return undefined
  const threadId = text(params?.threadId, 512)
  const turnId = text(params?.turnId, 512)
  const itemId = text(item.id, 512)
  const source = item.source === 'automatic' || item.source === 'manual' ? item.source : undefined
  const inputTokens = positiveInteger(item.inputTokens)
  if (!threadId || !turnId || !itemId || !source || !inputTokens) throw new Error('CODEX_ENGINE_CONTEXT_COMPACTION_START_INVALID')
  if (phase === 'started') return { phase, thread_id: threadId, turn_id: turnId, item_id: itemId, source, input_tokens: inputTokens }
  const outputTokens = positiveInteger(item.outputTokens)
  const summary = text(item.summary, 40_000)
  if (!outputTokens || !summary) throw new Error('CODEX_ENGINE_CONTEXT_COMPACTION_COMPLETION_INVALID')
  return { phase, thread_id: threadId, turn_id: turnId, item_id: itemId, source, input_tokens: inputTokens, output_tokens: outputTokens, summary }
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

function productExtensionSnapshot(input: {
  surface: ProductHostEngineToolSurface
  snapshot: ProductHostRuntimeSnapshot
  instructions: CodexEngineRunInstructionSnapshot
  hookDigest: string
}): { digest: string; tool_count: number; command_count: number; mcp_server_count: number } {
  if (!/^[a-f0-9]{64}$/.test(input.instructions.digest) || !/^[a-f0-9]{64}$/.test(input.hookDigest)) {
    throw new Error('CODEX_ENGINE_EXTENSION_SNAPSHOT_INVALID')
  }
  const commands = input.snapshot.commands.map(command => command.name).sort((left, right) => left.localeCompare(right))
  const tools = input.surface.tools.map(tool => tool.name).sort((left, right) => left.localeCompare(right))
  const mcpServers = input.snapshot.mcp_clients.map(client => client.name).sort((left, right) => left.localeCompare(right))
  const digest = createHash('sha256').update(JSON.stringify({
    commands,
    tools,
    mcp_servers: mcpServers,
    instructions: input.instructions.digest,
    hooks: input.hookDigest,
  })).digest('hex')
  return {
    digest,
    tool_count: tools.length,
    command_count: commands.length,
    mcp_server_count: mcpServers.length,
  }
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
  private pendingModelAcknowledgement?: PendingModelAcknowledgement
  private pendingInput?: PendingInputReceipt
  private pendingSteer?: PendingSteerReceipt
  private pendingStopHookContinuation?: PendingSteerReceipt
  private contextCompactionStartReceipt?: Deferred
  private contextCompactionCompletionReceipt?: Deferred
  private toolSurface?: ProductHostEngineToolSurface
  private lifecycleHooks?: ProductHarnessLifecycleHookHost
  private readonly hookAbortController = new AbortController()
  private projectInstructions?: CodexEngineRunInstructionSnapshot
  private hookSnapshotDigest = ''
  private initialHookContext = ''
  private readonly checkpointedModelOperations = new Set<string>()
  private readonly agentMessageText = new Map<string, string>()
  private readonly activeContextCompactions = new Map<string, ActiveContextCompaction>()
  private contextCompactionGeneration = 0
  private modelReceiptCheckpointed = false
  private userSteerDuringSampling = false
  private stopHookRound = 0
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
    void receipt.promise.catch(() => undefined)
    let operationId: string | undefined
    let inputCheckpointed = false
    let sourceTurnCheckpointed = false
    try {
      const projectInstructions = this.projectInstructions
      if (!projectInstructions) throw new Error('CODEX_ENGINE_PROJECT_INSTRUCTIONS_UNAVAILABLE')
      this.projectInstructions = await runtime.resolveRunInstructionSnapshot(this.options.run_id, projectInstructions)
      await this.prepareToolSurface(runtime)
      const sourceThread = await runtime.ensureThread()
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
        this.projectInstructions,
      )
      if (this.pendingInput) {
        await this.options.parent.checkpointExternalOperation(this.pendingInput.operation_id, digest)
        this.pendingInput = undefined
        inputCheckpointed = true
      }
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      sourceTurnCheckpointed = true
      const initialHooks = await this.runInitialLifecycleHooks(textInput, sourceThread.restored ? 'resume' : 'startup')
      if (initialHooks.blocked) {
        receipt.reject(new Error('CODEX_ENGINE_INITIAL_HOOK_BLOCKED'))
        await runtime.interruptTurn(accepted).catch(() => undefined)
        this.emit({ type: 'event', event: 'delta', data: '项目 Hook 已阻止本次请求。请检查项目自动化规则后重试。' })
        this.emitTerminal('completed')
        return
      }
      receipt.resolve()
    } catch (error) {
      receipt.reject(error instanceof Error ? error : new Error('CODEX_ENGINE_TURN_START_FAILED'))
      if (operationId && !sourceTurnCheckpointed) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      if (sourceTurnCheckpointed && this.activeTurn) await runtime.interruptTurn(this.activeTurn).catch(() => undefined)
      this.emitTerminal('recovery_required', 'task_execution_environment_failed')
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
    await this.failActiveContextCompactions().catch(() => undefined)
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
    await this.failActiveContextCompactions().catch(() => undefined)
    const pendingModel = this.pendingModel
    this.pendingModel = undefined
    if (pendingModel) await this.options.parent.markExternalOperationUnknown(pendingModel.operation_id).catch(() => undefined)
    const pendingTool = this.pendingTool
    this.pendingTool = undefined
    if (pendingTool) await this.options.parent.markExternalOperationUnknown(pendingTool.operation_id).catch(() => undefined)
    const pendingHook = this.pendingHook
    this.pendingHook = undefined
    if (pendingHook) await this.options.parent.markExternalOperationUnknown(pendingHook.operation_id).catch(() => undefined)
    const pendingModelAcknowledgement = this.pendingModelAcknowledgement
    this.pendingModelAcknowledgement = undefined
    if (pendingModelAcknowledgement) await this.options.parent.markExternalOperationUnknown(pendingModelAcknowledgement.operation_id).catch(() => undefined)
    const pendingInput = this.pendingInput
    this.pendingInput = undefined
    if (pendingInput) await this.options.parent.markExternalOperationUnknown(pendingInput.operation_id).catch(() => undefined)
    const pendingSteer = this.pendingSteer
    this.pendingSteer = undefined
    if (pendingSteer) await this.options.parent.markExternalOperationUnknown(pendingSteer.operation_id).catch(() => undefined)
    const pendingStopHookContinuation = this.pendingStopHookContinuation
    this.pendingStopHookContinuation = undefined
    if (pendingStopHookContinuation) await this.options.parent.markExternalOperationUnknown(pendingStopHookContinuation.operation_id).catch(() => undefined)
    await this.runtime?.close().catch(() => undefined)
    this.runtime = undefined
    await this.options.parent.shutdownHost()
  }

  private async start(): Promise<void> {
    const command = await resolveManagedCodexEngineCommand()
    const state = this.options.identity.codex_engine
    const hookSnapshot = await createProductHookSnapshot(this.options.binding.work_dir)
    this.hookSnapshotDigest = hookSnapshot.digest
    const instructionSnapshot = createProductInstructionSnapshot(this.options.binding.work_dir)
    this.projectInstructions = { digest: instructionSnapshot.digest, prompt: instructionSnapshot.prompt }
    this.contextCompactionGeneration = this.options.identity.session_context?.compact_generation ?? 0
    this.lifecycleHooks = createProductHarnessLifecycleHookHost({
      snapshot: hookSnapshot,
      cwd: this.options.binding.work_dir,
      evaluate: async (prompt, model, signal, timeoutMs) => await this.evaluateProjectHook(prompt, model, signal, timeoutMs),
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
      on_notification: async notification => await this.onNotification(notification),
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
      this.userSteerDuringSampling = true
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
    await this.contextCompactionStartReceipt?.promise
    if (this.terminal || this.stopping) throw new Error('CODEX_ENGINE_RUN_TERMINAL')
    const surface = this.toolSurface
    const toolNames = request.tools.map(tool => tool.name).sort((left, right) => left.localeCompare(right))
    const activeCompaction = [...this.activeContextCompactions.values()].find(compaction => !compaction.model_started)
    if (!activeCompaction) this.userSteerDuringSampling = false
    if (!activeCompaction) await this.contextCompactionCompletionReceipt?.promise
    if (!surface) throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISSING')
    if (activeCompaction) {
      if (toolNames.length !== 0) throw new Error('CODEX_ENGINE_CONTEXT_COMPACTION_TOOL_SURFACE_INVALID')
      activeCompaction.model_started = true
    } else if (
      toolNames.length !== surface.tools.length
      || toolNames.some((name, index) => name !== surface.tools[index]?.name)
    ) throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISMATCH')
    const operationId = await this.options.parent.beginExternalOperation('model')
    let final: ProductAssistantMessage | undefined
    try {
      for await (const event of this.options.parent.engineModel(operationId, {
        messages: request.messages,
        systemPrompt: [
          ...request.system_prompt,
          ...(activeCompaction ? [] : this.projectInstructions?.prompt ? [this.projectInstructions.prompt] : []),
          ...(activeCompaction ? [] : this.initialHookContext ? [`项目 Hook 补充指令：\n${this.initialHookContext}`] : []),
          ...(activeCompaction?.pre_compact_instructions ? [`项目 PreCompact Hook 补充要求：\n${activeCompaction.pre_compact_instructions}`] : []),
        ],
        thinkingConfig: request.thinking_config,
        engine_tool_names: activeCompaction ? [] : toolNames,
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
          kind: activeCompaction ? 'context_compaction' : 'sampling',
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
    let modelCheckpointed = false
    try {
      const digest = await runtime.checkpointModelResult(this.options.run_id, pending.operation_id, pending.result_digest)
      await this.options.parent.recordExternalOperationResult(pending.operation_id)
      await this.options.parent.checkpointExternalOperation(pending.operation_id, digest)
      this.pendingModel = undefined
      this.checkpointedModelOperations.add(pending.operation_id)
      modelCheckpointed = true
      if (assistant.operation_receipt) await this.acknowledgeModelResult(assistant.operation_receipt)
      if (pending.kind === 'sampling') {
        this.modelReceiptCheckpointed = true
        if (!assistant.message.content.some(block => block.type === 'tool_call')) {
          await this.continueBlockedStopHook(assistant)
        }
      }
    } catch (error) {
      this.pendingModel = undefined
      if (!modelCheckpointed) await this.options.parent.markExternalOperationUnknown(pending.operation_id).catch(() => undefined)
      throw error
    }
  }

  /**
   * A provider receipt cannot be acknowledged until its source-model result
   * has been checkpointed. The acknowledgement is itself an external effect,
   * so it owns a separate durable receipt rather than piggybacking on the
   * model operation that produced the result.
   */
  private async acknowledgeModelResult(receipt: ProductModelOperationReceipt): Promise<void> {
    const runtime = this.runtime
    if (!runtime || this.pendingModelAcknowledgement || this.terminal || this.stopping) {
      throw new Error('CODEX_ENGINE_MODEL_ACK_RUNTIME_UNAVAILABLE')
    }
    const operationId = await this.options.parent.beginExternalOperation('model_ack')
    this.pendingModelAcknowledgement = { operation_id: operationId }
    try {
      await this.options.parent.acknowledgeModelResult(operationId, receipt)
      const digest = await runtime.checkpointHookResult(
        this.options.run_id,
        operationId,
        hookResultDigest('model_ack', receipt),
      )
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      this.pendingModelAcknowledgement = undefined
    } catch (error) {
      this.pendingModelAcknowledgement = undefined
      await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      throw error
    }
  }

  /**
   * The source starts a Turn before lifecycle Hooks, but its loopback model
   * bridge is held on turnReceipt. This lets project automation affect the
   * first source model request without allowing an uncheckpointed Hook to run
   * before the Run owns an accepted Turn.
   */
  private async runInitialLifecycleHooks(
    textInput: string,
    source: 'startup' | 'resume',
  ): Promise<ProductLifecycleHookResult> {
    const lifecycleHooks = this.lifecycleHooks
    if (!lifecycleHooks) throw new Error('CODEX_ENGINE_HOOK_RUNTIME_UNAVAILABLE')
    const context = this.lifecycleHookToolContext()
    const sessionStart = await lifecycleHooks.sessionStart({
      source,
      sessionId: this.options.binding.session_id,
      model: this.options.binding.model,
      signal: this.hookAbortController.signal,
    })
    if (sessionStart.blocked) return sessionStart
    const userPrompt = await lifecycleHooks.userPrompt({
      prompt: textInput,
      permissionMode: context.permissionContext.mode,
      context,
    })
    this.initialHookContext = [sessionStart.additionalContext, userPrompt.additionalContext]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n\n')
      .slice(0, 40_000)
    return userPrompt
  }

  private lifecycleHookToolContext(): ProductToolContext {
    const policy = this.options.permission_envelope.approval_policy
    const permissionContext: ProductToolPermissionContext = {
      mode: policy === 'never' ? 'bypassPermissions' : policy === 'automatic_reviewer' ? 'acceptEdits' : 'default',
      isBypassPermissionsModeAvailable: policy === 'never',
    }
    return {
      productTaskId: this.options.identity.task_id,
      options: {
        commands: [],
        mainLoopModel: this.options.binding.model,
        tools: [],
        thinkingConfig: { type: 'disabled' },
      },
      abortController: this.hookAbortController,
      permissionContext,
      messages: [],
    }
  }

  /**
   * Upstream checks for queued input before it reaches its own terminal Stop
   * phase. By steering a confirmed product Hook prompt before the current
   * response receives `response.completed`, the source keeps this exact Turn
   * alive instead of fabricating a second Run or terminal event.
   */
  private async continueBlockedStopHook(assistant: ProductAssistantMessage): Promise<void> {
    if (this.pendingSteer || this.userSteerDuringSampling) return
    const runtime = this.runtime
    const activeTurn = this.activeTurn
    const lifecycleHooks = this.lifecycleHooks
    if (!runtime || !activeTurn || !lifecycleHooks || this.terminal || this.stopping) {
      throw new Error('CODEX_ENGINE_STOP_HOOK_RUNTIME_UNAVAILABLE')
    }
    const context = this.lifecycleHookToolContext()
    const stopHook = await lifecycleHooks.stop({
      permissionMode: context.permissionContext.mode,
      signal: this.hookAbortController.signal,
      context,
      messages: [assistant],
    })
    if (!stopHook.blocked) return
    // A user input accepted while a potentially slow Hook was running already
    // keeps the source Turn alive. Do not add a redundant automation prompt.
    if (this.pendingSteer || this.userSteerDuringSampling) return
    const round = this.stopHookRound + 1
    if (round > MAX_STOP_HOOK_CONTINUATIONS) throw new Error('CODEX_ENGINE_STOP_HOOK_LIMIT')
    if (this.terminal || this.stopping) throw new Error('CODEX_ENGINE_STOP_HOOK_INTERRUPTED')
    const prompt = stopHookContinuationPrompt(stopHook)
    const clientMessageId = `stop_hook_${randomUUID()}`
    const operationId = await this.options.parent.beginExternalOperation('engine_steer')
    this.pendingStopHookContinuation = { operation_id: operationId }
    let checkpointed = false
    try {
      const acceptedTurnId = await runtime.steerStopHookContinuation({
        run_id: this.options.run_id,
        client_message_id: clientMessageId,
        expected_turn_id: activeTurn.turn_id,
        text: prompt,
      })
      const inputDigest = createHash('sha256').update(JSON.stringify({
        source: 'stop_hook',
        client_message_id: clientMessageId,
        prompt,
        round,
      })).digest('hex')
      const digest = await runtime.checkpointStopHookContinuation(
        this.options.run_id,
        acceptedTurnId,
        operationId,
        clientMessageId,
        prompt,
        inputDigest,
        round,
      )
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      checkpointed = true
      this.stopHookRound = round
      this.pendingStopHookContinuation = undefined
    } catch (error) {
      this.pendingStopHookContinuation = undefined
      if (!checkpointed) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      throw error
    }
  }

  /** Prompt and Agent Hooks use the accepted Run model route with no tools. */
  private async evaluateProjectHook(
    prompt: string,
    requestedModel: string | undefined,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (requestedModel && requestedModel !== this.options.binding.model) {
      return { ok: false, reason: '项目 Hook 请求的模型不属于当前已确认的任务路由。' }
    }
    if (signal.aborted) throw new Error('PRODUCT_HOOK_ABORTED')
    const runtime = this.runtime
    if (!runtime || this.pendingHook || this.terminal || this.stopping) throw new Error('CODEX_ENGINE_HOOK_MODEL_UNAVAILABLE')
    const operationId = await this.options.parent.beginExternalOperation('model')
    this.pendingHook = { operation_id: operationId }
    let modelCheckpointed = false
    try {
      let assistant: ProductAssistantMessage | undefined
      for await (const event of this.options.parent.hookModel(operationId, {
        prompt,
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
      })) {
        if (event.type === 'model_delta') continue
        if (assistant) throw new Error('CODEX_ENGINE_HOOK_MODEL_RESULT_DUPLICATED')
        assistant = event
      }
      if (!assistant || assistant.message.content.some(block => block.type === 'tool_call')) {
        throw new Error('CODEX_ENGINE_HOOK_MODEL_RESULT_INVALID')
      }
      const response = assistant.message.content
        .filter((block): block is Extract<(typeof assistant.message.content)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      const tooLarge = response.length > 8_000
      const digest = await runtime.checkpointHookResult(
        this.options.run_id,
        operationId,
        hookResultDigest('model', assistant),
      )
      await this.options.parent.recordExternalOperationResult(operationId)
      await this.options.parent.checkpointExternalOperation(operationId, digest)
      this.pendingHook = undefined
      modelCheckpointed = true
      if (assistant.operation_receipt) await this.acknowledgeModelResult(assistant.operation_receipt)
      let parsed: { ok?: unknown; reason?: unknown } | undefined
      if (!tooLarge) {
        try { parsed = JSON.parse(response.trim()) as { ok?: unknown; reason?: unknown } } catch { parsed = undefined }
      }
      return parsed?.ok === true
        ? { ok: true }
        : {
            ok: false,
            reason: tooLarge
              ? 'Hook evaluator response exceeded the limit'
              : typeof parsed?.reason === 'string'
                ? parsed.reason.slice(0, 4_000)
                : 'Hook condition was not satisfied',
          }
    } catch (error) {
      this.pendingHook = undefined
      if (!modelCheckpointed) await this.options.parent.markExternalOperationUnknown(operationId).catch(() => undefined)
      throw error
    }
  }

  private async prepareToolSurface(runtime: CodexEngineRuntime): Promise<void> {
    if (this.toolSurface) return
    const activityId = `activity_${createHash('sha256').update(`${this.options.run_id}:extension`).digest('hex').slice(0, 32)}`
    this.emit({ type: 'event', event: 'activity', activity: { id: activityId, kind: 'extension', phase: 'started', summary: productTaskActivitySummary('extension', 'started') } })
    let prepared: Awaited<ReturnType<CodexEngineWorkerParentPort['engineTools']>> | undefined
    try {
      const instructions = this.projectInstructions
      if (!instructions) throw new Error('CODEX_ENGINE_PROJECT_INSTRUCTIONS_UNAVAILABLE')
      prepared = await this.options.parent.engineTools()
      await runtime.checkpointToolSurface(prepared.surface)
      const extension = productExtensionSnapshot({
        surface: prepared.surface,
        snapshot: prepared.snapshot,
        instructions,
        hookDigest: this.hookSnapshotDigest,
      })
      await this.options.parent.checkpointMcpPrepare(prepared.operation_id, extension)
      this.toolSurface = prepared.surface
      this.emit({ type: 'event', event: 'extension_snapshot', ...extension })
      this.emit({ type: 'event', event: 'activity', activity: { id: activityId, kind: 'extension', phase: 'completed', summary: productTaskActivitySummary('extension', 'completed') } })
    } catch (error) {
      if (prepared) await this.options.parent.markExternalOperationUnknown(prepared.operation_id).catch(() => undefined)
      this.emit({ type: 'event', event: 'activity', activity: { id: activityId, kind: 'extension', phase: 'failed', summary: productTaskActivitySummary('extension', 'failed') } })
      throw error
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

  private async onNotification(notification: CodexAppServerNotification): Promise<void> {
    const compaction = sourceContextCompaction(notification)
    if (compaction) {
      const activeTurn = this.activeTurn
      if (
        !activeTurn
        || this.terminal
        || this.stopping
        || compaction.thread_id !== activeTurn.thread_id
        || compaction.turn_id !== activeTurn.turn_id
      ) return
      if (compaction.phase === 'started') {
        if (this.activeContextCompactions.has(compaction.item_id) || this.contextCompactionCompletionReceipt) {
          throw new Error('CODEX_ENGINE_CONTEXT_COMPACTION_OVERLAP')
        }
        const startReceipt = deferred()
        const completionReceipt = deferred()
        void startReceipt.promise.catch(() => undefined)
        void completionReceipt.promise.catch(() => undefined)
        const active: ActiveContextCompaction = {
          source: compaction.source,
          generation: this.contextCompactionGeneration + 1,
          input_tokens: compaction.input_tokens,
          model_started: false,
        }
        this.activeContextCompactions.set(compaction.item_id, active)
        this.contextCompactionStartReceipt = startReceipt
        this.contextCompactionCompletionReceipt = completionReceipt
        let startedPersisted = false
        try {
          const event: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }> = {
            type: 'event',
            event: 'context_compaction',
            phase: 'started',
            source: active.source,
            generation: active.generation,
            input_tokens: active.input_tokens,
          }
          await this.options.parent.recordContextCompaction(event)
          startedPersisted = true
          const lifecycleHooks = this.lifecycleHooks
          if (!lifecycleHooks) throw new Error('CODEX_ENGINE_HOOK_RUNTIME_UNAVAILABLE')
          const preCompact = await lifecycleHooks.preCompact({
            trigger: active.source === 'automatic' ? 'auto' : 'manual',
            signal: this.hookAbortController.signal,
          })
          active.pre_compact_instructions = preCompact.instructions
          this.emit(event)
          startReceipt.resolve()
        } catch (error) {
          this.activeContextCompactions.delete(compaction.item_id)
          this.contextCompactionStartReceipt = undefined
          this.contextCompactionCompletionReceipt = undefined
          const failure = error instanceof Error ? error : new Error('CODEX_ENGINE_CONTEXT_COMPACTION_START_FAILED')
          if (startedPersisted) {
            await this.recordFailedContextCompaction(active).catch(() => undefined)
          }
          startReceipt.reject(failure)
          completionReceipt.reject(failure)
          this.emitTerminal('recovery_required', 'task_execution_environment_failed')
          throw failure
        }
        return
      }
      const active = this.activeContextCompactions.get(compaction.item_id)
      if (
        !active
        || active.source !== compaction.source
        || active.input_tokens !== compaction.input_tokens
        || !compaction.output_tokens
        || !compaction.summary
      ) throw new Error('CODEX_ENGINE_CONTEXT_COMPACTION_COMPLETION_MISMATCH')
      try {
        const event: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }> = {
          type: 'event',
          event: 'context_compaction',
          phase: 'completed',
          source: active.source,
          generation: active.generation,
          input_tokens: active.input_tokens,
          output_tokens: compaction.output_tokens,
          summary: compaction.summary,
          compacted_through_event_sequence: this.options.identity.session_context?.event_sequence ?? 0,
        }
        await this.options.parent.recordContextCompaction(event)
        this.emit(event)
        const lifecycleHooks = this.lifecycleHooks
        if (!lifecycleHooks) throw new Error('CODEX_ENGINE_HOOK_RUNTIME_UNAVAILABLE')
        await lifecycleHooks.postCompact({
          trigger: active.source === 'automatic' ? 'auto' : 'manual',
          summary: compaction.summary,
          signal: this.hookAbortController.signal,
        })
        this.contextCompactionGeneration = active.generation
        this.activeContextCompactions.delete(compaction.item_id)
        this.contextCompactionCompletionReceipt?.resolve()
        this.contextCompactionCompletionReceipt = undefined
      } catch (error) {
        const failure = error instanceof Error ? error : new Error('CODEX_ENGINE_CONTEXT_COMPACTION_COMPLETION_FAILED')
        this.activeContextCompactions.delete(compaction.item_id)
        this.contextCompactionCompletionReceipt?.reject(failure)
        this.contextCompactionCompletionReceipt = undefined
        this.emitTerminal('recovery_required', 'task_execution_environment_failed')
        throw failure
      }
      return
    }
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
    if (this.activeContextCompactions.size > 0) await this.failActiveContextCompactions()
    if (completed.status === 'completed' && this.modelReceiptCheckpointed) {
      this.emitTerminal('completed')
      return
    }
    if (completed.status === 'interrupted' && this.stopping) return
    this.emitTerminal('recovery_required', 'task_model_response_invalid')
  }

  private async failActiveContextCompactions(): Promise<void> {
    const activeCompactions = [...this.activeContextCompactions.values()]
    this.activeContextCompactions.clear()
    let firstError: Error | undefined
    for (const active of activeCompactions) {
      try {
        await this.recordFailedContextCompaction(active)
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error('CODEX_ENGINE_CONTEXT_COMPACTION_FAILURE_UNRECORDED')
      }
    }
    if (activeCompactions.length) {
      const failure = firstError ?? new Error('CODEX_ENGINE_CONTEXT_COMPACTION_INTERRUPTED')
      this.contextCompactionStartReceipt?.reject(failure)
      this.contextCompactionCompletionReceipt?.reject(failure)
      this.contextCompactionStartReceipt = undefined
      this.contextCompactionCompletionReceipt = undefined
    }
    if (firstError) throw firstError
  }

  private async recordFailedContextCompaction(active: ActiveContextCompaction): Promise<void> {
    const event: Extract<AgentWorkerOutbound, { type: 'event'; event: 'context_compaction' }> = {
      type: 'event',
      event: 'context_compaction',
      phase: 'failed',
      source: active.source,
      generation: active.generation,
      input_tokens: active.input_tokens,
    }
    await this.options.parent.recordContextCompaction(event)
    this.emit(event)
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
