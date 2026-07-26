import { createHash, randomUUID } from 'node:crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { getLocalISODate } from '../../constants/common.js'
import type { ProductHarnessMessage, ProductPrompt } from '../../../shared/product/harnessMessages.js'
import { createAbortController } from '../../utils/abortController.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { ProductAutoMemoryRepository, type ProductAutoMemoryBinding } from '../services/productAutoMemory.js'
import { createProductInstructionSnapshot } from '../services/productInstructions.js'
import { projectAgentWorkerApprovalReview, projectProductTaskActionApproval } from '../product/taskApprovalProjection.js'
import { productTaskActivityKindForTool, productTaskActivitySummary } from '../product/taskEventProjection.js'
import { projectAnswerableAskUserQuestions } from '../product/taskEventProjection.js'
import { buildProductTaskAskUserQuestionUpdatedInput } from '../product/taskInboundPolicy.js'
import type { ProductTaskMcpHost } from './mcpHost.js'
import { runProductAgentLoop } from './productAgentLoop.js'
import type { ProductAgentLoopInput } from './productAgentLoop.js'
import { runProductModel } from './productModelRuntime.js'
import { createProductUserMessage } from './productMessages.js'
import { loadProductAgentCommands, loadProductAgentExtensionTools } from './productExtensionLoader.js'
import { productAgentCommands } from './productPluginAgentLoader.js'
import { loadProductAgentTools } from './productToolLoader.js'
import { buildProductChatPrompt } from './productChatAttachments.js'
import {
  ProductHarnessSessionRepository,
  type ProductHarnessSessionBinding,
} from './harnessSessionRepository.js'
import {
  createProductHarnessLifecycleHookHost,
  type ProductHarnessLifecycleHookHost,
} from './productLifecycleHooks.js'
import { createProductHookSnapshot } from './productHookSnapshot.js'
import { decideProductToolPermission } from './productPermissionDecision.js'
import { emptyProductToolPermissionContext, type ProductCommand, type ProductQueuedCommand, type ProductToolContext, type ProductToolHooks, type ProductToolPermissionContext, type ProductTools } from './productTool.js'
import { productCompactThreshold, productDefaultTextModel, resolveProductTextModel } from '../product/productGatewayRuntime.js'
import { classifyProductTaskRunFailure } from '../product/taskRunFailure.js'
import type { ProductTaskRunFailure } from '../../../shared/product/taskEvents.js'

export type ProductAgentHarnessPort = {
  input(text: string, attachments?: readonly string[], queueItemId?: string): Promise<boolean | void>
  approve(requestId: string, approved: boolean): Promise<void>
  answer(requestId: string, answers: readonly string[]): Promise<void>
  stop(): Promise<void>
  shutdown(): Promise<void>
  subscribe(listener: (message: Extract<AgentWorkerOutbound, { type: 'event' | 'terminal' }>) => void): () => void
}

export async function createProductAgentHarness(input: {
  run_id: string
  task_id?: string
  session_id: string
  work_dir: string
  permission_envelope: PermissionExecutionEnvelope
  mcp_host?: ProductTaskMcpHost
  query?: typeof runProductAgentLoop
  run_model?: ProductAgentLoopInput['runModel']
  execute_tools?: ProductAgentLoopInput['executeTools']
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
  let productHookContext = ''
  const modelMessages: ProductHarnessMessage[] = restoredHarnessSession?.messages ?? []
  const persistHarnessSession = async (messages: readonly ProductHarnessMessage[] = modelMessages) => {
    if (!input.harness_session) return
    await harnessSessionRepository!.save(input.harness_session, {
      context_prefix: productSessionContext,
      messages,
      run_id: input.run_id,
      instruction_digest: instructionSnapshot.digest,
      instruction_prompt: instructionSnapshot.prompt,
    })
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
  ): ProductToolContext => ({
    productTaskId: input.task_id,
    toolHooks: productToolHooks,
    productPromptContext: productPromptContext(),
    runProductModel: input.run_model,
    executeProductTools: input.execute_tools,
    options: {
      commands,
      mainLoopModel: productDefaultTextModel(),
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
  const finish = (state: 'completed' | 'stopped' | 'recovery_required', failure?: ProductTaskRunFailure) => { if (terminal) return; terminal = true; for (const pending of queuedSteers.values()) pending.resolve(false); queuedSteers.clear(); emit({ type: 'terminal', state, run_id: input.run_id, ...(state === 'recovery_required' ? { failure: failure ?? classifyProductTaskRunFailure(undefined) } : {}) }) }
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
    kind: ReturnType<typeof productTaskActivityKindForTool>
    parentId?: string
  }>()
  const completedToolActivities = new Set<string>()
  const activityId = (toolUseId: string) => `activity_${createHash('sha256').update(`${input.run_id}:${toolUseId}`).digest('hex').slice(0, 32)}`
  const rememberToolActivity = (
    toolUseId: string,
    kind: ReturnType<typeof productTaskActivityKindForTool>,
    parentToolUseId?: string,
  ) => {
    const parentId = parentToolUseId && parentToolUseId !== toolUseId
      ? activityId(parentToolUseId)
      : undefined
    toolActivities.delete(toolUseId)
    toolActivities.set(toolUseId, { kind, ...(parentId ? { parentId } : {}) })
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
        const kind = productTaskActivityKindForTool(typeof value.name === 'string' ? value.name : undefined)
        rememberToolActivity(value.id, kind, parentToolUseId)
        const tracked = toolActivities.get(value.id)!
        emit({ type: 'event', event: 'activity', activity: { id: activityId(value.id), ...(tracked.parentId ? { parentId: tracked.parentId } : {}), kind, phase: 'started', summary: productTaskActivitySummary(kind, 'started') } })
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
      emit({ type: 'event', event: 'activity', activity: { id: activityId(toolUseId), ...(tracked?.parentId ? { parentId: tracked.parentId } : {}), kind, phase, summary: productTaskActivitySummary(kind, phase) } })
    }
  }
  observeNestedHarnessMessage = emitToolActivities
  let streamedAssistantText = false
  const evaluateProductHook = async (prompt: string, requestedModel: string | undefined, signal: AbortSignal) => {
    const model = resolveProductTextModel(requestedModel)
    if (!model) return { ok: false, reason: 'Hook model is not registered for this product' }
    let response = ''
    try {
      for await (const event of (input.run_model ?? runProductModel)({
        messages: [createProductUserMessage({ content: prompt })],
        systemPrompt: ['Evaluate the project Hook condition. Return exactly one JSON object: {"ok":true} or {"ok":false,"reason":"brief reason"}. Do not call tools and do not add prose.'],
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: { model },
        toolPermissionContext,
      })) {
        if (event.type !== 'assistant') continue
        response += event.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (response.length > 8_000) return { ok: false, reason: 'Hook evaluator response exceeded the limit' }
      }
      const parsed = JSON.parse(response.trim()) as { ok?: unknown; reason?: unknown }
      return parsed.ok === true
        ? { ok: true }
        : { ok: false, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 4_000) : 'Hook condition was not satisfied' }
    } catch {
      return { ok: false, reason: signal.aborted ? 'Hook evaluation was cancelled' : 'Hook evaluator returned an invalid response' }
    }
  }
  const lifecycleHooks = input.lifecycle_hooks ?? createProductHarnessLifecycleHookHost({
    snapshot: productHookSnapshot,
    cwd: input.work_dir,
    evaluate: evaluateProductHook,
    onAsyncRewake: value => {
      if (terminal || !controller) return
      const queueItemId = `queue_${randomUUID()}`
      const details = [value.additionalContext, value.reason].filter(Boolean).join('\n\n').slice(0, 20_000)
      if (!details) return
      let resolve!: (consumed: boolean) => void
      const promise = new Promise<boolean>(next => { resolve = next })
      queuedSteers.set(queueItemId, {
        command: {
          mode: 'prompt',
          value: `<project_hook_context event="${value.event}" async="true">\n${details}\n</project_hook_context>`,
          uuid: queueItemId,
          priority: 'next',
          isMeta: true,
        },
        promise,
        resolve,
      })
    },
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
      emit({ type: 'event', event: 'started' })
      if (text.trim() === '/init' && input.auto_memory) {
        try {
          const initialized = await autoMemoryRepository!.initialize(input.auto_memory)
          emit({ type: 'event', event: 'delta', data: initialized.created || initialized.instruction_created ? '项目已初始化。' : '项目已经初始化，无需更改。' })
          finish('completed')
        } catch (error) { finish('recovery_required', classifyProductTaskRunFailure(error)) } finally { controller = undefined }
        return
      }
      try {
        await connectMcpHost()
        if (controller.signal.aborted || terminal) return
        const model = resolveProductTextModel()
        if (!model) throw new Error('MODEL_CONFIGURATION_INVALID')
        const hookContext = createToolUseContext([], [], controller)
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
          emit({ type: 'event', event: 'delta', data: '项目 Hook 已阻止本次请求。请检查项目自动化规则后重试。' })
          finish('completed')
          return
        }
        productHookContext = hookResults.additionalContext ?? ''
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
          emit({ type: 'event', event: 'delta', data: clearContext ? '当前没有可清空的上下文。' : '当前没有可压缩的上下文。' })
          finish('completed')
          return
        }
        if (compactionContext && (manualCompaction || estimatedContextTokens >= productCompactThreshold(model))) {
          const source = compactionContext
          const compactGeneration = (input.session_context?.compact_generation ?? 0) + 1
          const compactSource = manualCompaction ? 'manual' as const : 'automatic' as const
          const compactTrigger = manualCompaction ? 'manual' as const : 'auto' as const
          emit({ type: 'event', event: 'context_compaction', phase: 'started', source: compactSource, generation: compactGeneration, input_tokens: estimatedContextTokens })
          try {
            const preCompact = await runInProductScope(() => lifecycleHooks.preCompact({ trigger: compactTrigger, signal: controller!.signal }))
            const summarize = async (history: string): Promise<string> => {
              let summary: string | undefined
              const toolUseContext = createToolUseContext([], [], controller!)
              const stream = (input.query ?? runProductAgentLoop)({
                commands: [],
                prompt: `请把下面的 BilliardBuddy 任务历史压缩为可供后续模型继续工作的事实摘要。保留用户目标、已完成结果、未完成事项、约束、关键决定和必要的验证结论；删除寒暄、重复内容和无关过程。不要执行工具，不要添加历史中不存在的事实。只输出摘要正文。${preCompact.instructions ? `\n\n项目 Hook 的额外压缩要求：\n${preCompact.instructions}` : ''}\n\n${history}`,
                tools: [],
                toolUseContext,
                promptContext: { workspace: input.work_dir, date: getLocalISODate() },
                canUseTool: async () => ({ behavior: 'deny', message: 'Context compaction cannot use tools', reason: 'context-compaction', toolUseID: 'context-compaction' }),
                runModel: input.run_model,
              })
              for await (const message of stream) if (message.type === 'result' && message.subtype === 'success' && !message.is_error) summary = message.result
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
            await persistHarnessSession()
            await runInProductScope(() => lifecycleHooks.postCompact({ trigger: compactTrigger, summary, signal: controller!.signal }))
            emit({ type: 'event', event: 'context_compaction', phase: 'completed', source: compactSource, generation: compactGeneration, input_tokens: estimatedContextTokens, output_tokens: Math.max(1, Math.ceil(summary.length / 4)), summary, compacted_through_event_sequence: input.session_context?.event_sequence ?? 0 })
            if (manualCompaction) {
              emit({ type: 'event', event: 'delta', data: clearContext ? '上下文已清空。' : '上下文已压缩。' })
              finish('completed')
              return
            }
          } catch (error) {
            emit({ type: 'event', event: 'context_compaction', phase: 'failed', source: compactSource, generation: compactGeneration, input_tokens: estimatedContextTokens })
            throw error
          }
        }
        const baseCommands = uniqBy([...await (input.load_commands ?? loadProductAgentCommands)(input.work_dir), ...mcpRuntime.commands], 'name')
        const baseTools = input.load_tools ? input.load_tools(toolPermissionContext) : loadProductAgentTools(toolPermissionContext, baseCommands)
        const extensionTools = await loadProductAgentExtensionTools(input.work_dir)
        const tools = uniqBy([...baseTools, ...extensionTools, ...mcpRuntime.tools], 'name')
        const commands = uniqBy([...baseCommands, ...productAgentCommands(extensionTools)], 'name')
        const extensionSnapshot = JSON.stringify({
          commands: commands.map(command => command.name).sort(),
          tools: tools.map(tool => tool.name).sort(),
          mcp_servers: mcpRuntime.clients.map(client => client.name).sort(),
          instructions: instructionSnapshot.digest,
          hooks: productHookSnapshot.digest,
        })
        emit({
          type: 'event',
          event: 'extension_snapshot',
          digest: createHash('sha256').update(extensionSnapshot).digest('hex'),
          tool_count: tools.length,
          command_count: commands.length,
          mcp_server_count: mcpRuntime.clients.length,
        })
        let completedResult: string | undefined
        let prompt = await (input.build_chat_prompt ?? ((value, files) => buildProductChatPrompt(value, files)))(text, attachments, controller.signal)
        await runWithProductPermissionEnvelope(input.permission_envelope, () => (
          runInProductScope(async () => {
            const toolUseContext = createToolUseContext(commands, tools, controller!)
            for (let stopHookRound = 0; stopHookRound < 4; stopHookRound += 1) {
              completedResult = undefined
              const stream = (input.query ?? runProductAgentLoop)({
                commands,
                prompt,
                tools,
                toolUseContext,
                promptContext: productPromptContext(),
                canUseTool: async (tool, toolInput, context, _assistant, toolUseId, forced) => {
                const decision = forced ?? await decideProductToolPermission(input.permission_envelope, tool, toolInput, context)
                if (decision.behavior !== 'ask') return decision
                if (tool.name === 'AskUserQuestion') {
                  const questions = projectAnswerableAskUserQuestions(toolInput)
                  if (questions.length === 0) return { behavior: 'deny', message: 'Question cannot be rendered safely', reason: `mode:${toolPermissionContext.mode}`, toolUseID: toolUseId }
                  emit({ type: 'event', event: 'question', request_id: toolUseId, questions })
                  const response = await new Promise<{ approved: boolean; answers?: readonly string[] }>(resolve => approvals.set(toolUseId, resolve))
                  approvals.delete(toolUseId)
                  const updatedInput = response.approved && response.answers
                    ? buildProductTaskAskUserQuestionUpdatedInput(toolInput as Record<string, unknown>, response.answers)
                    : null
                  return updatedInput
                    ? { behavior: 'allow', updatedInput, reason: `mode:${toolPermissionContext.mode}` }
                    : { behavior: 'deny', message: 'Product question was not answered', reason: `mode:${toolPermissionContext.mode}`, toolUseID: toolUseId }
                }
                emit({
                  type: 'event',
                  event: 'approval',
                  request_id: toolUseId,
                  action: projectProductTaskActionApproval(tool.name),
                  review: projectAgentWorkerApprovalReview(tool, toolInput),
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
                runModel: input.run_model,
                executeTools: input.execute_tools,
                toolHooks: productToolHooks,
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
        if (completedResult !== undefined && input.auto_memory) productAutoMemory = await autoMemoryRepository!.appendCompletedTurn(input.auto_memory, { task_id: input.auto_memory.task_id, entry_id: input.auto_memory.entry_id, user: text, assistant: completedResult })
        finish(controller.signal.aborted ? 'stopped' : 'completed')
      } catch (error) {
        finish(controller.signal.aborted ? 'stopped' : 'recovery_required', classifyProductTaskRunFailure(error))
      } finally { controller = undefined }
    },
    async approve(requestId, approved) { approvals.get(requestId)?.({ approved }) },
    async answer(requestId, answers) { approvals.get(requestId)?.({ approved: true, answers }) },
    stop: stopHarness,
    async shutdown() { await stopHarness(); await closeMcpHost() },
  }
}
