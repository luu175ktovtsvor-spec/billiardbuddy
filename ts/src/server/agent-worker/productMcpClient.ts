import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import type { ScopedProductMcpServerConfig } from './productMcpConfig.js'
import { productSubprocessEnvironment } from './productSubprocessEnvironment.js'
import { productMcpOAuthProvider } from './productMcpOAuth.js'
import { resolveProductMcpHeaders } from './productMcpHeaders.js'
import { buildProductTool, type ProductCommand, type ProductContentBlock, type ProductTool } from './productTool.js'

const MAX_DESCRIPTION_CHARS = 2_048
const MAX_RESULT_CHARS = 1_000_000
const TOOL_TIMEOUT_MS = 120_000

export type ProductMcpConnection = {
  name: string
  type: 'connected' | 'failed' | 'needs-auth' | 'disabled'
  config: ScopedProductMcpServerConfig
  client?: Client
  cleanup?: () => Promise<void>
}

export type ProductMcpResource = {
  server: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export type ProductMcpConnectionResult = {
  client: ProductMcpConnection
  tools: ProductTool[]
  commands: ProductCommand[]
  resources?: ProductMcpResource[]
}

function normalizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 96) || 'unnamed'
}

async function transportFor(serverName: string, config: ScopedProductMcpServerConfig) {
  if ((config.type ?? 'stdio') === 'stdio') {
    const stdio = config as Extract<ScopedProductMcpServerConfig, { command: string }>
    return new StdioClientTransport({
      command: stdio.command,
      args: stdio.args ?? [],
      env: productSubprocessEnvironment(stdio.env),
      stderr: 'pipe',
    })
  }
  const remote = config as Extract<ScopedProductMcpServerConfig, { url: string }>
  const headers = await resolveProductMcpHeaders(remote.headers, remote.headersHelper)
  const requestInit = { headers: { 'User-Agent': 'BilliardBuddy', ...headers } }
  const authProvider = remote.oauth ? productMcpOAuthProvider(serverName, remote) : undefined
  return remote.type === 'sse'
    ? new SSEClientTransport(new URL(remote.url), { requestInit, ...(authProvider ? { authProvider } : {}) })
    : new StreamableHTTPClientTransport(new URL(remote.url), { requestInit, ...(authProvider ? { authProvider } : {}) })
}

function resultBlocks(result: Awaited<ReturnType<Client['callTool']>>): ProductContentBlock[] {
  const output: ProductContentBlock[] = []
  for (const raw of Array.isArray(result.content) ? result.content : []) {
    if (raw.type === 'text') output.push({ type: 'text', text: raw.text.slice(0, MAX_RESULT_CHARS) })
    else if (raw.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(raw.mimeType) && raw.data.length <= MAX_RESULT_CHARS * 2) {
      output.push({ type: 'image', media_type: raw.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: raw.data })
    } else if (raw.type === 'resource' || raw.type === 'resource_link') {
      output.push({ type: 'text', text: JSON.stringify(raw).slice(0, MAX_RESULT_CHARS) })
    }
  }
  if (result.structuredContent) output.push({ type: 'text', text: JSON.stringify(result.structuredContent).slice(0, MAX_RESULT_CHARS) })
  return output.length ? output : [{ type: 'text', text: '(MCP tool returned no content)' }]
}

function createProductMcpTool(server: string, client: Client, definition: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean } }): ProductTool {
  const schema = z.object({}).passthrough()
  return buildProductTool({
    name: `mcp__${normalizeName(server)}__${normalizeName(definition.name)}`,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: definition.name },
    maxResultSizeChars: MAX_RESULT_CHARS,
    inputSchema: schema,
    inputJSONSchema: definition.inputSchema as never,
    async description() { return (definition.description || `MCP tool ${definition.name}`).slice(0, MAX_DESCRIPTION_CHARS) },
    async prompt() { return `Use the ${definition.name} capability provided by the ${server} MCP server.` },
    userFacingName() { return definition.name },
    isReadOnly() { return definition.annotations?.readOnlyHint === true },
    isDestructive() { return definition.annotations?.destructiveHint === true },
    isConcurrencySafe() { return false },
    isOpenWorld() { return definition.annotations?.openWorldHint !== false },
    toAutoClassifierInput(input) { return { server, tool: definition.name, input } },
    async call(args, context) {
      const result = await client.callTool(
        { name: definition.name, arguments: args },
        CallToolResultSchema,
        { signal: context.abortController.signal, timeout: TOOL_TIMEOUT_MS },
      )
      return { data: { blocks: resultBlocks(result), isError: result.isError === true } }
    },
    mapToolResultToToolResultBlockParam(result, toolUseID) {
      return { type: 'tool_result', tool_use_id: toolUseID, ...(result.isError ? { is_error: true } : {}), content: result.blocks }
    },
    renderToolUseMessage() { return null },
    renderToolUseProgressMessage() { return null },
    renderToolUseQueuedMessage() { return null },
    renderToolUseRejectedMessage() { return null },
    renderToolResultMessage() { return null },
    renderToolUseErrorMessage() { return null },
  })
}

function createProductMcpResourceTools(server: string, client: Client, listed: ProductMcpResource[], templates: unknown[]): ProductTool[] {
  const inputSchema = z.strictObject({ uri: z.string().min(1).max(8_192) })
  const catalogSchema = z.strictObject({})
  return [buildProductTool({
    name: `mcp__${normalizeName(server)}__list_resources`,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: 'resources/list' },
    maxResultSizeChars: MAX_RESULT_CHARS,
    inputSchema: catalogSchema,
    async description() { return `List the frozen resource and resource-template catalog from the ${server} MCP server.` },
    isReadOnly() { return true },
    isConcurrencySafe() { return true },
    isOpenWorld() { return true },
    toAutoClassifierInput() { return { server, operation: 'resources/list' } },
    async call() { return { data: JSON.stringify({ resources: listed, resourceTemplates: templates }).slice(0, MAX_RESULT_CHARS) } },
    mapToolResultToToolResultBlockParam(content, toolUseID) { return { type: 'tool_result', tool_use_id: toolUseID, content } },
  }), buildProductTool({
    name: `mcp__${normalizeName(server)}__read_resource`,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: 'resources/read' },
    maxResultSizeChars: MAX_RESULT_CHARS,
    inputSchema,
    async description() {
      const names = listed.slice(0, 64).map(resource => `${resource.name}: ${resource.uri}`).join('\n')
      return `Read one resource exposed by the ${server} MCP server.${names ? `\n${names}` : ''}`.slice(0, MAX_DESCRIPTION_CHARS)
    },
    isReadOnly() { return true },
    isOpenWorld() { return true },
    toAutoClassifierInput(input) { return { server, uri: input.uri } },
    async call({ uri }, context) {
      const result = await client.readResource({ uri }, { signal: context.abortController.signal, timeout: TOOL_TIMEOUT_MS })
      let used = 0
      const blocks: ProductContentBlock[] = result.contents.flatMap<ProductContentBlock>(content => {
        const remaining = MAX_RESULT_CHARS - used
        if (remaining <= 0) return []
        if ('text' in content && typeof content.text === 'string') {
          const text = content.text.slice(0, remaining)
          used += text.length
          return [{ type: 'text' as const, text }]
        }
        if ('blob' in content && typeof content.blob === 'string') {
          const mimeType = typeof content.mimeType === 'string' ? content.mimeType : 'application/octet-stream'
          if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType) && content.blob.length <= remaining * 2) {
            used += Math.ceil(content.blob.length / 2)
            return [{ type: 'image' as const, media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: content.blob }]
          }
          const text = `[binary MCP resource ${content.uri} (${mimeType})]\n${content.blob}`.slice(0, remaining)
          used += text.length
          return [{ type: 'text' as const, text }]
        }
        return []
      })
      return { data: blocks.length ? blocks : [{ type: 'text' as const, text: '(MCP resource returned no content)' }] }
    },
    mapToolResultToToolResultBlockParam(blocks, toolUseID) {
      return { type: 'tool_result', tool_use_id: toolUseID, content: blocks }
    },
  })]
}

async function promptCommands(server: string, client: Client): Promise<ProductCommand[]> {
  if (!client.getServerCapabilities()?.prompts) return []
  const listed = await client.listPrompts()
  return listed.prompts.map(prompt => ({
    type: 'prompt' as const,
    name: `mcp__${normalizeName(server)}__${normalizeName(prompt.name)}`,
    description: (prompt.description || `MCP prompt ${prompt.name}`).slice(0, MAX_DESCRIPTION_CHARS),
    source: 'mcp' as const,
    loadedFrom: 'mcp' as const,
    progressMessage: '正在加载 MCP Prompt',
    contentLength: 0,
    userInvocable: true,
    async getPromptForCommand(args: string) {
      let parsed: Record<string, string> = {}
      if (args.trim()) {
        try {
          const value = JSON.parse(args)
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error()
          parsed = value
        } catch { throw new Error('MCP_PROMPT_ARGUMENTS_INVALID') }
      }
      const result = await client.getPrompt({ name: prompt.name, arguments: parsed })
      return result.messages.flatMap<ProductContentBlock>(message => {
        const content = message.content
        if (content.type === 'text') return [{ type: 'text' as const, text: content.text }]
        if (content.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(content.mimeType)) {
          return [{ type: 'image' as const, media_type: content.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', data: content.data }]
        }
        return []
      })
    },
  }))
}

export async function connectProductMcpServer(name: string, config: ScopedProductMcpServerConfig): Promise<ProductMcpConnectionResult> {
  let transport: Awaited<ReturnType<typeof transportFor>>
  try { transport = await transportFor(name, config) } catch {
    return { client: { name, type: 'failed', config }, tools: [], commands: [] }
  }
  const client = new Client({ name: 'billiardbuddy', title: 'BilliardBuddy', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const capabilities = client.getServerCapabilities()
    const [listedTools, commands, listedResources, listedTemplates] = await Promise.all([
      capabilities?.tools ? client.listTools() : Promise.resolve({ tools: [] }),
      promptCommands(name, client),
      capabilities?.resources ? client.listResources() : Promise.resolve({ resources: [] }),
      capabilities?.resources ? client.listResourceTemplates().catch(() => ({ resourceTemplates: [] })) : Promise.resolve({ resourceTemplates: [] }),
    ])
    const resources = listedResources.resources.map(resource => ({
      server: name, uri: resource.uri, name: resource.name,
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    }))
    return {
      client: { name, type: 'connected', config, client, cleanup: () => client.close() },
      tools: [
        ...listedTools.tools.map(tool => createProductMcpTool(name, client, tool as never)),
        ...(capabilities?.resources ? createProductMcpResourceTools(name, client, resources, listedTemplates.resourceTemplates) : []),
      ],
      commands,
      resources,
    }
  } catch (error) {
    await client.close().catch(() => undefined)
    const needsAuth = error instanceof UnauthorizedError || (error instanceof Error && /401|unauthori[sz]ed|oauth/i.test(error.message))
    return { client: { name, type: needsAuth ? 'needs-auth' : 'failed', config }, tools: [], commands: [] }
  }
}
