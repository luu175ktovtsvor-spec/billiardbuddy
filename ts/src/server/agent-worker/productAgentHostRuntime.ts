import uniqBy from 'lodash-es/uniqBy.js'
import type { AgentWorkerOutbound } from '../../../shared/product/agentWorker.js'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductModelEvent, ProductPrompt, ProductToolCallBlock } from '../../../shared/product/harnessMessages.js'
import type { PersonalModelProfile } from '../../../shared/product/personalModels.js'
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
import { runProductModel } from './productModelRuntime.js'
import { runProductTools } from './productToolExecution.js'
import { decideProductToolPermission } from './productPermissionDecision.js'
import { emptyProductToolPermissionContext, type ProductCommand, type ProductContentBlock, type ProductThinkingConfig, type ProductToolContext, type ProductToolPermissionContext, type ProductTools } from './productTool.js'
import { buildProductChatPrompt } from './productChatAttachments.js'
import { getLocalISODate } from '../../constants/common.js'

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

export type ProductHostModelRequest = {
  messages: ProductHarnessMessage[]
  systemPrompt: string[]
  thinkingConfig: ProductThinkingConfig
  model?: string
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
  private modelOperationSequence = 0

  constructor(private readonly input: {
    work_dir: string
    task_id: string
    permission_envelope: PermissionExecutionEnvelope
    mcp_host: ProductTaskMcpHost
    attachment_paths?: readonly string[]
    model_binding: { provider: string; model: string }
    personal_profile: PersonalModelProfile | null
    model_attempt_id: string
  }) {
    this.personalProfile = input.personal_profile
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
        operationId: `${this.input.model_attempt_id}:model:${++this.modelOperationSequence}`,
      },
      toolPermissionContext: this.toolPermissionContext,
    })))
  }

  async tools(request: ProductHostToolRequest): Promise<ProductHarnessMessage[]> {
    await this.prepare()
    if (this.controller.signal.aborted) throw new Error('PRODUCT_AGENT_HOST_STOPPED')
    this.context!.messages = request.messages
    const output: ProductHarnessMessage[] = []
    await runWithProductPermissionEnvelope(this.input.permission_envelope, () => runWithCwdOverride(this.input.work_dir, async () => {
      for await (const update of runProductTools(request.blocks, request.assistantMessages, async (tool, toolInput, context, _assistant, toolUseId, forced) => {
        const decision = forced ?? await decideProductToolPermission(this.input.permission_envelope, tool, toolInput, context)
        if (decision.behavior !== 'ask') return decision
        if (tool.name === 'AskUserQuestion') {
          const questions = projectAnswerableAskUserQuestions(toolInput)
          if (questions.length === 0) return { behavior: 'deny', message: 'Question cannot be rendered safely', reason: `mode:${this.toolPermissionContext.mode}`, toolUseID: toolUseId }
          this.emit({ type: 'event', event: 'question', request_id: toolUseId, questions })
          const response = await new Promise<{ approved: boolean; answers?: readonly string[] }>(resolve => this.approvals.set(toolUseId, resolve))
          this.approvals.delete(toolUseId)
          const updatedInput = response.approved && response.answers ? buildProductTaskAskUserQuestionUpdatedInput(toolInput as Record<string, unknown>, response.answers) : null
          return updatedInput
            ? { behavior: 'allow', updatedInput, reason: `mode:${this.toolPermissionContext.mode}` }
            : { behavior: 'deny', message: 'Product question was not answered', reason: `mode:${this.toolPermissionContext.mode}`, toolUseID: toolUseId }
        }
        this.emit({ type: 'event', event: 'approval', request_id: toolUseId, action: projectProductTaskActionApproval(tool.name), review: projectAgentWorkerApprovalReview(tool, toolInput) })
        const response = await new Promise<{ approved: boolean }>(resolve => this.approvals.set(toolUseId, resolve))
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
