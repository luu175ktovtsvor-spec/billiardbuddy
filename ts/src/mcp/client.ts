import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { expandMcpServerConfig } from './envExpansion'
import { McpOAuthProvider } from './oauth'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport, type SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js'
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
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
import { pathToFileURL } from 'node:url'
import type { Tool, JSONSchema, ToolContext } from '../tools/Tool'
import type { ImageBlock } from '../types/message'
import { detectImageFormat, isVisionSupported, toImageBlock } from '../tools/imageRead'
import { approvalClassFromAnnotations, commandForPlatform, loadMcpConfigFile, mcpToolName, type McpServerConfig } from './config'
import { partiallySanitizeUnicode, recursivelySanitizeUnicode } from './sanitization'
import { persistMcpBinary } from './binaryStorage'

type SdkMcpResource = Awaited<ReturnType<Client['listResources']>>['resources'][number]
type SdkMcpResourceTemplate = Awaited<ReturnType<Client['listResourceTemplates']>>['resourceTemplates'][number]
type SdkMcpPrompt = Awaited<ReturnType<Client['listPrompts']>>['prompts'][number]
type SdkMcpPromptMessage = Awaited<ReturnType<Client['getPrompt']>>['messages'][number]
type SdkMcpResourceContent = Awaited<ReturnType<Client['readResource']>>['contents'][number]

export interface McpConnection {
  serverName: string
  /** server 自报 instructions(initialize 结果,2048 截断;对齐 cc 捕获后注入系统提示)。 */
  instructions?: string
  /** 初始连接的 client(向后兼容保留)。掉线重连后会换新 client——运行时取活连接一律走 getClient()。 */
  client: Client
  transport: Transport
  taskStore: InMemoryTaskStore
  /** 取当前活连接;掉线/会话过期后自动重连(新 session id),对齐 cc onclose 清缓存→下次调用重连。 */
  getClient(): Promise<Client>
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
  /** OAuth 宿主参数(config.oauth 启用的 server 用):凭据目录/浏览器拉起注入/回调超时;interactive:false = 无人值守禁交互授权。 */
  oauth?: { storageDir?: string; openAuthUrl?: (url: string) => void | Promise<void>; callbackTimeoutMs?: number; interactive?: boolean }
}

export interface LoadedMcpTools {
  connections: McpConnection[]
  tools: Tool[]
  warnings: string[]
  /** 各 server 自报 instructions(2048 截断/Unicode 净化),server 侧注入系统提示用(对齐 cc)。 */
  instructions: Array<{ server: string; text: string }>
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

/**
 * image/audio/resource-blob 内容块的落盘/视觉回灌路由上下文:label 用于落盘文件名前缀,
 * imageResultSink/toolResultStoreDir 直接来自当前工具执行的 ToolContext(见 executeMcpTool/
 * read_mcp_resource/read_mcp_prompt 的调用点)。
 */
interface McpBinaryRoute {
  imageResultSink?: ImageBlock[]
  toolResultStoreDir?: string
  label: string
}

async function persistAndDescribe(bytes: Buffer, mimeType: string | undefined, route: McpBinaryRoute, kind: string): Promise<string> {
  const persisted = await persistMcpBinary(bytes, mimeType, { toolResultStoreDir: route.toolResultStoreDir, label: route.label })
  if ('error' in persisted) {
    return `[${kind} mimeType=${mimeType ?? 'unknown'} bytes=${bytes.length} 落盘失败:${persisted.error}]`
  }
  return `[${kind} mimeType=${mimeType ?? 'unknown'} bytes=${bytes.length} 已落盘:${persisted.filepath}]`
}

// image 内容块:可视觉格式(png/jpeg/gif/webp)真解码后推进 ctx.imageResultSink(loop 组进 tool_result 的
// image 块,模型真看到图,对齐 cc transformMCPResult 的视觉回灌语义);无法识别为可视觉格式(如 svg/bmp)
// 或没有 sink(脱离 loop 单测)时落盘+文字引用,不把二进制整段塞进模型上下文。
// ⚠️遗留:cc 对超 vision 预算的图会用原生 sharp 缩放/降采样后再送;本仓库无原生图像库(同 read_file 的
// 已知取舍,见 tools/imageRead.ts 顶部说明),这里同样只把原图整个送入,不做降采样。
async function formatImageContentBlock(block: Extract<CallToolResult['content'][number], { type: 'image' }>, route: McpBinaryRoute): Promise<string> {
  const bytes = Buffer.from(block.data, 'base64')
  const detected = detectImageFormat(bytes)
  if (detected && isVisionSupported(detected) && route.imageResultSink) {
    route.imageResultSink.push(toImageBlock(bytes, detected))
    return `[image mimeType=${block.mimeType} bytes=${bytes.length} 已作为视觉内容发送给模型]`
  }
  return persistAndDescribe(bytes, block.mimeType, route, 'image')
}

// audio 内容块:本仓库无音频解码/播放通道,统一落盘 + 文字引用(对齐 cc transformMCPResult 对非图二进制
// 的处理),不把 base64 塞进上下文。
async function formatAudioContentBlock(block: Extract<CallToolResult['content'][number], { type: 'audio' }>, route: McpBinaryRoute): Promise<string> {
  const bytes = Buffer.from(block.data, 'base64')
  return persistAndDescribe(bytes, block.mimeType, route, 'audio')
}

async function formatContentBlock(block: CallToolResult['content'][number], route: McpBinaryRoute): Promise<string> {
  if (block.type === 'text') return block.text
  if (block.type === 'image') return formatImageContentBlock(block, route)
  if (block.type === 'audio') return formatAudioContentBlock(block, route)
  if (block.type === 'resource') {
    const resource = block.resource
    if ('text' in resource) return `<resource uri="${attr(resource.uri)}"${resource.mimeType ? ` mimeType="${attr(resource.mimeType)}"` : ''}>\n${resource.text}\n</resource>`
    const bytes = Buffer.from(resource.blob, 'base64')
    const mimeAttr = resource.mimeType ? ` mimeType="${attr(resource.mimeType)}"` : ''
    // 工具结果里 resource 包装的图片与顶层 image 块同权:可视觉格式且有 sink 就走视觉回灌
    // (对齐 cc client.ts:2515-2551 对 embedded-image-resource 的处理);否则落盘+引用。
    const detected = detectImageFormat(bytes)
    if (detected && isVisionSupported(detected) && route.imageResultSink) {
      route.imageResultSink.push(toImageBlock(bytes, detected))
      return `<resource uri="${attr(resource.uri)}"${mimeAttr} bytes="${bytes.length}" sentAsVision="true" />`
    }
    const persisted = await persistMcpBinary(bytes, resource.mimeType, { toolResultStoreDir: route.toolResultStoreDir, label: route.label })
    if ('error' in persisted) return `<resource uri="${attr(resource.uri)}"${mimeAttr} blobBytes="${bytes.length}" error="${attr(persisted.error)}" />`
    return `<resource uri="${attr(resource.uri)}"${mimeAttr} blobSavedTo="${attr(persisted.filepath)}" bytes="${bytes.length}" />`
  }
  if (block.type === 'resource_link') {
    return `<resource_link uri="${attr(block.uri)}" name="${attr(block.name)}"${block.mimeType ? ` mimeType="${attr(block.mimeType)}"` : ''} />`
  }
  return formatUnknown(block)
}

type CallToolLikeResult = CallToolResult | Awaited<ReturnType<Client['callTool']>>

// resource 直读(read_mcp_resource 工具,对齐 cc ReadMcpResourceTool):blob 一律解码落盘 + 回保存路径,
// 不管 mime 是不是图片——这是"按 URI 显式拉取一份资源"的场景,不是 tool 调用结果里的视觉回灌,故不接
// imageResultSink(route 不带它)。
async function formatResourceContent(content: SdkMcpResourceContent, route: McpBinaryRoute): Promise<string> {
  if ('text' in content) {
    return `<resource uri="${attr(content.uri)}"${content.mimeType ? ` mimeType="${attr(content.mimeType)}"` : ''}>\n${content.text}\n</resource>`
  }
  const bytes = Buffer.from(content.blob, 'base64')
  const persisted = await persistMcpBinary(bytes, content.mimeType, { toolResultStoreDir: route.toolResultStoreDir, label: route.label })
  const mimeAttr = content.mimeType ? ` mimeType="${attr(content.mimeType)}"` : ''
  if ('error' in persisted) return `<resource uri="${attr(content.uri)}"${mimeAttr} blobBytes="${bytes.length}" error="${attr(persisted.error)}" />`
  return `<resource uri="${attr(content.uri)}"${mimeAttr} blobSavedTo="${attr(persisted.filepath)}" bytes="${bytes.length}" />`
}

// prompt 消息里的 image/audio 占位符维持原样(超出本轮范围:审计 #17 只要求"工具调用结果"里的 image/audio
// 接线,prompt 内容块是 getPrompt 的另一条读路径,留作已知遗留)。resource 分支复用 formatContentBlock,
// 因此 prompt 里内嵌的 resource blob 同样会落盘(免费获得,同一份实现)。
async function formatPromptContent(content: SdkMcpPromptMessage['content'], route: McpBinaryRoute): Promise<string> {
  if (content.type === 'text') return content.text
  if (content.type === 'image') return `[image mimeType=${content.mimeType} bytes=${content.data.length}]`
  if (content.type === 'audio') return `[audio mimeType=${content.mimeType} bytes=${content.data.length}]`
  if (content.type === 'resource') return formatContentBlock(content, route)
  if ('uri' in content && 'name' in content) {
    return `<resource_link uri="${attr(content.uri)}" name="${attr(content.name)}"${content.mimeType ? ` mimeType="${attr(content.mimeType)}"` : ''} />`
  }
  return formatUnknown(content)
}

// 净化点①(结果文本):工具调用结果的最终拼装文本在送给模型前统一做隐形 Unicode 净化(对齐审计要求的
// "结果文本进入模型前"路径;cc 本身只净化 tool/prompt 的名字与描述,这里额外覆盖结果文本是本仓库的加固,
// 防恶意 server 把攻击载荷藏进 content 而不是 tool 描述里)。
async function formatMcpResult(serverName: string, toolName: string, result: CallToolLikeResult, trace: string[] = [], route?: McpBinaryRoute): Promise<string> {
  const prefix = trace.length > 0
    ? `<mcp_task_trace server="${attr(serverName)}" tool="${attr(toolName)}">\n${trace.join('\n')}\n</mcp_task_trace>\n`
    : ''
  if ('toolResult' in result) {
    return partiallySanitizeUnicode(`${prefix}<mcp_result server="${attr(serverName)}" tool="${attr(toolName)}">\n${formatUnknown(result.toolResult)}\n</mcp_result>`)
  }
  const contentRoute = route ?? { label: `${serverName}-${toolName}` }
  const parts = await Promise.all(result.content.map(block => formatContentBlock(block, contentRoute)))
  if (result.structuredContent) {
    parts.push(`<structured_content>\n${formatUnknown(result.structuredContent)}\n</structured_content>`)
  }
  return partiallySanitizeUnicode(prefix + [
    `<mcp_result server="${attr(serverName)}" tool="${attr(toolName)}"${result.isError ? ' isError="true"' : ''}>`,
    ...parts,
    '</mcp_result>',
  ].join('\n'))
}

function schemaFor(tool: SdkMcpTool): JSONSchema {
  return tool.inputSchema as JSONSchema
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  // 撞名时保留完整 base 只追加后缀(对齐 cc 不截断口径;此前按 64 上限截 base 会让长名工具互相踩)。
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`
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

/** MCP 文本上限(对齐 cc MAX_MCP_DESCRIPTION_LENGTH=2048):工具描述/server instructions 超长截断,防上下文膨胀与提示注入面。 */
export const MAX_MCP_TEXT_LENGTH = 2048
export function truncateMcpText(text: string): string {
  return text.length <= MAX_MCP_TEXT_LENGTH ? text : `${text.slice(0, MAX_MCP_TEXT_LENGTH)}…[截断]`
}

export function clientCapabilities(opts: LoadMcpToolsOptions): ClientCapabilities {
  const capabilities: ClientCapabilities = {
    // roots 能力(对齐 cc client.ts:988-990):声明后注册 ListRoots handler 返回工作区根的 file:// URI,
    // 让文件系统类 server 知道该在哪个目录下工作。
    roots: {},
    // 空对象即声明 elicitation 能力,足以让服务器发起表单/URL 征询,本地处理器仍
    // 会补默认值。绝不发送 { form:{}, url:{} } 嵌套形状——老式 Java/Spring MCP
    // 服务器的 Elicitation 类零字段且拒绝未知嵌套属性,带上 form/url 会打回它们。
    elicitation: {},
    // tasks 是 top-level 能力字段:老服务器的 ClientCapabilities 以
    // @JsonIgnoreProperties(ignoreUnknown=true) 忽略未知顶层字段,不会因此打回,
    // 故按完整形状声明(降为 {} 反而会关掉任务增强请求),不随 elicitation 一起降。
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

  // ListRoots(对齐 cc client.ts:1003-1012):回工作区根的 file:// URI,文件系统类 server 据此定位工作目录。
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: opts.cwd ? [{ uri: pathToFileURL(opts.cwd).href, name: 'workspace' }] : [],
  }))

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

/**
 * 每请求超时 + Accept 保底(对齐 cc wrapFetchWithTimeout,client.ts:489-547):POST/初始化 60s 硬超时防挂死;
 * 严格 server 缺 Accept 会 406,兜底带上 json+SSE 双类型。SSE 长连 GET **不**经此包装(不能掐持续事件流)。
 */
export function wrapFetchWithTimeoutAndAccept(base?: FetchLike, timeoutMs = 60_000): FetchLike {
  const f: FetchLike = base ?? ((url, init) => fetch(url as never, init as never))
  return (url, init) => {
    // SDK 传 Headers 实例:必须用 Headers 合并,对象展开会丢掉 Content-Type 等既有头(会 415)。
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0] | undefined)
    if (!headers.has('accept')) headers.set('accept', 'application/json, text/event-stream')
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal as AbortSignal, timeoutSignal]) : timeoutSignal
    return f(url, { ...init, headers, signal })
  }
}

export function createTransport(rawConfig: McpServerConfig, opts: LoadMcpToolsOptions, authProvider?: McpOAuthProvider): Transport {
  // ${VAR}/${VAR:-default} 展开(对齐 cc envExpansion + 官方 .mcp.json 契约):在"真的要连"的时刻做,
  // 缺变量抛错指名道姓,别把 "${MY_TOKEN}" 当字面量发出去让鉴权静默失效。
  const config = expandMcpServerConfig(rawConfig)
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
  if (config.transport === 'sse') {
    if (!config.url) throw new Error(`MCP sse server ${config.name} missing url`)
    // 对齐 cc(services/mcp/client.ts:616-673 SSE 分支):旧式 SSE 传输 = 长连 GET 收事件 + 独立 POST 回发。
    // 自定义 headers(含 Authorization: Bearer)要同时挂到:
    //  ① requestInit.headers —— 回发用的 POST 请求;
    //  ② eventSourceInit.fetch —— 建立并保持 SSE 长连的初始 GET;必须自带 fetch 显式带上头,因为设了
    //     eventSourceInit 后 SDK 不会再自动附 Authorization(见 SSEClientTransportOptions.eventSourceInit 注释),
    //     且 SSE 长连不能套 http 那种 60s 请求超时(会掐断持续事件流)。
    const transportOptions: SSEClientTransportOptions = {
      // SSE 的回发 POST 走这里:套 60s 超时 + Accept 保底(长连 GET 在 eventSourceInit,不套超时)。
      fetch: wrapFetchWithTimeoutAndAccept(opts.fetchImpl),
      ...(authProvider ? { authProvider } : {}),
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    }
    if (config.headers) {
      const headers = config.headers
      const baseFetch = opts.fetchImpl ?? ((url: string | URL, init?: RequestInit) => fetch(url, init))
      transportOptions.eventSourceInit = {
        fetch: (url, init) => baseFetch(url, {
          ...init,
          headers: { ...(init?.headers as Record<string, string> | undefined), ...headers, Accept: 'text/event-stream' },
        }),
      }
    }
    return new SSEClientTransport(new URL(config.url), transportOptions)
  }
  if (config.transport === 'http') {
    if (!config.url) throw new Error(`MCP http server ${config.name} missing url`)
    // 对齐 cc(services/mcp/client.ts:826-836 HTTP 分支):自定义 headers(含 Authorization: Bearer)
    // 经 requestInit.headers 传给 transport,SDK 在每次请求时把它 spread 在自动头之后,用户头优先。
    // cc 还接了 authProvider(完整 OAuth,src/services/mcp/auth.ts ~2465 行)——本项目未移植,超出本次范围。
    return new StreamableHTTPClientTransport(new URL(config.url), {
      // 每请求 60s 超时 + Accept 保底(对齐 cc):初始化/调用 POST 不再可能无限挂死。
      fetch: wrapFetchWithTimeoutAndAccept(opts.fetchImpl),
      ...(authProvider ? { authProvider } : {}),
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

// 工具执行超时默认值:对齐 cc(client.ts:211,224-229)——真值近乎无限(~27.8h),真正的中断靠 AbortSignal
// (用户取消 / 循环 abort),不是靠超时掐断。2 分钟硬顶会误杀长任务型 MCP 工具(慢速爬虫、长跑批处理、
// 等人工审批的工具等),这类工具该交给用户主动取消,而不是被框架自作主张判定"卡死"。
// 可用 QF_MCP_TOOL_TIMEOUT(毫秒)覆盖,便于按需收紧或测试注入短超时。显式传入的 opts.toolTimeoutMs
// 优先级更高(向后兼容既有调用方)。
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 100_000_000

export function mcpToolTimeoutMs(): number {
  const raw = Number.parseInt(process.env.QF_MCP_TOOL_TIMEOUT ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_TOOL_TIMEOUT_MS
}

async function executeMcpTool(
  serverName: string,
  sdkTool: SdkMcpTool,
  client: Client,
  input: unknown,
  opts: LoadMcpToolsOptions,
  ctx: Pick<ToolContext, 'imageResultSink' | 'toolResultStoreDir'>,
  signal?: AbortSignal,
): Promise<string> {
  const params = { name: sdkTool.name, arguments: callArgs(input) }
  const trace: string[] = []
  const requestOptions = {
    signal: signal ?? opts.signal,
    timeout: opts.toolTimeoutMs ?? mcpToolTimeoutMs(),
    resetTimeoutOnProgress: true,
    onprogress(progress: { progress: number; total?: number; message?: string }) {
      trace.push(progressTraceLine(progress))
    },
  }
  const route: McpBinaryRoute = {
    imageResultSink: ctx.imageResultSink,
    toolResultStoreDir: ctx.toolResultStoreDir,
    label: `${serverName}-${sdkTool.name}`,
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
      return await formatMcpResult(serverName, sdkTool.name, finalResult, trace, route)
    } catch (err) {
      if (taskSupport === 'optional' && taskUnsupportedError(err)) {
        const result = await client.callTool(params, undefined, requestOptions)
        return await formatMcpResult(serverName, sdkTool.name, result, trace, route)
      }
      throw err
    }
  }

  if (taskSupport === 'required') {
    throw new Error(`MCP tool ${sdkTool.name} requires task-based execution, but server did not advertise tools/call task support`)
  }
  const result = await client.callTool(params, undefined, requestOptions)
  return await formatMcpResult(serverName, sdkTool.name, result, trace, route)
}

function makeTool(serverName: string, sdkTool: SdkMcpTool, clientSource: Pick<McpConnectionSupervisor, 'getClient'>, publicName: string, opts: LoadMcpToolsOptions): Tool {
  const approvalClass = approvalClassFromAnnotations(sdkTool.annotations)
  // readOnlyHint 只驱动 isReadOnly(plan 模式可探索 + 并发安全),不影响审批:外部 MCP 工具一律要审批。
  const readOnly = !!sdkTool.annotations?.readOnlyHint && !sdkTool.annotations.destructiveHint && !sdkTool.annotations.openWorldHint
  return {
    name: publicName,
    description: [
      // 2048 截断(对齐 cc MAX_MCP_DESCRIPTION_LENGTH):外部 server 自报文本,防上下文膨胀/提示注入面。
      truncateMcpText(`MCP tool from server "${serverName}": ${sdkTool.description ?? sdkTool.title ?? sdkTool.name}`),
      `Original tool name: ${sdkTool.name}`,
    ].join('\n'),
    inputSchema: schemaFor(sdkTool),
    isReadOnly: readOnly,
    requiresApproval: true,
    approvalClass,
    async execute(input, ctx) {
      // 经监督器取活连接:掉线后这里自动重连(新 session),不再对着死 client 挂死(对齐 cc 重连语义:
      // 在飞调用被 reject 失败回灌模型,下一次调用重连——不自动重试失败的那次)。
      const client = await clientSource.getClient()
      return executeMcpTool(serverName, sdkTool, client, input, opts, ctx, ctx.signal)
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
        return partiallySanitizeUnicode(formatResourceList(connections))
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
            const result = await (await connection.getClient()).readResource({ uri }, { signal: ctx.signal ?? opts.signal, timeout: opts.timeoutMs ?? 60000 })
            const route: McpBinaryRoute = { toolResultStoreDir: ctx.toolResultStoreDir, label: `resource-${connection.serverName}` }
            const contents = await Promise.all(result.contents.map(content => formatResourceContent(content, route)))
            return partiallySanitizeUnicode([
              `<mcp_resource_result server="${attr(connection.serverName)}" uri="${attr(uri)}">`,
              ...contents,
              '</mcp_resource_result>',
            ].join('\n'))
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
        return partiallySanitizeUnicode(formatPromptList(connections))
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
        const result = await (await connection.getClient()).getPrompt(
          { name, arguments: promptArguments(args.arguments) },
          { signal: ctx.signal ?? opts.signal, timeout: opts.timeoutMs ?? 60000 },
        )
        const route: McpBinaryRoute = { toolResultStoreDir: ctx.toolResultStoreDir, label: `prompt-${connection.serverName}-${name}` }
        const body = (await Promise.all(result.messages.map(async message => {
          return `<message role="${message.role}">\n${await formatPromptContent(message.content, route)}\n</message>`
        }))).join('\n')
        return partiallySanitizeUnicode(`<mcp_prompt server="${attr(connection.serverName)}" name="${attr(name)}"${result.description ? ` description="${attr(result.description)}"` : ''}>\n${body}\n</mcp_prompt>`)
      },
    })
  }

  return tools
}

/**
 * 会话过期判定(逐字对齐 cc client.ts:193-206 isMcpSessionExpiredError):HTTP 404 + JSON-RPC -32001。
 * 两个信号都查,避免把普通 404(URL 错/服务器没了)误判成会话过期。
 */
export function isMcpSessionExpiredError(error: Error): boolean {
  const httpStatus = 'code' in error ? (error as Error & { code?: number }).code : undefined
  if (httpStatus !== 404) return false
  return error.message.includes('"code":-32001') || error.message.includes('"code": -32001')
}

/** 终端连接错误判定(对齐 cc client.ts:1243-1257):这些错误意味着连接实质已死,不是瞬时抖动。 */
export function isTerminalConnectionError(msg: string): boolean {
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EPIPE') ||
    msg.includes('EHOSTUNREACH') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('Body Timeout Error') ||
    msg.includes('terminated') ||
    // SDK SSE 重连中间态错误可能把真实网络错误包一层,上面的子串匹配不到
    msg.includes('SSE stream disconnected') ||
    msg.includes('Failed to reconnect SSE stream')
  )
}

/** 连接监督器:掉线检测 + 挂起调用拒绝 + 惰性重连(对齐 cc client.ts:1210-1396 的 onerror/onclose 包装)。 */
interface McpConnectionSupervisor {
  getClient(): Promise<Client>
  current(): { client: Client; transport: Transport; taskStore: InMemoryTaskStore } | null
  close(): Promise<void>
}

const MAX_ERRORS_BEFORE_RECONNECT = 3

function createMcpConnectionSupervisor(config: McpServerConfig, opts: LoadMcpToolsOptions): McpConnectionSupervisor {
  let current: { client: Client; transport: Transport; taskStore: InMemoryTaskStore } | null = null
  let connecting: Promise<Client> | null = null
  let closedForGood = false

  const attachDropHandlers = (client: Client, taskStore: InMemoryTaskStore) => {
    const transportType = config.transport ?? 'stdio'
    let consecutiveConnectionErrors = 0
    // 防重入(对齐 cc hasTriggeredClose):close() 会中止在飞流,可能在关闭链完成前再触发 onerror。
    let hasTriggeredClose = false
    // client.close() → transport.close() → SDK _onclose():把所有挂起请求 reject(-32000 Connection
    // closed,挂死的 callTool 才会失败),再走下面的 onclose 清连接缓存。直接调 onclose 只清缓存、
    // 挂起调用会一直吊着——必须走 close()(对齐 cc closeTransportAndRejectPending 注释)。
    const closeTransportAndRejectPending = () => {
      if (hasTriggeredClose) return
      hasTriggeredClose = true
      void client.close().catch(() => undefined)
    }
    const originalOnError = client.onerror
    client.onerror = (error: Error) => {
      // HTTP 会话过期(404+-32001)→ 关传输拒绝挂起调用,下次调用带新 session id 重连(对齐 cc 1307-1323)。
      if (transportType === 'http' && isMcpSessionExpiredError(error)) {
        closeTransportAndRejectPending()
        originalOnError?.(error)
        return
      }
      // 远程传输(sse/http):SDK 自带 SSE 重连耗尽是"传输放弃"的确定信号;终端错误连着来 3 次也判死。
      if (transportType === 'sse' || transportType === 'http') {
        if (error.message.includes('Maximum reconnection attempts')) {
          closeTransportAndRejectPending()
          originalOnError?.(error)
          return
        }
        if (isTerminalConnectionError(error.message)) {
          consecutiveConnectionErrors++
          if (consecutiveConnectionErrors >= MAX_ERRORS_BEFORE_RECONNECT) {
            consecutiveConnectionErrors = 0
            closeTransportAndRejectPending()
          }
        } else {
          consecutiveConnectionErrors = 0
        }
      }
      originalOnError?.(error)
    }
    const originalOnClose = client.onclose
    client.onclose = () => {
      // 清连接缓存(对齐 cc onclose 清 memo cache):下次 getClient() 走重连。stdio 子进程崩溃也走这里。
      if (current?.client === client) {
        current = null
        taskStore.cleanup()
      }
      originalOnClose?.()
    }
  }

  // OAuth provider(config.oauth 启用的远程 server):一个 server 一个实例,跨重连持有令牌/注册信息。
  const authProvider = config.oauth && config.transport !== 'stdio'
    ? new McpOAuthProvider({
        serverName: config.name,
        scopes: config.oauth.scopes,
        clientName: config.oauth.clientName,
        storageDir: opts.oauth?.storageDir,
        openAuthUrl: opts.oauth?.openAuthUrl,
        callbackTimeoutMs: opts.oauth?.callbackTimeoutMs,
      })
    : undefined

  const isUnauthorized = (err: unknown): boolean =>
    err instanceof UnauthorizedError || (err instanceof Error && /unauthorized/i.test(err.name + ' ' + err.message))

  const tryConnect = async (): Promise<Client> => {
    const { client, taskStore } = createClient(config.name, opts)
    const transport = createTransport(config, opts, authProvider)
    try {
      await client.connect(transport, { signal: opts.signal, timeout: opts.timeoutMs ?? 10000 })
    } catch (err) {
      await client.close().catch(() => undefined)
      taskStore.cleanup()
      throw err
    }
    current = { client, transport, taskStore }
    attachDropHandlers(client, taskStore)
    return client
  }

  const connect = async (): Promise<Client> => {
    // 无 OAuth / 已有令牌:直连(令牌由 SDK transport 自动附带,过期自动刷新)。
    if (!authProvider) return tryConnect()
    // 授权环(对齐 cc performMCPOAuthFlow 的行为语义,机制走 SDK auth()):
    // ① 无令牌先备好本地回调端口(redirect_uris 须在动态注册前就绪);② 连接触发 SDK 授权流
    //    (发现→注册→PKCE→redirectToAuthorization 拉浏览器)后抛 Unauthorized;③ 等回调 code →
    //    finishAuth 换令牌落盘;④ 重连。令牌失效(refresh 也救不回)= step-up:作废旧令牌重走一轮。
    const needInteractiveUpfront = !authProvider.hasTokens()
    if (needInteractiveUpfront && opts.oauth?.interactive === false) {
      throw new Error(`MCP server ${config.name}: 需要 OAuth 授权,但当前为无人值守上下文(interactive:false),请先在前台会话完成授权`)
    }
    if (needInteractiveUpfront) await authProvider.prepareInteractive()
    try {
      return await tryConnect()
    } catch (err) {
      if (!isUnauthorized(err)) {
        authProvider.closeCallback()
        throw err
      }
      if (opts.oauth?.interactive === false) {
        authProvider.closeCallback()
        throw new Error(`MCP server ${config.name}: 令牌无效且无人值守上下文无法交互授权(${err instanceof Error ? err.message : String(err)})`)
      }
      try {
        if (!needInteractiveUpfront) {
          // step-up:带着旧令牌被打回——作废令牌、起回调、再触发一次授权流(这次会拉浏览器)。
          authProvider.invalidateCredentials('tokens')
          await authProvider.prepareInteractive()
          try {
            return await tryConnect()
          } catch (err2) {
            if (!isUnauthorized(err2)) throw err2
          }
        }
        const code = await authProvider.waitForAuthorizationCode()
        const finisher = createTransport(config, opts, authProvider) as Transport & { finishAuth(code: string): Promise<void> }
        try {
          await finisher.finishAuth(code)
        } finally {
          void finisher.close?.().catch(() => undefined)
        }
        return await tryConnect()
      } finally {
        authProvider.closeCallback()
      }
    } finally {
      // 直连成功(令牌本就有效)时,若曾预开回调端口,及时释放。
      if (needInteractiveUpfront) authProvider.closeCallback()
    }
  }

  return {
    async getClient(): Promise<Client> {
      if (closedForGood) throw new Error(`MCP server ${config.name}: connection closed`)
      if (current) return current.client
      // 单飞重连:并发工具调用共享同一次重连,不制造连接风暴。
      connecting ??= connect().finally(() => { connecting = null })
      return await connecting
    },
    current(): { client: Client; transport: Transport; taskStore: InMemoryTaskStore } | null {
      return current
    },
    async close(): Promise<void> {
      closedForGood = true
      const held = current
      current = null
      if (held) {
        try {
          await held.client.close()
        } finally {
          held.taskStore.cleanup()
        }
      }
    },
  }
}

export async function connectMcpServer(config: McpServerConfig, opts: LoadMcpToolsOptions = {}, usedNames = new Set<string>()): Promise<McpConnection> {
  const supervisor = createMcpConnectionSupervisor(config, opts)
  const client = await supervisor.getClient()
  const initial = supervisor.current()!
  const { transport, taskStore } = initial
  try {
    const [rawTools, rawResources, rawResourceTemplates, rawPrompts] = await Promise.all([
      listAllTools(client, opts),
      listAllResources(client, opts),
      listAllResourceTemplates(client, opts),
      listAllPrompts(client, opts),
    ])
    // 净化点②(工具名/描述等元信息):MCP server 是不可信输入源,在这里(拿到数据的第一时间、任何下游
    // 消费之前)统一做隐形 Unicode 净化,对齐 cc 对 tools/prompts 的做法(client.ts:1752,2044),并把
    // 同一处理扩到 resources/resourceTemplates(cc 未做,本仓库额外加固)。净化后的对象后续被原样转发/
    // 回传给 server(如 tool.name 用于 callTool、prompt.name 用于 getPrompt)——这与 cc 完全一致的取舍:
    // 净化只影响"极端场景下不可见字符恰好是合法标识符一部分"这种理论上几乎不会发生的情况。
    const sdkTools = recursivelySanitizeUnicode(rawTools)
    const resources = recursivelySanitizeUnicode(rawResources)
    const resourceTemplates = recursivelySanitizeUnicode(rawResourceTemplates)
    const prompts = recursivelySanitizeUnicode(rawPrompts)
    // 工具绑定监督器而非固定 client:掉线后挂起调用被拒绝(-32000),下一次调用经 getClient() 自动重连。
    const tools = sdkTools.map(tool => makeTool(config.name, tool, supervisor, uniqueName(mcpToolName(config.name, tool.name), usedNames), opts))
    return {
      serverName: config.name,
      // server instructions(对齐 cc client.ts:1151-1165):initialize 自报的使用说明,2048 截断后供系统提示注入。
      instructions: (() => {
        const text = client.getInstructions?.()
        return typeof text === 'string' && text.trim() ? truncateMcpText(recursivelySanitizeUnicode(text.trim())) : undefined
      })(),
      client,
      transport,
      taskStore,
      getClient: () => supervisor.getClient(),
      tools,
      resources,
      resourceTemplates,
      prompts,
      close: () => supervisor.close(),
    }
  } catch (err) {
    await supervisor.close().catch(() => undefined)
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
  return {
    connections,
    tools: [...connections.flatMap(connection => connection.tools), ...makeMcpCapabilityTools(connections, opts)],
    warnings,
    // 汇总各 server instructions(已截断/净化),供 server 侧注入系统提示(对齐 cc "MCP Server Instructions")。
    instructions: connections.flatMap(c => (c.instructions ? [{ server: c.serverName, text: c.instructions }] : [])),
  }
}

export async function loadMcpToolsFromFile(filePath: string | undefined, opts: LoadMcpToolsOptions = {}): Promise<LoadedMcpTools> {
  if (!filePath || !existsSync(filePath)) return { connections: [], tools: [], warnings: [], instructions: [] }
  try {
    return await connectMcpServers(await loadMcpConfigFile(filePath), opts)
  } catch (err) {
    return {
      connections: [],
      tools: [],
      warnings: [`MCP config unavailable: ${err instanceof Error ? err.message : String(err)}`],
      instructions: [],
    }
  }
}

/** 合并应用配置和已启用插件的多个 MCP 配置；单个扩展失败只贡献警告，不拖垮整轮。 */
export async function loadMcpToolsFromFiles(filePaths: Array<string | undefined>, opts: LoadMcpToolsOptions = {}): Promise<LoadedMcpTools> {
  const results = await Promise.all(filePaths.filter((path): path is string => !!path && existsSync(path)).map(async path => {
    try {
      return { configs: await loadMcpConfigFile(path), warning: undefined }
    } catch (err) {
      return { configs: [] as McpServerConfig[], warning: `MCP config unavailable: ${err instanceof Error ? err.message : String(err)}` }
    }
  }))
  const configsByName = new Map<string, McpServerConfig>()
  for (const result of results) {
    for (const config of result.configs) if (!configsByName.has(config.name)) configsByName.set(config.name, config)
  }
  const loaded = await connectMcpServers([...configsByName.values()], opts)
  loaded.warnings.unshift(...results.flatMap(result => result.warning ? [result.warning] : []))
  return loaded
}

export async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
  await Promise.allSettled(connections.map(connection => connection.close()))
}
