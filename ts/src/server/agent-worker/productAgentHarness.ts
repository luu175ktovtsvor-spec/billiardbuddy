import { createHash } from 'node:crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { getLocalISODate } from '../../constants/common.js'
import { productHarnessMessageOperationReceipts, type ProductHarnessMessage, type ProductModelOperationReceipt, type ProductPrompt } from '../../../shared/product/harnessMessages.js'
import { createAbortController } from '../../utils/abortController.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import type { TaskRunExternalOperationKind } from '../product/taskRunLedgerModel.js'
import { ProductAutoMemoryRepository, type ProductAutoMemoryBinding } from '../services/productAutoMemory.js'
import { createProductInstructionSnapshot } from '../services/productInstructions.js'
import type { ProductAgentHarnessModelPolicyPort, ProductAgentHarnessProjectionPort } from './agentHarnessPorts.js'
import type { ProductTaskMcpHost } from './mcpHost.js'
import { runProductAgentLoop } from './productAgentLoop.js'
import type { ProductAgentLoopInput } from './productAgentLoop.js'
import { acknowledgeProductModelOperation } from './productModelRuntime.js'
import { createProductUserMessage } from './productMessages.js'
import { loadProductAgentCommands, loadProductAgentExtensionTools } from './productExtensionLoader.js'
import { productAgentCommands } from './productPluginAgentLoader.js'
import { loadProductAgentTools } from './productToolLoader.js'
import { buildProductChatPrompt } from './productChatAttachments.js'
import {
  ProductHarnessSessionRepository,
  type ProductHarnessSessionBinding,
  type ProductHarnessSessionExternalOperationCheckpoint,
  type ProductHarnessSessionExternalOperationCheckpointInput,
} from './harnessSessionRepository.js'
import {
  createProductHarnessLifecycleHookHost,
  type ProductHarnessLifecycleHookHost,
  type ProductHookRunActivity,
} from './productLifecycleHooks.js'
import { createProductHookSnapshot } from './productHookSnapshot.js'
import { decideProductToolPermission } from './productPermissionDecision.js'
import { emptyProductToolPermissionContext, type ProductCommand, type ProductQueuedCommand, type ProductToolContext, type ProductToolHooks, type ProductToolPermissionContext, type ProductTools } from './productTool.js'
import type { ProductTaskActivityKind, ProductTaskRunFailure } from '../../../shared/product/taskEvents.js'

export type ProductAgentHarnessPort = {
  input(text: string, attachments?: readonly string[], queueItemId?: string): Promise<boolean | void>
  approve(requestId: string, approved: boolean): Promise<void>
  answer(requestId: string, answers: readonly string[]): Promise<void>
  stop(): Promise<void>
  shutdown(): Promise<void>
  subscribe(listener: (message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void): () => void
}

export type ProductHarnessExternalOperation = <T>(
  kind: TaskRunExternalOperationKind,
  operation: () => Promise<T>,
) => Promise<T>

export async function createProductAgentHarness(input: {
  run_id: string
  dispatch_generation: number
  task_id?: string
  session_id: string
  work_dir: string
  permission_envelope: PermissionExecutionEnvelope
  projection: ProductAgentHarnessProjectionPort
  model_policy: ProductAgentHarnessModelPolicyPort
  mcp_host?: ProductTaskMcpHost
  query?: typeof runProductAgentLoop
  run_model: ProductAgentLoopInput['runModel']
  execute_tools: ProductAgentLoopInput['executeTools']
  load_commands?: (cwd: string) => Promise<ProductCommand[]>
  load_tools?: (permissionContext: ProductToolPermissionContext) => ProductTools
  auto_memory?: ProductAutoMemoryBinding & { task_id: string; entry_id: string }
  session_context?: {
    text: string
    event_sequence: number
    estimated_tokens: number
    compact_generation: number
  }
  harness_session?: ProductHarnessSessionBinding
  lifecycle_hooks?: ProductHarnessLifecycleHookHost
  build_chat_prompt?: (text: string, attachments: readonly string[], signal: AbortSignal) => Promise<ProductPrompt>
  run_external_operation?: ProductHarnessExternalOperation
  /**
   * The child-side owner writes its private session first, then asks the
   * authority ledger to clear the matching external-effect receipt.  This is
   * deliberately separate from ordinary session persistence: a Promise
   * resolving is never evidence that its result survived a crash.
   */
  external_operation_checkpoints?: {
    pending(): readonly ProductHarnessSessionExternalOperationCheckpointInput[]
    checkpoint(records: readonly ProductHarnessSessionExternalOperationCheckpoint[]): Promise<void>
  }
  /** MCP preparation belongs to the formal Run extension snapshot, not just
   * the private Harness cache. */
  checkpoint_mcp_prepare?: (snapshot: {
    digest: string
    tool_count: number
    command_count: number
    mcp_server_count: number
  }) => Promise<void>
  /** Replays session-fsynced-but-not-ledger-confirmed proofs for this exact
   * Run generation before the Harness can ACK or create a new external call. */
  reconcile_external_operation_checkpoints?: (records: readonly ProductHarnessSessionExternalOperationCheckpoint[]) => Promise<void>
}): Promise<ProductAgentHarnessPort> {
  const toolPermissionContext: ProductToolPermissionContext = {
    ...emptyProductToolPermissionContext(),
    mode: input.permission_envelope.approval_policy === 'never'
      ? 'bypassPermissions'
      : input.permission_envelope.approval_policy === 'automatic_reviewer'
        ? 'acceptEdits'
        : 'default',
    isBypassPermissionsModeAvailable: input.permission_envelope.approval_policy === 'never',
  }
  let mcpRuntime = { clients: [], tools: [], commands: [], resources: {} } as Awaited<ReturnType<NonNullable<typeof input.mcp_host>['connect']>>
  let mcpConnected = false
  let mcpClosed = false
  const closeMcpHost = async () => {
    if (mcpClosed) return
    mcpClosed = true
    await Promise.allSettled(mcpRuntime.clients.flatMap(client => client.cleanup ? [client.cleanup()] : []))
  }
  const connectMcpHost = async () => {
    if (!input.mcp_host || mcpConnected) return
    const mcp = await input.mcp_host.connect(input.work_dir, input.task_id ? { taskId: input.task_id, networkScope: input.permission_envelope.network_scope } : undefined)
    mcpRuntime = mcp
    mcpConnected = true
  }
  const discoveredInstructionSnapshot = createProductInstructionSnapshot(input.work_dir)
  const productHookSnapshot = await createProductHookSnapshot(input.work_dir)
  const runInProductScope = <T>(fn: () => T): T => runWithProductPermissionEnvelope(
    input.permission_envelope,
    () => runWithCwdOverride(input.work_dir, fn),
  )
  const autoMemoryRepository = input.auto_memory ? new ProductAutoMemoryRepository() : undefined
  const runExternalOperation: ProductHarnessExternalOperation = input.run_external_operation
    ?? (async <T>(_kind: TaskRunExternalOperationKind, operation: () => Promise<T>): Promise<T> => await operation())
  let productAutoMemory = input.auto_memory ? await autoMemoryRepository!.load(input.auto_memory) : ''
  const harnessSessionRepository = input.harness_session ? new ProductHarnessSessionRepository() : undefined
  const restoredHarnessSession = input.harness_session
    ? await harnessSessionRepository!.load(input.harness_session)
    : undefined
  const instructionSnapshot = restoredHarnessSession?.run_id === input.run_id
    && restoredHarnessSession.instruction_digest
    && restoredHarnessSession.instruction_prompt !== undefined
    ? {
        digest: restoredHarnessSession.instruction_digest,
        prompt: restoredHarnessSession.instruction_prompt,
      }
    : discoveredInstructionSnapshot
  let productSessionContext = restoredHarnessSession?.context_prefix ?? input.session_context?.text ?? ''
  const restoredSameRun = restoredHarnessSession?.run_id === input.run_id
  let productHookContext = restoredSameRun ? restoredHarnessSession.hook_context ?? '' : ''
  const modelMessages: ProductHarnessMessage[] = restoredHarnessSession?.messages ?? []
  const pendingOperationReceipts = new Map<string, ProductModelOperationReceipt>((restoredHarnessSession?.operation_receipts ?? []).map(receipt => [`${receipt.source}:${receipt.operation_id}`, receipt]))
  const persistedExternalOperationCheckpoints = restoredSameRun
    ? (restoredHarnessSession?.external_operation_checkpoints ?? []).filter(checkpoint => checkpoint.dispatch_generation === input.dispatch_generation)
    : []
  const acknowledgedOperationReceiptKeys = new Set(restoredHarnessSession?.acknowledged_operation_receipt_keys ?? [])
  const recoveringActiveTurn = restoredSameRun
    && restoredHarnessSession.turn_state === 'active'
    && modelMessages.length > 0
  const recoveringPreparedTurn = restoredSameRun && restoredHarnessSession.turn_state === 'preparing'
  const persistHarnessSession = async (
    messages: readonly ProductHarnessMessage[] = modelMessages,
    turnState: 'preparing' | 'active' | 'completed' = 'active',
    completedResult?: string,
  ) => {
    const checkpointOperations = [...(input.external_operation_checkpoints?.pending() ?? [])]
    if (!input.harness_session) {
      if (checkpointOperations.length > 0) throw new Error('PRODUCT_EXTERNAL_OPERATION_CHECKPOINT_UNAVAILABLE')
      return
    }
    if (messages !== modelMessages) modelMessages.splice(0, modelMessages.length, ...messages)
    const retainedCheckpointCount = Math.max(0, 512 - checkpointOperations.length)
    const retainedCheckpoints = persistedExternalOperationCheckpoints.slice(-retainedCheckpointCount)
    const saved = await harnessSessionRepository!.save(input.harness_session, {
      context_prefix: productSessionContext,
      messages: modelMessages,
      run_id: input.run_id,
      instruction_digest: instructionSnapshot.digest,
      instruction_prompt: instructionSnapshot.prompt,
      turn_state: turnState,
      hook_context: productHookContext,
      ...(completedResult !== undefined ? { completed_result: completedResult } : {}),
      operation_receipts: [...pendingOperationReceipts.values()],
      external_operation_checkpoints: retainedCheckpoints,
      acknowledged_operation_receipt_keys: [...acknowledgedOperationReceiptKeys].slice(-4_096),
      checkpoint_operations: checkpointOperations,
    })
    if (saved.external_operation_checkpoints.length > 0) {
      await input.external_operation_checkpoints?.checkpoint(saved.external_operation_checkpoints)
      persistedExternalOperationCheckpoints.splice(0, persistedExternalOperationCheckpoints.length, ...[...retainedCheckpoints, ...saved.external_operation_checkpoints])
    }
  }
  const persistedOperationReceipts = () => {
    const receipts = new Map<string, ProductModelOperationReceipt>(pendingOperationReceipts)
    for (const message of modelMessages) {
      for (const receipt of productHarnessMessageOperationReceipts(message)) {
        receipts.set(`${receipt.source}:${receipt.operation_id}`, receipt)
      }
    }
    return [...receipts.values()]
  }
  const acknowledgePersistedOperationReceipts = async (signal: AbortSignal) => {
    for (const receipt of persistedOperationReceipts()) {
      const receiptKey = `${receipt.source}:${receipt.operation_id}`
      if (acknowledgedOperationReceiptKeys.has(receiptKey)) continue
      await runExternalOperation('model_ack', async () => await acknowledgeProductModelOperation(receipt, signal))
      acknowledgedOperationReceiptKeys.add(receiptKey)
      pendingOperationReceipts.delete(receiptKey)
      while (acknowledgedOperationReceiptKeys.size > 4_096) {
        const oldest = acknowledgedOperationReceiptKeys.values().next().value
        if (typeof oldest !== 'string') break
        acknowledgedOperationReceiptKeys.delete(oldest)
      }
      await persistHarnessSession()
    }
  }
  const productPromptContext = () => ({
    workspace: input.work_dir,
    date: getLocalISODate(),
    projectInstructions: instructionSnapshot.prompt,
    projectMemory: productAutoMemory,
    sessionSummary: productSessionContext,
    hookInstructions: productHookContext,
  })
  let controller: AbortController | undefined
  let observeNestedHarnessMessage: ((message: ProductHarnessMessage, parentToolUseId?: string) => void) | undefined
  const createToolUseContext = (
    commands: ProductCommand[],
    tools: ProductTools,
    abortController: AbortController,
    model: string,
  ): ProductToolContext => ({
    productTaskId: input.task_id,
    toolHooks: productToolHooks,
    productPromptContext: productPromptContext(),
    runProductModel: input.run_model,
    executeProductTools: input.execute_tools,
    options: {
      commands,
      mainLoopModel: model,
      tools,
      thinkingConfig: { type: 'adaptive' },
      commandQueue,
    },
    abortController,
    permissionContext: toolPermissionContext,
    onProductHarnessMessage: (message, parentToolUseId) => observeNestedHarnessMessage?.(message, parentToolUseId),
    messages: modelMessages,
  })
  let terminal = false
  const approvals = new Map<string, (decision: { approved: boolean; answers?: readonly string[] }) => void>()
  const queuedSteers = new Map<string, { command: ProductQueuedCommand; promise: Promise<boolean>; resolve(consumed: boolean): void }>()
  const commandQueue = {
    snapshot: () => [...queuedSteers.values()].map(value => value.command),
    consume: (commands: ProductQueuedCommand[]) => {
      for (const command of commands) {
        if (!command.uuid) continue
        const pending = queuedSteers.get(command.uuid)
        if (!pending) continue
        queuedSteers.delete(command.uuid)
        pending.resolve(true)
      }
    },
  }
  const listeners = new Set<(message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void>()
  const emit = (message: Parameters<(typeof listeners)['add']>[0] extends (message: infer Message) => void ? Message : never) => listeners.forEach(listener => listener(message))
  const finish = (state: 'completed' | 'stopped' | 'recovery_required', failure?: ProductTaskRunFailure) => { if (terminal) return; terminal = true; for (const pending of queuedSteers.values()) pending.resolve(false); queuedSteers.clear(); emit({ type: 'terminal', state, run_id: input.run_id, ...(state === 'recovery_required' ? { failure: failure ?? input.projection.classifyFailure(undefined) } : {}) }) }
  const emitAssistantText = (message: ProductHarnessMessage) => {
    if (message.type !== 'assistant' || !Array.isArray(message.message?.content)) return
    const text = message.message.content
      .filter((block): block is Extract<(typeof message.message.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    for (let offset = 0; offset < text.length; offset += 32_000) {
      emit({ type: 'event', event: 'delta', data: text.slice(offset, offset + 32_000) })
    }
  }
  const toolActivities = new Map<string, {
    kind: ProductTaskActivityKind
    parentId?: string
    plan?: import('../../../shared/product/taskEvents.js').ProductTaskPlan
  }>()
  const completedToolActivities = new Set<string>()
  const activityId = (toolUseId: string) => `activity_${createHash('sha256').update(`${input.run_id}:${toolUseId}`).digest('hex').slice(0, 32)}`
  const hookActivityId = (hookRunId: string) => activityId(`hook:${hookRunId}`)
  const emitHookRunActivity = (hookRun: ProductHookRunActivity) => {
    const phase = hookRun.phase
    const kind: ProductTaskActivityKind = 'automation'
    emit({
      type: 'event',
      event: 'activity',
      activity: {
        id: hookActivityId(hookRun.id),
        kind,
        phase,
        summary: input.projection.activitySummary(kind, phase),
      },
    })
  }
  const rememberToolActivity = (
    toolUseId: string,
    kind: ProductTaskActivityKind,
    parentToolUseId?: string,
    plan?: import('../../../shared/product/taskEvents.js').ProductTaskPlan,
  ) => {
    const parentId = parentToolUseId && parentToolUseId !== toolUseId
      ? activityId(parentToolUseId)
      : undefined
    toolActivities.delete(toolUseId)
    toolActivities.set(toolUseId, { kind, ...(parentId ? { parentId } : {}), ...(plan ? { plan } : {}) })
    while (toolActivities.size > 256) {
      const oldest = toolActivities.keys().next().value
      if (typeof oldest !== 'string') break
      toolActivities.delete(oldest)
      completedToolActivities.delete(oldest)
    }
  }
  const emitToolActivities = (message: ProductHarnessMessage, parentToolUseId?: string) => {
    const record = message as unknown as Record<string, unknown>
    const envelope = record.message && typeof record.message === 'object' && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : record
    if (!Array.isArray(envelope.content)) return
    if (record.type === 'assistant') {
      for (const block of envelope.content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue
        const value = block as Record<string, unknown>
        if (value.type !== 'tool_call' || typeof value.id !== 'string' || !value.id || value.id.length > 512 || toolActivities.has(value.id)) continue
        const kind = input.projection.activityKindForTool(typeof value.name === 'string' ? value.name : undefined)
        const plan = typeof value.name === 'string' && value.name.trim().toLowerCase() === 'todowrite'
          ? input.projection.projectPlan(value.arguments, input.run_id, value.id)
          : null
        rememberToolActivity(value.id, kind, parentToolUseId, plan ?? undefined)
        const tracked = toolActivities.get(value.id)!
        emit({ type: 'event', event: 'activity', activity: { id: activityId(value.id), ...(tracked.parentId ? { parentId: tracked.parentId } : {}), kind, phase: 'started', summary: input.projection.activitySummary(kind, 'started') } })
      }
      return
    }
    if (record.type !== 'user' && record.type !== 'tool_result') return
    for (const block of envelope.content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue
      const value = block as Record<string, unknown>
      const toolUseId = typeof value.tool_call_id === 'string' ? value.tool_call_id : undefined
      if (value.type !== 'tool_result' || !toolUseId || toolUseId.length > 512 || completedToolActivities.has(toolUseId)) continue
      const tracked = toolActivities.get(toolUseId)
      const kind = tracked?.kind ?? 'tool'
      completedToolActivities.add(toolUseId)
      const phase = value.is_error === true ? 'failed' : 'completed'
      if (phase === 'completed' && tracked?.plan) emit({ type: 'event', event: 'plan_updated', plan: tracked.plan })
      emit({ type: 'event', event: 'activity', activity: { id: activityId(toolUseId), ...(tracked?.parentId ? { parentId: tracked.parentId } : {}), kind, phase, summary: input.projection.activitySummary(kind, phase) } })
    }
  }
  observeNestedHarnessMessage = emitToolActivities
  let streamedAssistantText = false
  const evaluateProductHook = async (prompt: string, requestedModel: string | undefined, signal: AbortSignal) => {
    const model = input.model_policy.resolve(requestedModel)
    if (!model) return { ok: false, reason: 'Hook model is not registered for this product' }
    let response = ''
    try {
      for await (const event of input.run_model({
        messages: [createProductUserMessage({ content: prompt })],
        systemPrompt: ['Evaluate the project Hook condition. Return exactly one JSON object: {"ok":true} or {"ok":false,"reason":"brief reason"}. Do not call tools and do not add prose.'],
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: { model },
        toolPermissionContext,
      })) {
        if (event.type !== 'assistant') continue
        if (event.operation_receipt) pendingOperationReceipts.set(`${event.operation_receipt.source}:${event.operation_receipt.operation_id}`, event.operation_receipt)
        response += event.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      }
      const tooLarge = response.length > 8_000
      try {
        await persistHarnessSession()
        await acknowledgePersistedOperationReceipts(signal)
      } catch (error) {
        throw new Error('PRODUCT_HOOK_RECEIPT_DURABILITY_FAILED', { cause: error })
      }
      const parsed = tooLarge ? undefined : JSON.parse(response.trim()) as { ok?: unknown; reason?: unknown }
      return parsed?.ok === true
        ? { ok: true }
        : { ok: false, reason: tooLarge ? 'Hook evaluator response exceeded the limit' : typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 4_000) : 'Hook condition was not satisfied' }
    } catch (error) {
      if (error instanceof Error && error.message === 'PRODUCT_HOOK_RECEIPT_DURABILITY_FAILED') throw error
      return { ok: false, reason: signal.aborted ? 'Hook evaluation was cancelled' : 'Hook evaluator returned an invalid response' }
    }
  }
  const lifecycleHooks = input.lifecycle_hooks ?? createProductHarnessLifecycleHookHost({
    snapshot: productHookSnapshot,
    cwd: input.work_dir,
    evaluate: evaluateProductHook,
    run_external_operation: runExternalOperation,
    on_hook_run: emitHookRunActivity,
  })
  const productToolHooks: ProductToolHooks = {
    before: block => lifecycleHooks.preTool({
      toolName: block.name,
      toolInput: block.arguments,
      toolUseId: block.id,
      signal: controller?.signal ?? new AbortController().signal,
    }),
    after: (block, result) => lifecycleHooks.postTool({
      toolName: block.name,
      toolInput: block.arguments,
      toolUseId: block.id,
      success: result.success,
      result: result.content,
      signal: controller?.signal ?? new AbortController().signal,
    }),
  }

  const stopHarness = async (): Promise<void> => {
    if (terminal) return
    emit({ type: 'event', event: 'stopping' })
    controller?.abort()
    for (const resolve of approvals.values()) resolve({ approved: false })
    finish('stopped')
  }

  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async input(text, attachments = [], queueItemId) {
      if (queueItemId) {
        if (!text || attachments.length > 0 || terminal || !controller || !/^queue_[a-f0-9-]{36}$/.test(queueItemId)) return false
        const existing = queuedSteers.get(queueItemId)
        if (existing) return existing.promise
        let resolve!: (consumed: boolean) => void
        const promise = new Promise<boolean>(next => { resolve = next })
        queuedSteers.set(queueItemId, { command: { mode: 'prompt', value: text, uuid: queueItemId, priority: 'next' }, promise, resolve })
        return promise
      }
      if ((!text && attachments.length === 0) || terminal || controller) return false
      controller = createAbortController()
      if (restoredSameRun && persistedExternalOperationCheckpoints.length > 0) {
        try {
          await input.reconcile_external_operation_checkpoints?.(persistedExternalOperationCheckpoints)
        } catch (error) {
          finish('recovery_required', input.projection.classifyFailure(error))
          controller = undefined
          return
        }
      }
      emit({ type: 'event', event: 'started' })
      if (restoredSameRun && restoredHarnessSession) {
        try {
          await acknowledgePersistedOperationReceipts(controller.signal)
        } catch (error) { finish('recovery_required', input.projection.classifyFailure(error)); controller = undefined; return }
      }
      if (restoredSameRun && restoredHarnessSession?.turn_state === 'completed') {
        try {
          const completedResult = restoredHarnessSession.completed_result ?? ''
          for (let offset = 0; offset < completedResult.length; offset += 32_000) {
            emit({ type: 'event', event: 'delta', data: completedResult.slice(offset, offset + 32_000) })
          }
          finish('completed')
        } catch (error) { finish('recovery_required', input.projection.classifyFailure(error)) } finally { controller = undefined }
        return
      }
      if (text.trim() === '/init' && input.auto_memory) {
        const autoMemory = input.auto_memory
        try {
          const initialized = await runExternalOperation('workspace_init', async () => await autoMemoryRepository!.initialize(autoMemory))
          const result = initialized.created || initialized.instruction_created ? '项目已初始化。' : '项目已经初始化，无需更改。'
          emit({ type: 'event', event: 'delta', data: result })
          await persistHarnessSession(modelMessages, 'completed', result)
          finish('completed')
        } catch (error) { finish('recovery_required', input.projection.classifyFailure(error)) } finally { controller = undefined }
        return
      }
      try {
        await connectMcpHost()
        if (controller.signal.aborted || terminal) return
        const model = input.model_policy.resolve()
        if (!model) throw new Error('MODEL_CONFIGURATION_INVALID')
        const baseCommands = uniqBy([...await (input.load_commands ?? loadProductAgentCommands)(input.work_dir), ...mcpRuntime.commands], 'name')
        const baseTools = input.load_tools ? input.load_tools(toolPermissionContext) : loadProductAgentTools(toolPermissionContext, baseCommands)
        const extensionTools = await loadProductAgentExtensionTools(input.work_dir)
        const tools = uniqBy([...baseTools, ...extensionTools, ...mcpRuntime.tools], 'name')
        const commands = uniqBy([...baseCommands, ...productAgentCommands(extensionTools)], 'name')
        const extensionSnapshotPayload = JSON.stringify({
          commands: commands.map(command => command.name).sort(),
          tools: tools.map(tool => tool.name).sort(),
          mcp_servers: mcpRuntime.clients.map(client => client.name).sort(),
          instructions: instructionSnapshot.digest,
          hooks: productHookSnapshot.digest,
        })
        const extensionSnapshot = {
          digest: createHash('sha256').update(extensionSnapshotPayload).digest('hex'),
          tool_count: tools.length,
          command_count: commands.length,
          mcp_server_count: mcpRuntime.clients.length,
        }
        // The result of `prepare` is not safe to reuse until the exact tool
        // surface is frozen in the authority Run record.  Do this before
        // Hooks, which can themselves cross external boundaries.
        if (input.checkpoint_mcp_prepare) {
          await input.checkpoint_mcp_prepare(extensionSnapshot)
          // The authority checkpoint above already committed this exact
          // snapshot. Re-emitting it through the normal Worker sink would
          // perform a second claim-guarded write and creates a stop race.
        } else {
          emit({ type: 'event', event: 'extension_snapshot', ...extensionSnapshot })
        }
        if (!recoveringPreparedTurn && !recoveringActiveTurn) {
          const hookContext = createToolUseContext([], [], controller, model)
          const hookSource = restoredHarnessSession ? 'resume' as const : 'startup' as const
          const hookResults = await runInProductScope(async () => {
            const sessionStart = await lifecycleHooks.sessionStart({
              source: hookSource,
              sessionId: input.session_id,
              model,
              signal: controller!.signal,
            })
            if (sessionStart.blocked) return sessionStart
            const userPrompt = await lifecycleHooks.userPrompt({
              prompt: text,
              permissionMode: toolPermissionContext.mode,
              context: hookContext,
            })
            return {
              ...userPrompt,
              additionalContext: [sessionStart.additionalContext, userPrompt.additionalContext].filter(Boolean).join('\n\n') || undefined,
            }
          })
          if (hookResults.blocked) {
            const result = '项目 Hook 已阻止本次请求。请检查项目自动化规则后重试。'
            emit({ type: 'event', event: 'delta', data: result })
            await persistHarnessSession(modelMessages, 'completed', result)
            finish('completed')
            return
          }
          productHookContext = (hookResults.additionalContext ?? '').slice(0, 40_000)
          await persistHarnessSession(modelMessages, 'preparing')
        }
        const privateContext = modelMessages.map(message => JSON.stringify(message)).join('\n')
        const compactionContext = [
          productSessionContext,
          privateContext ? `<structured_tool_context>\n${privateContext}\n</structured_tool_context>` : '',
        ].filter(Boolean).join('\n\n')
        const estimatedContextTokens = Math.max(
          input.session_context?.estimated_tokens ?? 0,
          Math.ceil(compactionContext.length / 4),
        )
        const clearContext = text.trim() === '/clear'
        const manualCompaction = text.trim() === '/compact' || clearContext
        if (manualCompaction && !compactionContext) {
          const result = clearContext ? '当前没有可清空的上下文。' : '当前没有可压缩的上下文。'
          emit({ type: 'event', event: 'delta', data: result })
          await persistHarnessSession(modelMessages, 'completed', result)
          finish('completed')
          return
        }
        if (compactionContext && !recoveringActiveTurn && (manualCompaction || estimatedContextTokens >= input.model_policy.compactThreshold(model))) {
          const source = compactionContext
          const compactGeneration = (input.session_context?.compact_generation ?? 0) + 1
          const compactSource = manualCompaction ? 'manual' as const : 'automatic' as const
          const compactTrigger = manualCompaction ? 'manual' as const : 'auto' as const
          emit({ type: 'event', event: 'context_compaction', phase: 'started', source: compactSource, generation: compactGeneration, input_tokens: estimatedContextTokens })
          try {
            const preCompact = await runInProductScope(() => lifecycleHooks.preCompact({ trigger: compactTrigger, signal: controller!.signal }))
            const summarize = async (history: string): Promise<string> => {
              let summary: string | undefined
              const toolUseContext = createToolUseContext([], [], controller!, model)
              const stream = (input.query ?? runProductAgentLoop)({
                commands: [],
                prompt: `请把下面的 BilliardBuddy 任务历史压缩为可供后续模型继续工作的事实摘要。保留用户目标、已完成结果、未完成事项、约束、关键决定和必要的验证结论；删除寒暄、重复内容和无关过程。不要执行工具，不要添加历史中不存在的事实。只输出摘要正文。${preCompact.instructions ? `\n\n项目 Hook 的额外压缩要求：\n${preCompact.instructions}` : ''}\n\n${history}`,
                tools: [],
                toolUseContext,
                promptContext: { workspace: input.work_dir, date: getLocalISODate() },
                model,
                canUseTool: async () => ({ behavior: 'deny', message: 'Context compaction cannot use tools', reason: 'context-compaction', toolUseID: 'context-compaction' }),
                runModel: input.run_model,
                executeTools: input.execute_tools,
              })
              for await (const message of stream) {
                if (message.type === 'assistant') {
                  for (const receipt of productHarnessMessageOperationReceipts(message)) {
                    pendingOperationReceipts.set(`${receipt.source}:${receipt.operation_id}`, receipt)
                  }
                }
                if (message.type === 'result' && message.subtype === 'success' && !message.is_error) summary = message.result
              }
              if (!summary?.trim()) throw new Error('CONTEXT_COMPACTION_FAILED')
              return summary.trim()
            }
            let summary: string
            if (clearContext) {
              summary = '用户已清空此前对话上下文；后续回合不得依赖更早的会话内容。'
            } else {
              const partials: string[] = []
              for (let offset = 0; offset < source.length; offset += 24_000) partials.push(await summarize(source.slice(offset, offset + 24_000)))
              summary = partials.join('\n\n')
              while (summary.length > 30_000) {
                const reduced: string[] = []
                for (let offset = 0; offset < summary.length; offset += 24_000) reduced.push(await summarize(summary.slice(offset, offset + 24_000)))
                const next = reduced.join('\n\n')
                if (next.length >= summary.length) throw new Error('CONTEXT_COMPACTION_FAILED')
                summary = next
              }
            }
            if (!summary || summary.length > 40_000 || controller.signal.aborted) throw new Error('CONTEXT_COMPACTION_FAILED')
            productSessionContext = `<context_summary generation="${compactGeneration}">\n${summary}\n</context_summary>`
            modelMessages.splice(0, modelMessages.length)
            await persistHarnessSession(modelMessages, 'preparing')
            await acknowledgePersistedOperationReceipts(controller.signal)
            await runInProductScope(() => lifecycleHooks.postCompact({ trigger: compactTrigger, summary, signal: controller!.signal }))
            emit({ type: 'event', event: 'context_compaction', phase: 'completed', source: compactSource, generation: compactGeneration, input_tokens: estimatedContextTokens, output_tokens: Math.max(1, Math.ceil(summary.length / 4)), summary, compacted_through_event_sequence: input.session_context?.event_sequence ?? 0 })
            if (manualCompaction) {
              const result = clearContext ? '上下文已清空。' : '上下文已压缩。'
              emit({ type: 'event', event: 'delta', data: result })
              await persistHarnessSession(modelMessages, 'completed', result)
              finish('completed')
              return
            }
          } catch (error) {
            emit({ type: 'event', event: 'context_compaction', phase: 'failed', source: compactSource, generation: compactGeneration, input_tokens: estimatedContextTokens })
            throw error
          }
        }
        let completedResult: string | undefined
        let prompt = await (input.build_chat_prompt ?? ((value, files) => buildProductChatPrompt(value, files)))(text, attachments, controller.signal)
        let resumePersistedTurn = recoveringActiveTurn
        await runWithProductPermissionEnvelope(input.permission_envelope, () => (
          runInProductScope(async () => {
            const toolUseContext = createToolUseContext(commands, tools, controller!, model)
            for (let stopHookRound = 0; stopHookRound < 4; stopHookRound += 1) {
              completedResult = undefined
              const stream = (input.query ?? runProductAgentLoop)({
                commands,
                prompt,
                tools,
                toolUseContext,
                promptContext: productPromptContext(),
                model,
                canUseTool: async (tool, toolInput, context, _assistant, toolUseId, forced) => {
                const decision = forced ?? await decideProductToolPermission(input.permission_envelope, tool, toolInput, context)
                if (decision.behavior !== 'ask') return decision
                if (tool.name === 'AskUserQuestion') {
                  const questions = input.projection.projectQuestions(toolInput)
                  if (questions.length === 0) return { behavior: 'deny', message: 'Question cannot be rendered safely', reason: `mode:${toolPermissionContext.mode}`, toolUseID: toolUseId }
                  emit({ type: 'event', event: 'question', request_id: toolUseId, questions })
                  const response = await new Promise<{ approved: boolean; answers?: readonly string[] }>(resolve => approvals.set(toolUseId, resolve))
                  approvals.delete(toolUseId)
                  const updatedInput = response.approved && response.answers
                    ? input.projection.updateQuestionInput(toolInput as Record<string, unknown>, response.answers)
                    : null
                  return updatedInput
                    ? { behavior: 'allow', updatedInput, reason: `mode:${toolPermissionContext.mode}` }
                    : { behavior: 'deny', message: 'Product question was not answered', reason: `mode:${toolPermissionContext.mode}`, toolUseID: toolUseId }
                }
                emit({
                  type: 'event',
                  event: 'approval',
                  request_id: toolUseId,
                  action: input.projection.projectApproval(tool.name),
                  review: input.projection.projectApprovalReview(tool, toolInput),
                })
                const response = await new Promise<{ approved: boolean }>(resolve => approvals.set(toolUseId, resolve))
                approvals.delete(toolUseId)
                return response.approved
                  ? { behavior: 'allow', updatedInput: toolInput, reason: `mode:${toolPermissionContext.mode}` }
                  : { behavior: 'deny', message: 'Product approval denied', reason: `mode:${toolPermissionContext.mode}`, toolUseID: toolUseId }
                },
                commandQueue,
                mutableMessages: modelMessages,
                onMessageState: persistHarnessSession,
                onModelStreamCheckpoint: persistHarnessSession,
                onOperationReceiptsPersisted: async (_receipts, signal) => await acknowledgePersistedOperationReceipts(signal),
                runModel: input.run_model,
                executeTools: input.execute_tools,
                toolHooks: productToolHooks,
                resume: resumePersistedTurn,
              })
              for await (const message of stream) {
                if (message.type === 'model_delta') {
                  streamedAssistantText = true
                  emit({ type: 'event', event: 'delta', data: message.text })
                }
                else {
                  if (message.type === 'assistant' && !streamedAssistantText) emitAssistantText(message)
                  if (message.type === 'user' || message.type === 'assistant') emitToolActivities(message)
                  if (message.type === 'result' && message.subtype === 'success' && !message.is_error) completedResult = message.result
                }
              }
              resumePersistedTurn = false
              if (completedResult === undefined) throw new Error('PRODUCT_AGENT_TURN_INCOMPLETE')
              const stopHook = await lifecycleHooks.stop({
                permissionMode: toolPermissionContext.mode,
                signal: controller!.signal,
                context: toolUseContext,
                messages: modelMessages,
              })
              if (!stopHook.blocked) break
              if (stopHookRound === 3) throw new Error('PRODUCT_STOP_HOOK_LIMIT')
              productHookContext = [productHookContext, stopHook.additionalContext].filter(Boolean).join('\n\n')
              prompt = `项目 Stop Hook 要求继续处理：${stopHook.reason ?? '当前结果尚未满足项目自动化规则。'}\n请根据真实工具结果继续完成，不要把 Hook 阻止误报为完成。`
            }
          })
        ))
        if (completedResult !== undefined && input.auto_memory) {
          const autoMemory = input.auto_memory
          const assistant = completedResult
          productAutoMemory = await runExternalOperation('auto_memory_append', async () => await autoMemoryRepository!.appendCompletedTurn(autoMemory, { task_id: autoMemory.task_id, entry_id: autoMemory.entry_id, user: text, assistant }))
        }
        if (completedResult !== undefined) await persistHarnessSession(modelMessages, 'completed', completedResult)
        finish(controller.signal.aborted ? 'stopped' : 'completed')
      } catch (error) {
        finish(controller.signal.aborted ? 'stopped' : 'recovery_required', input.projection.classifyFailure(error))
      } finally { controller = undefined }
    },
    async approve(requestId, approved) { approvals.get(requestId)?.({ approved }) },
    async answer(requestId, answers) { approvals.get(requestId)?.({ approved: true, answers }) },
    stop: stopHarness,
    async shutdown() { await stopHarness(); await closeMcpHost() },
  }
}
