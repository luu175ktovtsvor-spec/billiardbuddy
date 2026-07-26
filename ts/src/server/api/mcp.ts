import { inspectMcpHostCommand } from '../services/mcpHostPreflight.js'
import { ApiError } from '../middleware/errorHandler.js'
import { connectProductMcpServer } from '../agent-worker/productMcpClient.js'
import {
  beginProductMcpAuthorization,
  deleteProductMcpOAuthCredential,
  productMcpAuthorizationStatus,
} from '../agent-worker/productMcpOAuth.js'
import {
  loadProductMcpConfigs,
  parseProductMcpServerConfig,
  removeProductMcpServer,
  replaceProductMcpServer,
  saveProductMcpServer,
  setProductMcpEnabled,
  type ProductMcpScope,
  type ProductMcpServerConfig,
  type ScopedProductMcpServerConfig,
} from '../agent-worker/productMcpConfig.js'

type McpServerDto = {
  name: string
  scope: ProductMcpScope
  transport: 'stdio' | 'http' | 'sse'
  enabled: boolean
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'checking'
  canEdit: true
  canRemove: true
  canReconnect: boolean
  canAuthorize: boolean
  canToggle: true
}

function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  return req.json().then(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  }).catch(() => { throw ApiError.badRequest('Invalid JSON body') })
}

function cwdFor(url: URL, body?: Record<string, unknown>): string {
  const value = url.searchParams.get('cwd') || (typeof body?.cwd === 'string' ? body.cwd : '')
  return value || process.cwd()
}

function scopeOf(value: unknown): ProductMcpScope {
  if (value === 'user' || value === 'project' || value === 'local') return value
  throw new ApiError(400, 'Invalid MCP scope', 'MCP_CONFIGURATION_INVALID')
}

function taskId(body?: Record<string, unknown>): string | undefined {
  if (!body || !Object.hasOwn(body, 'taskId')) return undefined
  if (typeof body.taskId === 'string' && body.taskId.trim()) return body.taskId.trim()
  throw new ApiError(503, 'Product task is unavailable', 'PRODUCT_TASK_UNAVAILABLE')
}

function dto(name: string, config: ScopedProductMcpServerConfig, enabled: boolean, status: McpServerDto['status'] = enabled ? 'checking' : 'disabled'): McpServerDto {
  return {
    name,
    scope: config.scope,
    transport: config.type ?? 'stdio',
    enabled,
    status,
    canEdit: true,
    canRemove: true,
    canReconnect: enabled,
    canAuthorize: enabled && (config.type === 'http' || config.type === 'sse') && Boolean(config.oauth),
    canToggle: true,
  }
}

async function preflight(config: ProductMcpServerConfig, cwd: string): Promise<boolean> {
  if ((config.type ?? 'stdio') !== 'stdio') return true
  const local = config as Extract<ProductMcpServerConfig, { command: string }>
  return (await inspectMcpHostCommand(local.command, cwd, local.env)).ok
}

async function liveStatus(name: string, config: ScopedProductMcpServerConfig, cwd: string, enabled: boolean): Promise<McpServerDto> {
  if (!enabled) return dto(name, config, false, 'disabled')
  if (!await preflight(config, cwd)) return dto(name, config, true, 'failed')
  const result = await connectProductMcpServer(name, config)
  await result.client.cleanup?.().catch(() => undefined)
  return dto(name, config, true, result.client.type === 'connected' ? 'connected' : result.client.type === 'needs-auth' ? 'needs-auth' : 'failed')
}

function configError(error: unknown): Response {
  const requested = error instanceof ApiError ? error.code : error instanceof Error ? error.message : ''
  const status = error instanceof ApiError ? error.statusCode : requested === 'MCP_NAME_CONFLICT' ? 409 : 400
  const code = requested === 'PRODUCT_TASK_UNAVAILABLE'
    ? 'PRODUCT_TASK_UNAVAILABLE'
    : requested === 'MCP_NAME_CONFLICT'
      ? 'MCP_NAME_CONFLICT'
      : requested === 'MCP_NOT_AVAILABLE'
        ? 'MCP_NOT_AVAILABLE'
        : requested === 'MCP_HOST_UNAVAILABLE'
          ? 'MCP_HOST_UNAVAILABLE'
          : requested === 'MCP_REQUEST_INVALID' || status === 405
            ? 'MCP_REQUEST_INVALID'
            : 'MCP_CONFIGURATION_INVALID'
  return Response.json({ error: code }, { status })
}

export async function handleMcpApi(req: Request, url: URL, segments: string[]): Promise<Response> {
  try {
    const name = segments[2] ? decodeURIComponent(segments[2]) : undefined
    const action = segments[3]
    const body = req.method === 'POST' || req.method === 'PUT' ? await parseJsonBody(req) : undefined
    const cwd = cwdFor(url, body)

    if (req.method === 'GET' && !name) {
      const snapshot = await loadProductMcpConfigs(cwd)
      return Response.json({ servers: Object.entries(snapshot.servers).sort(([a], [b]) => a.localeCompare(b)).map(([serverName, config]) => dto(serverName, config, !snapshot.disabled.has(serverName))) })
    }
    if (req.method === 'GET' && name && action === 'status') {
      const snapshot = await loadProductMcpConfigs(cwd)
      const config = snapshot.servers[name]
      if (!config) throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
      return Response.json({ server: await liveStatus(name, config, cwd, !snapshot.disabled.has(name)) })
    }
    if (req.method === 'POST' && !name) {
      const serverName = typeof body?.name === 'string' ? body.name.trim() : ''
      const scope = scopeOf(body?.scope)
      const config = parseProductMcpServerConfig(body?.config)
      if (!await preflight(config, cwd)) throw new ApiError(400, 'MCP host unavailable', 'MCP_HOST_UNAVAILABLE')
      await saveProductMcpServer(serverName, config, scope, cwd)
      return Response.json({ server: dto(serverName, { ...config, scope }, true) }, { status: 201 })
    }
    if (req.method === 'PUT' && name && !action) {
      const previousCwd = typeof body?.previousCwd === 'string' && body.previousCwd ? body.previousCwd : cwd
      const previous = (await loadProductMcpConfigs(previousCwd)).servers[name]
      if (!previous) throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
      const scope = scopeOf(body?.scope ?? previous.scope)
      const config = parseProductMcpServerConfig(body?.config)
      if (!await preflight(config, cwd)) throw new ApiError(400, 'MCP host unavailable', 'MCP_HOST_UNAVAILABLE')
      await deleteProductMcpOAuthCredential(name, previous).catch(() => undefined)
      if (previousCwd === cwd) await replaceProductMcpServer(name, config, scope, previous.scope, cwd)
      else {
        await removeProductMcpServer(name, previous.scope, previousCwd)
        await saveProductMcpServer(name, config, scope, cwd)
      }
      return Response.json({ server: dto(name, { ...config, scope }, true) })
    }
    if (req.method === 'DELETE' && name && !action) {
      const scope = scopeOf(url.searchParams.get('scope'))
      const existing = (await loadProductMcpConfigs(cwd)).servers[name]
      if (existing) await deleteProductMcpOAuthCredential(name, existing).catch(() => undefined)
      await removeProductMcpServer(name, scope, cwd)
      return Response.json({ ok: true })
    }
    if (req.method === 'POST' && name && action === 'toggle') {
      const currentTask = taskId(body)
      const snapshot = await loadProductMcpConfigs(cwd)
      const config = snapshot.servers[name]
      if (!config) throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
      const enabled = snapshot.disabled.has(name)
      await setProductMcpEnabled(name, enabled, cwd)
      return Response.json({ server: dto(name, config, enabled), ...(currentTask ? { taskSync: { applied: false, reason: 'next_turn' } } : {}) })
    }
    if (req.method === 'POST' && name && action === 'reconnect') {
      const snapshot = await loadProductMcpConfigs(cwd)
      const config = snapshot.servers[name]
      if (!config) throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
      return Response.json({ server: await liveStatus(name, config, cwd, !snapshot.disabled.has(name)) })
    }
    if (req.method === 'POST' && name && action === 'authorize') {
      const snapshot = await loadProductMcpConfigs(cwd)
      const config = snapshot.servers[name]
      if (!config) throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
      if (snapshot.disabled.has(name)) throw new ApiError(400, 'MCP server is disabled', 'MCP_OAUTH_NOT_CONFIGURED')
      return Response.json(await beginProductMcpAuthorization(name, config))
    }
    if (req.method === 'GET' && name && action === 'authorization-status') {
      const flowId = url.searchParams.get('flowId')
      if (!flowId) throw new ApiError(400, 'MCP authorization flow is invalid', 'MCP_OAUTH_FLOW_NOT_FOUND')
      return Response.json(productMcpAuthorizationStatus(name, flowId))
    }
    throw new ApiError(405, 'Unsupported MCP request', 'MCP_REQUEST_INVALID')
  } catch (error) {
    return configError(error)
  }
}
