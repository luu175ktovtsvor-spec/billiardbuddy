import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  type CreateMessageRequest,
  type CreateMessageResult,
  type CreateMessageResultWithTools,
  type ElicitRequest,
  type ElicitResult,
  type Result,
  type Tool as SdkMcpTool,
} from '@modelcontextprotocol/sdk/types.js'
import { existsSync } from 'node:fs'
import type { Tool, JSONSchema } from '../tools/Tool'
import { approvalClassFromAnnotations, commandForPlatform, loadMcpConfigFile, mcpToolName, type McpServerConfig } from './config'

type SdkMcpResource = Awaited<ReturnType<Client['listResources']>>['resources'][number]
type SdkMcpResourceTemplate = Awaited<ReturnType<Client['listResourceTemplates']>>['resourceTemplates'][number]
type SdkMcpPrompt = Awaited<ReturnType<Client['listPrompts']>>['prompts'][number]
type SdkMcpPromptMessage = Awaited<ReturnType<Client['getPrompt']>>['messages'][number]
type SdkMcpResourceContent = Awaited<ReturnType<Client['readResource']>>['contents'][number]

export interface McpConnection {
  serverName: string
  client: Client
  transport: Transport
  taskStore: InMemoryTaskStore
  tools: Tool[]
  resources: SdkMcpResource[]
  resourceTemplates: SdkMcpResourceTemplate[]
  prompts: SdkMcpPrompt[]
  close(): Promise<void>
}

export interface McpElicitationHandlerInput {
  serverName: string
  params: ElicitRequest['params']
  signal?: AbortSignal
}

export type McpElicitationHandler = (input: McpElicitationHandlerInput) => Promise<ElicitResult>

export interface McpSamplingHandlerInput {
  serverName: string
  params: CreateMessageRequest['params']
  signal?: AbortSignal
}

export type McpSamplingHandler = (input: McpSamplingHandlerInput) => Promise<CreateMessageResult | CreateMessageResultWithTools>

export interface LoadMcpToolsOptions {
  cwd?: string
  signal?: AbortSignal
  /** Connect/list timeout. Tool execution uses toolTimeoutMs to avoid killing long-running MCP tasks early. */
  timeoutMs?: number
  toolTimeoutMs?: number
  taskTtlMs?: number
  fetchImpl?: FetchLike
  elicitationHandler?: McpElicitationHandler
  samplingHandler?: McpSamplingHandler
}

export interface LoadedMcpTools {
  connections: McpConnection[]
  tools: Tool[]
  warnings: string[]
}

function truncate(text: string, max = 20000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return truncate(value)
  try {
    return truncate(JSON.stringify(value, null, 2))
  } catch {
    return String(value)
  }
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function formatContentBlock(block: CallToolResult['content'][number]): string {
  if (block.type === 'text') return block.text
  if (block.type === 'image') return `[image mimeType=${block.mimeType} bytes=${block.data.length}]`
  if (block.type === 'audio') return `[audio mimeType=${block.mimeType} bytes=${block.data.length}]`
  if (block.type === 'resource') {
    const resource = block.resource
    if ('text' in resource) return `<resource uri="${attr(resource.uri)}"${resource.mimeType ? ` mimeType="${attr(resource.mimeType)}"` : ''}>\n${resource.text}\n</resource>`
    return `<resource uri="${attr(resource.uri)}"${resource.mimeType ? ` mimeType="${attr(resource.mimeType)}"` : ''} blobBytes="${resource.blob.length}" />`
  }
  if (block.type === 'resource_link') {
    return `<resource_link uri="${attr(block.uri)}" name="${attr(block.name)}"${block.mimeType ? ` mimeType="${attr(block.mimeType)}"` : ''} />`
  }
  return formatUnknown(block)
}

type CallToolLikeResult = CallToolResult | Awaited<ReturnType<Client['callTool']>>

function formatResourceContent(content: SdkMcpResourceContent): string {
  if ('text' in content) {
    return `<resource uri="${attr(content.uri)}"${content.mimeType ? ` mimeType="${attr(content.mimeType)}"` : ''}>\n${content.text}\n</resource>`
  }
  return `<resource uri="${attr(content.uri)}"${content.mimeType ? ` mimeType="${attr(content.mimeType)}"` : ''} blobBytes="${content.blob.length}" />`
}

function formatPromptContent(content: SdkMcpPromptMessage['content']): string {
  if (content.type === 'text') return content.text
  if (content.type === 'image') return `[image mimeType=${content.mimeType} bytes=${content.data.length}]`
  if (content.type === 'audio') return `[audio mimeType=${content.mimeType} bytes=${content.data.length}]`
  if (content.type === 'resource') return formatContentBlock(content)
  if ('uri' in content && 'name' in content) {
    return `<resource_link uri="${attr(content.uri)}" name="${attr(content.name)}"${content.mimeType ? ` mimeType="${attr(content.mimeType)}"` : ''} />`
  }
  return formatUnknown(content)
}

function formatMcpResult(serverName: string, toolName: string, result: CallToolLikeResult, trace: string[] = []): string {
  const prefix = trace.length > 0
    ? `<mcp_task_trace server="${attr(serverName)}" tool="${attr(toolName)}">\n${trace.join('\n')}\n</mcp_task_trace>\n`
    : ''
  if ('toolResult' in result) {
    return `${prefix}<mcp_result server="${attr(serverName)}" tool="${attr(toolName)}">\n${formatUnknown(result.toolResult)}\n</mcp_result>`
  }
  const parts = result.content.map(formatContentBlock)
  if (result.structuredContent) {
    parts.push(`<structured_content>\n${formatUnknown(result.structuredContent)}\n</structured_content>`)
  }
  return prefix + [
    `<mcp_result server="${attr(serverName)}" tool="${attr(toolName)}"${result.isError ? ' isError="true"' : ''}>`,
    ...parts,
    '</mcp_result>',
  ].join('\n')
}

function schemaFor(tool: SdkMcpTool): JSONSchema {
  return tool.inputSchema as JSONSchema
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`
    const candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  throw new Error(`too many duplicate MCP tool names for ${base}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function primitiveElicitationValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  return undefined
}

function defaultFormContent(schema: unknown): { content: Record<string, string | number | boolean | string[]>; missingRequired: string[] } {
  const content: Record<string, string | number | boolean | string[]> = {}
  if (!isRecord(schema) || !isRecord(schema.properties)) return { content, missingRequired: [] }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!isRecord(propSchema) || !Object.prototype.hasOwnProperty.call(propSchema, 'default')) continue
    const value = primitiveElicitationValue(propSchema.default)
    if (value !== undefined) content[key] = value
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  const missingRequired = required.filter(key => !(key in content))
  return { content, missingRequired }
}

export async function defaultElicitationHandler({ params }: McpElicitationHandlerInput): Promise<ElicitResult> {
  if (params.mode === 'url') {
    return { action: 'decline' }
  }
  const { content, missingRequired } = defaultFormContent(params.requestedSchema)
  if (missingRequired.length > 0) {
    return { action: 'decline' }
  }
  return { action: 'accept', content }
}

type RequestHandlerExtraLike = {
  signal?: AbortSignal
  taskRequestedTtl?: number
  taskStore?: {
    createTask(taskParams: { ttl?: number | null }): Promise<{ taskId: string }>
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void>
  }
}

async function maybeTaskResult(taskRequested: boolean, extra: RequestHandlerExtraLike, result: Result): Promise<Result | { task: unknown }> {
  if (!taskRequested) return result
  if (!extra.taskStore) return result
  const task = await extra.taskStore.createTask({ ttl: extra.taskRequestedTtl })
  await extra.taskStore.storeTaskResult(task.taskId, 'completed', result)
  return { task }
}

function clientCapabilities(opts: LoadMcpToolsOptions): ClientCapabilities {
  const capabilities: ClientCapabilities = {
    elicitation: { form: { applyDefaults: true }, url: {} },
    tasks: {
      list: {},
      cancel: {},
      requests: {
        elicitation: { create: {} },
      },
    },
  }
  if (opts.samplingHandler) {
    capabilities.sampling = {}
    capabilities.tasks = {
      ...capabilities.tasks,
      requests: {
        ...capabilities.tasks?.requests,
        sampling: { createMessage: {} },
      },
    }
  }
  return capabilities
}

function createClient(serverName: string, opts: LoadMcpToolsOptions): { client: Client; taskStore: InMemoryTaskStore } {
  const taskStore = new InMemoryTaskStore()
  const client = new Client(
    { name: 'billiards-ts-harness', version: '0.0.0' },
    { capabilities: clientCapabilities(opts), taskStore },
  )

  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const handler = opts.elicitationHandler ?? defaultElicitationHandler
    const result = await handler({ serverName, params: request.params, signal: extra.signal })
    return maybeTaskResult(!!request.params.task, extra, result as Result) as never
  })

  if (opts.samplingHandler) {
    client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
      const result = await opts.samplingHandler!({ serverName, params: request.params, signal: extra.signal })
      return maybeTaskResult(!!request.params.task, extra, result as Result) as never
    })
  }

  return { client, taskStore }
}

async function listAllTools(client: Client, opts: LoadMcpToolsOptions): Promise<SdkMcpTool[]> {
  const tools: SdkMcpTool[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { signal: opts.signal, timeout: opts.timeoutMs ?? 10000 })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
  } catch {
    return tools
  }
  return tools
}

async function listAllResources(client: Client, opts: LoadMcpToolsOptions): Promise<SdkMcpResource[]> {
  const resources: SdkMcpResource[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await client.listResources(cursor ? { cursor } : undefined, { signal: opts.signal, timeout: opts.timeoutMs ?? 10000 })
      resources.push(...page.resources)
      cursor = page.nextCursor
    } while (cursor)
  } catch {
    return resources
  }
  return resources
}

async function listAllResourceTemplates(client: Client, opts: LoadMcpToolsOptions): Promise<SdkMcpResourceTemplate[]> {
  const resourceTemplates: SdkMcpResourceTemplate[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, { signal: opts.signal, timeout: opts.timeoutMs ?? 10000 })
      resourceTemplates.push(...page.resourceTemplates)
      cursor = page.nextCursor
    } while (cursor)
  } catch {
    return resourceTemplates
  }
  return resourceTemplates
}

async function listAllPrompts(client: Client, opts: LoadMcpToolsOptions): Promise<SdkMcpPrompt[]> {
  const prompts: SdkMcpPrompt[] = []
  let cursor: string | undefined
  try {
    do {
      const page = await client.listPrompts(cursor ? { cursor } : undefined, { signal: opts.signal, timeout: opts.timeoutMs ?? 10000 })
      prompts.push(...page.prompts)
      cursor = page.nextCursor
    } while (cursor)
  } catch {
    return prompts
  }
  return prompts
}

function createTransport(config: McpServerConfig, opts: LoadMcpToolsOptions): Transport {
  if (config.transport === 'stdio') {
    const cmd = commandForPlatform(config)
    if (!cmd.command) throw new Error(`MCP stdio server ${config.name} missing command`)
    return new StdioClientTransport({
      command: cmd.command,
      args: cmd.args,
      cwd: opts.cwd,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
      stderr: 'pipe',
    })
  }
  if (config.transport === 'http') {
    if (!config.url) throw new Error(`MCP http server ${config.name} missing url`)
    // 对齐 cc(services/mcp/client.ts:826-836 HTTP 分支):自定义 headers(含 Authorization: Bearer)
    // 经 requestInit.headers 传给 transport,SDK 在每次请求时把它 spread 在自动头之后,用户头优先。
    // cc 还接了 authProvider(完整 OAuth,src/services/mcp/auth.ts ~2465 行)——本项目未移植,超出本次范围。
    return new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: opts.fetchImpl,
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    })
  }
  throw new Error(`unsupported MCP transport for ${config.name}`)
}

function callArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function taskTraceLine(kind: 'created' | 'status', task: { taskId: string; status: string; statusMessage?: string; pollInterval?: number }): string {
  const attrs = [
    `event="${kind}"`,
    `id="${attr(task.taskId)}"`,
    `status="${attr(task.status)}"`,
    task.statusMessage ? `message="${attr(task.statusMessage)}"` : '',
    typeof task.pollInterval === 'number' ? `pollInterval="${task.pollInterval}"` : '',
  ].filter(Boolean).join(' ')
  return `<mcp_task ${attrs} />`
}

function progressTraceLine(progress: { progress: number; total?: number; message?: string }): string {
  const attrs = [
    `progress="${progress.progress}"`,
    typeof progress.total === 'number' ? `total="${progress.total}"` : '',
    progress.message ? `message="${attr(progress.message)}"` : '',
  ].filter(Boolean).join(' ')
  return `<mcp_progress ${attrs} />`
}

function supportsToolTasks(client: Client): boolean {
  return !!client.getServerCapabilities()?.tasks?.requests?.tools?.call
}

function taskUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('does not support task creation') || message.includes('task augmentation')
}

async function executeMcpTool(
  serverName: string,
  sdkTool: SdkMcpTool,
  client: Client,
  input: unknown,
  opts: LoadMcpToolsOptions,
  signal?: AbortSignal,
): Promise<string> {
  const params = { name: sdkTool.name, arguments: callArgs(input) }
  const trace: string[] = []
  const requestOptions = {
    signal: signal ?? opts.signal,
    timeout: opts.toolTimeoutMs ?? 120000,
    resetTimeoutOnProgress: true,
    onprogress(progress: { progress: number; total?: number; message?: string }) {
      trace.push(progressTraceLine(progress))
    },
  }

  const taskSupport = sdkTool.execution?.taskSupport
  const shouldUseTaskStream = supportsToolTasks(client) && (taskSupport === 'required' || taskSupport === 'optional')
  if (shouldUseTaskStream) {
    try {
      let finalResult: CallToolResult | undefined
      const stream = client.experimental.tasks.callToolStream(params, CallToolResultSchema, {
        ...requestOptions,
        task: { ttl: opts.taskTtlMs ?? 300000 },
      })
      for await (const message of stream) {
        if (message.type === 'taskCreated') {
          trace.push(taskTraceLine('created', message.task))
        } else if (message.type === 'taskStatus') {
          trace.push(taskTraceLine('status', message.task))
        } else if (message.type === 'result') {
          finalResult = message.result
        } else if (message.type === 'error') {
          throw message.error
        }
      }
      if (!finalResult) throw new Error(`MCP task tool ${sdkTool.name} finished without a result`)
      return formatMcpResult(serverName, sdkTool.name, finalResult, trace)
    } catch (err) {
      if (taskSupport === 'optional' && taskUnsupportedError(err)) {
        const result = await client.callTool(params, undefined, requestOptions)
        return formatMcpResult(serverName, sdkTool.name, result, trace)
      }
      throw err
    }
  }

  if (taskSupport === 'required') {
    throw new Error(`MCP tool ${sdkTool.name} requires task-based execution, but server did not advertise tools/call task support`)
  }
  const result = await client.callTool(params, undefined, requestOptions)
  return formatMcpResult(serverName, sdkTool.name, result, trace)
}

function makeTool(serverName: string, sdkTool: SdkMcpTool, client: Client, publicName: string, opts: LoadMcpToolsOptions): Tool {
  const approvalClass = approvalClassFromAnnotations(sdkTool.annotations)
  // readOnlyHint 只驱动 isReadOnly(plan 模式可探索 + 并发安全),不影响审批:外部 MCP 工具一律要审批。
  const readOnly = !!sdkTool.annotations?.readOnlyHint && !sdkTool.annotations.destructiveHint && !sdkTool.annotations.openWorldHint
  return {
    name: publicName,
    description: [
      `MCP tool from server "${serverName}": ${sdkTool.description ?? sdkTool.title ?? sdkTool.name}`,
      `Original tool name: ${sdkTool.name}`,
    ].join('\n'),
    inputSchema: schemaFor(sdkTool),
    isReadOnly: readOnly,
    requiresApproval: true,
    approvalClass,
    async execute(input, ctx) {
      return executeMcpTool(serverName, sdkTool, client, input, opts, ctx.signal)
    },
  }
}

function formatResourceList(connections: McpConnection[]): string {
  const parts: string[] = []
  for (const connection of connections) {
    if (connection.resources.length === 0 && connection.resourceTemplates.length === 0) continue
    parts.push(`<mcp_resources server="${attr(connection.serverName)}">`)
    for (const resource of connection.resources) {
      const detail = [
        `uri=${resource.uri}`,
        `name=${resource.name}`,
        resource.mimeType ? `mimeType=${resource.mimeType}` : '',
        typeof resource.size === 'number' ? `size=${resource.size}` : '',
      ].filter(Boolean).join(' ')
      parts.push(`- ${detail}${resource.description ? `\n  ${resource.description}` : ''}`)
    }
    for (const template of connection.resourceTemplates) {
      const detail = [
        `uriTemplate=${template.uriTemplate}`,
        `name=${template.name}`,
        template.mimeType ? `mimeType=${template.mimeType}` : '',
      ].filter(Boolean).join(' ')
      parts.push(`- template ${detail}${template.description ? `\n  ${template.description}` : ''}`)
    }
    parts.push('</mcp_resources>')
  }
  return parts.length > 0 ? parts.join('\n') : '当前 MCP 连接没有暴露 resources。'
}

function formatPromptList(connections: McpConnection[]): string {
  const parts: string[] = []
  for (const connection of connections) {
    if (connection.prompts.length === 0) continue
    parts.push(`<mcp_prompts server="${attr(connection.serverName)}">`)
    for (const prompt of connection.prompts) {
      const args = prompt.arguments?.length
        ? ` args=${prompt.arguments.map(arg => `${arg.name}${arg.required ? '*' : ''}`).join(',')}`
        : ''
      parts.push(`- name=${prompt.name}${args}${prompt.description ? `\n  ${prompt.description}` : ''}`)
    }
    parts.push('</mcp_prompts>')
  }
  return parts.length > 0 ? parts.join('\n') : '当前 MCP 连接没有暴露 prompts。'
}

function matchingResourceConnections(connections: McpConnection[], serverName: string | undefined, uri: string): McpConnection[] {
  if (serverName) return connections.filter(connection => connection.serverName === serverName)
  const exact = connections.filter(connection => connection.resources.some(resource => resource.uri === uri))
  return exact.length > 0 ? exact : connections.filter(connection => connection.resources.length > 0 || connection.resourceTemplates.length > 0)
}

function matchingPromptConnections(connections: McpConnection[], serverName: string | undefined, name: string): McpConnection[] {
  if (serverName) return connections.filter(connection => connection.serverName === serverName)
  return connections.filter(connection => connection.prompts.some(prompt => prompt.name === name))
}

function promptArguments(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue
    out[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return out
}

function makeMcpCapabilityTools(connections: McpConnection[], opts: LoadMcpToolsOptions): Tool[] {
  const tools: Tool[] = []
  const hasResources = connections.some(connection => connection.resources.length > 0 || connection.resourceTemplates.length > 0)
  const hasPrompts = connections.some(connection => connection.prompts.length > 0)

  if (hasResources) {
    tools.push({
      name: 'list_mcp_resources',
      description: 'List readable resources and resource templates exposed by connected MCP servers. Input: {}.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        return formatResourceList(connections)
      },
    })
    tools.push({
      name: 'read_mcp_resource',
      description: 'Read a resource from a connected MCP server. Input: { uri, serverName? }. Use serverName when more than one server can read the URI.',
      inputSchema: {
        type: 'object',
        properties: {
          uri: { type: 'string' },
          serverName: { type: 'string' },
        },
        required: ['uri'],
      },
      isReadOnly: true,
      async execute(input, ctx) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new Error('read_mcp_resource 需要 string 参数 uri')
        }
        const args = input as Record<string, unknown>
        if (typeof args.uri !== 'string' || !args.uri.trim()) throw new Error('read_mcp_resource 需要 string 参数 uri')
        const serverName = typeof args.serverName === 'string' && args.serverName.trim() ? args.serverName.trim() : undefined
        const uri = args.uri.trim()
        const candidates = matchingResourceConnections(connections, serverName, uri)
        if (candidates.length === 0) return `没有找到可读取 resource 的 MCP server${serverName ? `:${serverName}` : ''}。`
        const errors: string[] = []
        for (const connection of candidates) {
          try {
            const result = await connection.client.readResource({ uri }, { signal: ctx.signal ?? opts.signal, timeout: opts.timeoutMs ?? 60000 })
            return [
              `<mcp_resource_result server="${attr(connection.serverName)}" uri="${attr(uri)}">`,
              ...result.contents.map(formatResourceContent),
              '</mcp_resource_result>',
            ].join('\n')
          } catch (err) {
            errors.push(`${connection.serverName}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return `MCP resource 读取失败:\n${errors.join('\n')}`
      },
    })
  }

  if (hasPrompts) {
    tools.push({
      name: 'list_mcp_prompts',
      description: 'List prompt templates exposed by connected MCP servers. Input: {}.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        return formatPromptList(connections)
      },
    })
    tools.push({
      name: 'read_mcp_prompt',
      description: 'Load one MCP prompt template. Input: { name, arguments?, serverName? }. Arguments should be a string map.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'object' },
          serverName: { type: 'string' },
        },
        required: ['name'],
      },
      isReadOnly: true,
      async execute(input, ctx) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new Error('read_mcp_prompt 需要 string 参数 name')
        }
        const args = input as Record<string, unknown>
        if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('read_mcp_prompt 需要 string 参数 name')
        const name = args.name.trim()
        const serverName = typeof args.serverName === 'string' && args.serverName.trim() ? args.serverName.trim() : undefined
        const candidates = matchingPromptConnections(connections, serverName, name)
        if (candidates.length === 0) return `没有找到 MCP prompt:${name}${serverName ? ` on ${serverName}` : ''}。`
        if (candidates.length > 1 && !serverName) {
          return `多个 MCP server 暴露了 prompt:${name};请带 serverName。可先调用 list_mcp_prompts 查看。`
        }
        const connection = candidates[0]!
        const result = await connection.client.getPrompt(
          { name, arguments: promptArguments(args.arguments) },
          { signal: ctx.signal ?? opts.signal, timeout: opts.timeoutMs ?? 60000 },
        )
        const body = result.messages.map(message => {
          return `<message role="${message.role}">\n${formatPromptContent(message.content)}\n</message>`
        }).join('\n')
        return `<mcp_prompt server="${attr(connection.serverName)}" name="${attr(name)}"${result.description ? ` description="${attr(result.description)}"` : ''}>\n${body}\n</mcp_prompt>`
      },
    })
  }

  return tools
}

export async function connectMcpServer(config: McpServerConfig, opts: LoadMcpToolsOptions = {}, usedNames = new Set<string>()): Promise<McpConnection> {
  const { client, taskStore } = createClient(config.name, opts)
  const transport = createTransport(config, opts)
  try {
    await client.connect(transport, { signal: opts.signal, timeout: opts.timeoutMs ?? 10000 })
    const [sdkTools, resources, resourceTemplates, prompts] = await Promise.all([
      listAllTools(client, opts),
      listAllResources(client, opts),
      listAllResourceTemplates(client, opts),
      listAllPrompts(client, opts),
    ])
    const tools = sdkTools.map(tool => makeTool(config.name, tool, client, uniqueName(mcpToolName(config.name, tool.name), usedNames), opts))
    return {
      serverName: config.name,
      client,
      transport,
      taskStore,
      tools,
      resources,
      resourceTemplates,
      prompts,
      close: async () => {
        try {
          await client.close()
        } finally {
          taskStore.cleanup()
        }
      },
    }
  } catch (err) {
    await client.close().catch(() => undefined)
    taskStore.cleanup()
    throw err
  }
}

export async function connectMcpServers(configs: McpServerConfig[], opts: LoadMcpToolsOptions = {}): Promise<LoadedMcpTools> {
  const usedNames = new Set<string>()
  const connections: McpConnection[] = []
  const warnings: string[] = []
  for (const config of configs.filter(config => !config.disabled)) {
    try {
      connections.push(await connectMcpServer(config, opts, usedNames))
    } catch (err) {
      warnings.push(`MCP server "${config.name}" unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { connections, tools: [...connections.flatMap(connection => connection.tools), ...makeMcpCapabilityTools(connections, opts)], warnings }
}

export async function loadMcpToolsFromFile(filePath: string | undefined, opts: LoadMcpToolsOptions = {}): Promise<LoadedMcpTools> {
  if (!filePath || !existsSync(filePath)) return { connections: [], tools: [], warnings: [] }
  try {
    return await connectMcpServers(await loadMcpConfigFile(filePath), opts)
  } catch (err) {
    return {
      connections: [],
      tools: [],
      warnings: [`MCP config unavailable: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

export async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map(connection => connection.close()))
}
