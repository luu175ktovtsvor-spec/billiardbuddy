import { createHash, randomUUID } from 'node:crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductModelEvent, ProductModelOperationReceipt, ProductPrompt, ProductToolCallBlock, ProductToolResultBlock } from '../../../shared/product/harnessMessages.js'
import type { PersonalModelProfile } from '../../../shared/product/personalModels.js'
import type { TextReasoningTransport } from '../../../shared/product/providerContracts.js'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { createAbortController } from '../../utils/abortController.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import { projectAgentWorkerApprovalReview, projectProductTaskActionApproval } from '../product/taskApprovalProjection.js'
import { buildProductTaskAskUserQuestionUpdatedInput } from '../product/taskInboundPolicy.js'
import { projectAnswerableAskUserQuestions } from '../product/taskEventProjection.js'
import { loadProductAgentCommands, loadProductAgentExtensionTools } from './productExtensionLoader.js'
import { productAgentCommands } from './productPluginAgentLoader.js'
import { loadProductAgentTools } from './productToolLoader.js'
import type { ProductTaskMcpHost } from './mcpHost.js'
import { acknowledgeProductModelOperation, runProductModel } from './productModelRuntime.js'
import { runProductTools } from './productToolExecution.js'
import { decideProductToolPermission } from './productPermissionDecision.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { emptyProductToolPermissionContext, type ProductCommand, type ProductContentBlock, type ProductThinkingConfig, type ProductToolContext, type ProductToolPermissionContext, type ProductTools } from './productTool.js'
import { buildProductChatPrompt } from './productChatAttachments.js'
import { getLocalISODate } from '../../constants/common.js'
import type { ProductAgentSubtaskCoordinator } from './productSubtaskCoordinator.js'

export type ProductHostCommandDescriptor = {
  name: string
  aliases?: string[]
  description: string
  disableModelInvocation?: boolean
  disableNonInteractive?: boolean
  userInvocable?: boolean
  directTool?: { name: string; argument: string }
}

export type ProductHostRuntimeSnapshot = {
  commands: ProductHostCommandDescriptor[]
  tools: Array<{ name: string }>
  mcp_clients: Array<{ name: string; type: 'connected' | 'failed' | 'needs-auth' | 'disabled' }>
}

/**
 * A serializable declaration of a tool that the Codex source may request.
 * It is intentionally a declaration only: the callable implementation and
 * permission policy remain in this Host process.
 */
export type ProductHostEngineToolDescriptor = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ProductHostEngineToolSurface = {
  digest: string
  tools: ProductHostEngineToolDescriptor[]
}

export type ProductHostEngineToolRequest = {
  /** Server-private ledger effect that owns this source tool call. */
  parent_operation_id: string
  tool_call_id: string
  tool_name: string
  arguments: Record<string, unknown>
  tool_surface_digest: string
}

export type ProductHostEngineToolResult = {
  is_error: boolean
  content: string | Array<Extract<ProductContentBlock, { type: 'text' | 'image' }>>
}

export type ProductHostModelRequest = {
  messages: ProductHarnessMessage[]
  systemPrompt: string[]
  thinkingConfig: ProductThinkingConfig
  model?: string
  /** Source-provided names only; schemas are rehydrated from the Host surface. */
  engine_tool_names?: string[]
  engine_tool_surface_digest?: string
}

export type ProductHostHookModelRequest = {
  prompt: string
  /** The accepted Run route is fixed; a Hook cannot switch providers mid-Turn. */
  model?: string
  timeout_ms?: number
}

export type ProductHostToolRequest = {
  blocks: ProductToolCallBlock[]
  assistantMessages: ProductAssistantMessage[]
  messages: ProductHarnessMessage[]
}

export type ProductAgentHostRuntime = {
  prepare(): Promise<ProductHostRuntimeSnapshot>
  commandPrompt(name: string, args: string): Promise<ProductContentBlock[]>
  chatPrompt(text: string, attachments: readonly string[]): Promise<ProductPrompt>
  model(request: ProductHostModelRequest): AsyncGenerator<ProductModelEvent, void>
  /**
   * The Codex source core owns its own loop.  It receives the same trusted
   * provider routing as the Harness, but no legacy MCP/tool surface leaks
   * into its model request before the product tool bridge is installed.
   */
  engineModel(request: ProductHostModelRequest): AsyncGenerator<ProductModelEvent, void>
  /** Run a no-tool project Hook evaluator on the already accepted model route. */
  hookModel(request: ProductHostHookModelRequest): AsyncGenerator<ProductModelEvent, void>
  /** Confirm a durable provider result from the source-owned model bridge. */
  acknowledgeModelResult(receipt: ProductModelOperationReceipt): Promise<void>
  /** The fixed tool surface that may be declared to the source Thread. */
  engineTools(): Promise<ProductHostEngineToolSurface>
  /** Execute one source-requested tool through the normal product Host. */
  engineTool(request: ProductHostEngineToolRequest): Promise<ProductHostEngineToolResult>
  tools(request: ProductHostToolRequest): Promise<ProductHarnessMessage[]>
  approve(requestId: string, approved: boolean): Promise<void>
  answer(requestId: string, answers: readonly string[]): Promise<void>
  stop(): Promise<void>
  shutdown(): Promise<void>
  subscribe(listener: (message: Extract<AgentWorkerOutbound, { type: 'event' }>) => void): () => void
}

export class StandardProductAgentHostRuntime implements ProductAgentHostRuntime {
  private readonly toolPermissionContext: ProductToolPermissionContext
  private readonly controller = createAbortController()
  private readonly approvals = new Map<string, (decision: { approved: boolean; answers?: readonly string[] }) => void>()
  private readonly listeners = new Set<(message: Extract<AgentWorkerOutbound, { type: 'event' }>) => void>()
  private commands: ProductCommand[] = []
  private toolsForTurn: ProductTools = []
  private context?: ProductToolContext
  private prepared?: Promise<ProductHostRuntimeSnapshot>
  private mcpCleanup: Array<() => Promise<void>> = []
  private readonly personalProfile: PersonalModelProfile | null
  private readonly managedTransport: TextReasoningTransport | null
  private modelOperationSequence = 0
  private engineToolSurface?: Promise<ProductHostEngineToolSurface>

  constructor(private readonly input: {
    work_dir: string
    task_id: string
    run_id: string
    dispatch_generation: number
    execution_claim_token: string
    permission_envelope: PermissionExecutionEnvelope
    mcp_host: ProductTaskMcpHost
    attachment_paths?: readonly string[]
    model_binding: { provider: string; model: string }
    personal_profile: PersonalModelProfile | null
    managed_transport: TextReasoningTransport | null
    model_attempt_id: string
    /** Child Runs cannot recursively delegate again. */
    subtask?: { parent_run_id: string }
    subtask_coordinator?: ProductAgentSubtaskCoordinator
  }) {
    this.personalProfile = input.personal_profile
    this.managedTransport = input.managed_transport
    const policy = input.permission_envelope.approval_policy
    this.toolPermissionContext = {
      ...emptyProductToolPermissionContext(),
      mode: policy === 'never' ? 'bypassPermissions' : policy === 'automatic_reviewer' ? 'acceptEdits' : 'default',
      isBypassPermissionsModeAvailable: policy === 'never',
    }
  }

  subscribe(listener: (message: Extract<AgentWorkerOutbound, { type: 'event' }>) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(message: Extract<AgentWorkerOutbound, { type: 'event' }>): void {
    for (const listener of this.listeners) listener(message)
  }

  prepare(): Promise<ProductHostRuntimeSnapshot> {
    this.prepared ??= runWithCwdOverride(this.input.work_dir, async () => {
      const mcp = await this.input.mcp_host.connect(this.input.work_dir, {
        taskId: this.input.task_id,
        networkScope: this.input.permission_envelope.network_scope,
      })
      this.mcpCleanup = mcp.clients.flatMap(client => client.cleanup ? [client.cleanup] : [])
      const baseCommands = uniqBy([...await loadProductAgentCommands(this.input.work_dir), ...mcp.commands], 'name')
      const extensionTools = await loadProductAgentExtensionTools(this.input.work_dir)
      this.toolsForTurn = uniqBy([...loadProductAgentTools(this.toolPermissionContext, baseCommands), ...extensionTools, ...mcp.tools], 'name')
      this.commands = uniqBy([...baseCommands, ...productAgentCommands(extensionTools)], 'name')
      this.context = {
        productTaskId: this.input.task_id,
        productPromptContext: {
          workspace: this.input.work_dir,
          date: getLocalISODate(),
        },
        options: {
          commands: this.commands,
          mainLoopModel: this.input.model_binding.model,
          tools: this.toolsForTurn,
          thinkingConfig: { type: 'adaptive' },
        },
        abortController: this.controller,
        permissionContext: this.toolPermissionContext,
        messages: [],
      }
      return {
        commands: this.commands.map(command => ({
          name: command.name,
          aliases: command.aliases,
          description: command.description,
          disableModelInvocation: command.disableModelInvocation,
          disableNonInteractive: command.disableNonInteractive,
          userInvocable: command.userInvocable,
          directTool: command.directTool,
        })),
        tools: this.toolsForTurn.map(tool => ({ name: tool.name })),
        mcp_clients: mcp.clients.map(client => ({ name: client.name, type: client.type })),
      }
    })
    return this.prepared
  }

  async commandPrompt(name: string, args: string): Promise<ProductContentBlock[]> {
    await this.prepare()
    const command = this.commands.find(candidate => candidate.name === name || candidate.aliases?.includes(name))
    if (!command || command.disableNonInteractive) throw new Error('PRODUCT_COMMAND_UNAVAILABLE')
    return runWithCwdOverride(this.input.work_dir, async () => {
      const prompt = await command.getPromptForCommand(args, this.context!)
      return prompt
    })
  }

  async chatPrompt(text: string, attachments: readonly string[]): Promise<ProductPrompt> {
    const allowed = new Set(this.input.attachment_paths ?? [])
    if (attachments.length > allowed.size || attachments.some(file => !allowed.has(file))) throw new Error('ATTACHMENT_COPY_INVALID')
    return runWithCwdOverride(this.input.work_dir, () => buildProductChatPrompt(text, attachments, undefined, this.controller.signal))
  }

  async *model(request: ProductHostModelRequest): AsyncGenerator<ProductModelEvent, void> {
    await this.prepare()
    if (this.controller.signal.aborted) throw new Error('PRODUCT_AGENT_HOST_STOPPED')
    yield* runWithProductPermissionEnvelope(this.input.permission_envelope, () => runWithCwdOverride(this.input.work_dir, () => runProductModel({
      messages: request.messages,
      systemPrompt: request.systemPrompt as never,
      thinkingConfig: request.thinkingConfig,
      tools: this.toolsForTurn,
      signal: this.controller.signal,
      options: {
        model: this.input.model_binding.model,
        personalProfile: this.personalProfile,
        managedTransport: this.managedTransport,
        operationId: `${this.input.model_attempt_id}:model:${++this.modelOperationSequence}`,
      },
      toolPermissionContext: this.toolPermissionContext,
    })))
  }

  async *engineModel(request: ProductHostModelRequest): AsyncGenerator<ProductModelEvent, void> {
    const surface = await this.engineTools()
    const requestedNames = request.engine_tool_names ?? []
    if (
      request.engine_tool_surface_digest !== surface.digest
      || requestedNames.length !== surface.tools.length
      || requestedNames.some((name, index) => name !== surface.tools[index]?.name)
    ) throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISMATCH')
    if (this.controller.signal.aborted) throw new Error('PRODUCT_AGENT_HOST_STOPPED')
    yield* runWithProductPermissionEnvelope(this.input.permission_envelope, () => runWithCwdOverride(this.input.work_dir, () => runProductModel({
      messages: request.messages,
      systemPrompt: request.systemPrompt as never,
      thinkingConfig: request.thinkingConfig,
      tools: this.engineToolsForSurface(surface),
      signal: this.controller.signal,
      options: {
        model: this.input.model_binding.model,
        personalProfile: this.personalProfile,
        managedTransport: this.managedTransport,
        operationId: `${this.input.model_attempt_id}:engine-model:${++this.modelOperationSequence}`,
      },
      toolPermissionContext: this.toolPermissionContext,
    })))
  }

  async acknowledgeModelResult(receipt: ProductModelOperationReceipt): Promise<void> {
    if (this.controller.signal.aborted) throw new Error('PRODUCT_AGENT_HOST_STOPPED')
    await acknowledgeProductModelOperation(receipt, this.controller.signal)
  }

  async *hookModel(request: ProductHostHookModelRequest): AsyncGenerator<ProductModelEvent, void> {
    await this.prepare()
    if (request.model && request.model !== this.input.model_binding.model) throw new Error('PRODUCT_HOOK_MODEL_ROUTE_UNAVAILABLE')
    if (this.controller.signal.aborted) throw new Error('PRODUCT_AGENT_HOST_STOPPED')
    const signal = request.timeout_ms === undefined
      ? this.controller.signal
      : AbortSignal.any([this.controller.signal, AbortSignal.timeout(request.timeout_ms)])
    yield* runWithProductPermissionEnvelope(this.input.permission_envelope, () => runWithCwdOverride(this.input.work_dir, () => runProductModel({
      messages: [{
        type: 'user',
        uuid: `hook_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: request.prompt },
      }],
      systemPrompt: ['Evaluate the project Hook condition. Return exactly one JSON object: {"ok":true} or {"ok":false,"reason":"brief reason"}. Do not call tools and do not add prose.'],
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal,
      options: {
        model: this.input.model_binding.model,
        personalProfile: this.personalProfile,
        managedTransport: this.managedTransport,
        operationId: `${this.input.model_attempt_id}:hook-model:${++this.modelOperationSequence}`,
      },
      toolPermissionContext: this.toolPermissionContext,
    })))
  }

  engineTools(): Promise<ProductHostEngineToolSurface> {
    this.engineToolSurface ??= (async () => {
      await this.prepare()
      const tools = this.toolsForTurn
        // Plugin-owned agent loops still have no independent Run protocol.
        // TodoWrite is a normal Host tool whose accepted result is projected
        // synchronously by the source Core before that result is acknowledged.
        .filter(tool => !tool.name.startsWith('agent__'))
        .filter(tool => tool.name !== 'Subtask' || Boolean(this.input.subtask_coordinator && !this.input.subtask))
        .filter(tool => /^[A-Za-z0-9_-]{1,128}$/.test(tool.name))
        .sort((left, right) => left.name.localeCompare(right.name))
      if (tools.length > 256) throw new Error('CODEX_ENGINE_TOOL_LIMIT')
      const descriptors = await Promise.all(tools.map(async tool => {
        const options = {
          isNonInteractiveSession: true,
          toolPermissionContext: this.toolPermissionContext,
          tools: this.toolsForTurn,
        }
        const description = [
          await tool.description({}, options),
          await tool.prompt?.({ tools: this.toolsForTurn }),
        ].filter((value): value is string => Boolean(value?.trim())).join('\n\n').slice(0, 4_000)
        return {
          name: tool.name,
          description,
          input_schema: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),
        } satisfies ProductHostEngineToolDescriptor
      }))
      const digest = createHash('sha256').update(JSON.stringify({ version: 1, tools: descriptors })).digest('hex')
      return { digest, tools: descriptors }
    })()
    return this.engineToolSurface
  }

  async engineTool(request: ProductHostEngineToolRequest): Promise<ProductHostEngineToolResult> {
    const surface = await this.engineTools()
    if (
      !/^[-A-Za-z0-9_]{1,512}$/.test(request.tool_call_id)
      || !/^effect_[a-f0-9-]{36}$/.test(request.parent_operation_id)
      || !surface.tools.some(tool => tool.name === request.tool_name)
      || request.tool_surface_digest !== surface.digest
    ) throw new Error('CODEX_ENGINE_TOOL_REQUEST_INVALID')
    if (request.tool_name === 'Subtask') return await this.runEngineSubtask(request)
    const assistant: ProductAssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        id: `engine_tool_${request.tool_call_id}`,
        role: 'assistant',
        content: [{ type: 'tool_call', id: request.tool_call_id, name: request.tool_name, arguments: request.arguments }],
        model: 'billiardbuddy-engine-tool',
        stop_reason: 'tool_call',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
    const output = await this.runTools({
      blocks: assistant.message.content.filter((block): block is ProductToolCallBlock => block.type === 'tool_call'),
      assistantMessages: [assistant],
      messages: [],
    })
    const result = output
      .flatMap(message => Array.isArray(message.message.content) ? message.message.content : [])
      .find((block): block is ProductToolResultBlock => block.type === 'tool_result' && block.tool_call_id === request.tool_call_id)
    if (!result) throw new Error('CODEX_ENGINE_TOOL_RESULT_MISSING')
    return {
      is_error: result.is_error === true,
      content: result.content,
    }
  }

  private async runEngineSubtask(request: ProductHostEngineToolRequest): Promise<ProductHostEngineToolResult> {
    const coordinator = this.input.subtask_coordinator
    const keys = Object.keys(request.arguments).sort()
    const prompt = request.arguments.prompt
    const description = request.arguments.description
    if (
      !coordinator
      || this.input.subtask
      || keys.join(',') !== 'description,prompt'
      || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000
      || typeof description !== 'string' || !description.trim() || description.length > 160
    ) throw new Error('SUBTASK_INPUT_INVALID')
    return await coordinator.run({
      parent_run_id: this.input.run_id,
      parent_dispatch_generation: this.input.dispatch_generation,
      parent_execution_claim_token: this.input.execution_claim_token,
      parent_operation_id: request.parent_operation_id,
      parent_tool_call_id: request.tool_call_id,
      prompt,
      description,
      signal: this.controller.signal,
    })
  }

  async tools(request: ProductHostToolRequest): Promise<ProductHarnessMessage[]> {
    return await this.runTools(request)
  }

  private engineToolsForSurface(surface: ProductHostEngineToolSurface): ProductTools {
    const allowed = new Set(surface.tools.map(tool => tool.name))
    const tools = this.toolsForTurn.filter(tool => allowed.has(tool.name)).sort((left, right) => left.name.localeCompare(right.name))
    if (tools.length !== surface.tools.length || tools.some((tool, index) => tool.name !== surface.tools[index]?.name)) {
      throw new Error('CODEX_ENGINE_TOOL_SURFACE_MISMATCH')
    }
    return tools
  }

  private async runTools(request: ProductHostToolRequest): Promise<ProductHarnessMessage[]> {
    await this.prepare()
    if (this.controller.signal.aborted) throw new Error('PRODUCT_AGENT_HOST_STOPPED')
    this.context!.messages = request.messages
    const output: ProductHarnessMessage[] = []
    await runWithProductPermissionEnvelope(this.input.permission_envelope, () => runWithCwdOverride(this.input.work_dir, async () => {
      for await (const update of runProductTools(request.blocks, request.assistantMessages, async (tool, toolInput, context, _assistant, toolUseId, forced) => {
        if (tool.name === 'AskUserQuestion') {
          const questions = projectAnswerableAskUserQuestions(toolInput)
          if (questions.length === 0) return { behavior: 'deny', message: 'Question cannot be rendered safely', reason: `mode:${this.toolPermissionContext.mode}`, toolUseID: toolUseId }
          const responsePromise = new Promise<{ approved: boolean; answers?: readonly string[] }>(resolve => this.approvals.set(toolUseId, resolve))
          this.emit({ type: 'event', event: 'question', request_id: toolUseId, questions })
          const response = await responsePromise
          this.approvals.delete(toolUseId)
          const updatedInput = response.approved && response.answers ? buildProductTaskAskUserQuestionUpdatedInput(toolInput as Record<string, unknown>, response.answers) : null
          return updatedInput
            ? { behavior: 'allow', updatedInput, reason: `mode:${this.toolPermissionContext.mode}` }
            : { behavior: 'deny', message: 'Product question was not answered', reason: `mode:${this.toolPermissionContext.mode}`, toolUseID: toolUseId }
        }
        const decision = forced ?? await decideProductToolPermission(this.input.permission_envelope, tool, toolInput, context)
        if (decision.behavior !== 'ask') return decision
        const responsePromise = new Promise<{ approved: boolean }>(resolve => this.approvals.set(toolUseId, resolve))
        this.emit({ type: 'event', event: 'approval', request_id: toolUseId, action: projectProductTaskActionApproval(tool.name), review: projectAgentWorkerApprovalReview(tool, toolInput) })
        const response = await responsePromise
        this.approvals.delete(toolUseId)
        return response.approved
          ? { behavior: 'allow', updatedInput: toolInput, reason: `mode:${this.toolPermissionContext.mode}` }
          : { behavior: 'deny', message: 'Product approval denied', reason: `mode:${this.toolPermissionContext.mode}`, toolUseID: toolUseId }
      }, this.context!)) {
        this.context = update.newContext
        if (update.message) output.push(update.message)
      }
    }))
    return output
  }

  async approve(requestId: string, approved: boolean): Promise<void> { this.approvals.get(requestId)?.({ approved }) }
  async answer(requestId: string, answers: readonly string[]): Promise<void> { this.approvals.get(requestId)?.({ approved: true, answers }) }
  async stop(): Promise<void> {
    this.controller.abort()
    for (const resolve of this.approvals.values()) resolve({ approved: false })
    this.approvals.clear()
  }
  async shutdown(): Promise<void> {
    await this.stop()
    await Promise.allSettled(this.mcpCleanup.splice(0).map(cleanup => cleanup()))
  }
}
