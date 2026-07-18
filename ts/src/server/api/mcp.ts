import {
  clearMcpClientConfig,
  clearServerTokensFromLocalStorage,
} from '../../services/mcp/auth.js'
import {
  clearServerCache,
  connectToServer,
  reconnectMcpServerImpl,
} from '../../services/mcp/client.js'
import {
  addMcpConfig,
  getAllMcpConfigs,
  getClaudeCodeMcpConfigs,
  getMcpConfigByName,
  isMcpServerDisabled,
  removeMcpConfig,
  setMcpServerEnabled,
} from '../../services/mcp/config.js'
import { inspectMcpHostCommand } from '../services/mcpHostPreflight.js'
import type {
  ConfigScope,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { ensureConfigScope } from '../../services/mcp/utils.js'
import { enableConfigs } from '../../utils/config.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import { ApiError } from '../middleware/errorHandler.js'
import { conversationService } from '../services/conversationService.js'

type McpServerDto = {
  name: string
  scope: string
  transport: string
  enabled: boolean
  status: 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'checking'
  canEdit: boolean
  canRemove: boolean
  canReconnect: boolean
  canToggle: boolean
}

type McpMutationBody = {
  cwd?: string
  previousCwd?: string
  scope?: string
  sessionId?: string
  config?: unknown
}

type McpSessionSyncDto = {
  applied: boolean
  reason?: 'not_running' | 'failed'
}

const EDITABLE_SCOPES = new Set<ConfigScope>(['local', 'project', 'user'])

function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  return req
    .json()
    .then((body) => body as Record<string, unknown>)
    .catch(() => {
      throw ApiError.badRequest('Invalid JSON body')
    })
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function syncMcpToggleToSession(
  sessionId: string | undefined,
  serverName: string,
  enabled: boolean,
): Promise<McpSessionSyncDto | undefined> {
  if (!sessionId) return undefined
  if (!conversationService.hasSession(sessionId)) {
    return { applied: false, reason: 'not_running' }
  }

  try {
    await conversationService.requestControl(
      sessionId,
      { subtype: 'mcp_toggle', serverName, enabled },
      120_000,
    )
    return { applied: true }
  } catch {
    return {
      applied: false,
      reason: 'failed',
    }
  }
}

function resolveRequestCwd(url: URL, body?: Record<string, unknown>): string {
  const cwd = url.searchParams.get('cwd') || (typeof body?.cwd === 'string' ? body.cwd : undefined)
  return cwd || getCwd()
}

function stripScope(config: ScopedMcpServerConfig): McpServerConfig {
  const { scope: _scope, pluginSource: _pluginSource, ...rest } = config
  return rest
}

function isVisibleServer(name: string, config: ScopedMcpServerConfig): boolean {
  if (name === 'ide') return false
  if (config.type === 'sse-ide' || config.type === 'ws-ide') return false
  return true
}

function getInitialStatus(
  enabled: boolean,
): Pick<McpServerDto, 'status'> {
  if (!enabled) {
    return { status: 'disabled' }
  }

  return { status: 'checking' }
}

async function getHostPreflightStatus(
  config: ScopedMcpServerConfig | McpServerConfig,
  enabled: boolean,
): Promise<Pick<McpServerDto, 'status'> | null> {
  if (!enabled) {
    return null
  }

  if ((config.type ?? 'stdio') !== 'stdio') {
    return null
  }

  const stdioConfig = config as McpStdioServerConfig
  const result = await inspectMcpHostCommand(
    stdioConfig.command,
    getCwd(),
    stdioConfig.env,
  )
  if (result.ok) {
    return null
  }

  return { status: 'failed' }
}

async function inspectServerStatus(
  name: string,
  config: ScopedMcpServerConfig,
  enabled: boolean,
): Promise<Pick<McpServerDto, 'status'>> {
  if (!enabled) {
    return { status: 'disabled' }
  }

  const hostPreflightStatus = await getHostPreflightStatus(config, enabled)
  if (hostPreflightStatus) {
    return hostPreflightStatus
  }

  try {
    const client = await connectToServer(name, config)
    await clearServerCache(name, config).catch(() => {})

    const status: McpServerDto['status'] =
      client.type === 'connected'
        ? 'connected'
        : client.type === 'needs-auth'
          ? 'needs-auth'
          : 'failed'

    return { status }
  } catch {
    await clearServerCache(name, config).catch(() => {})
    return { status: 'failed' }
  }
}

function buildServerDto(
  name: string,
  config: ScopedMcpServerConfig,
  status: Pick<McpServerDto, 'status'>,
): McpServerDto {
  const enabled = !isMcpServerDisabled(name)
  const transport = config.type ?? 'stdio'
  const canEdit = EDITABLE_SCOPES.has(config.scope) && (transport === 'stdio' || transport === 'http' || transport === 'sse')

  return {
    name,
    scope: config.scope,
    transport,
    enabled: !isMcpServerDisabled(name),
    status: status.status,
    canEdit,
    canRemove: EDITABLE_SCOPES.has(config.scope),
    canReconnect: enabled,
    canToggle: true,
  }
}

function serializeServerSnapshot(
  name: string,
  config: ScopedMcpServerConfig,
): McpServerDto {
  return buildServerDto(name, config, getInitialStatus(!isMcpServerDisabled(name)))
}

async function serializeServerWithLiveStatus(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<McpServerDto> {
  const enabled = !isMcpServerDisabled(name)
  const status = await inspectServerStatus(name, config, enabled)
  return buildServerDto(name, config, status)
}

async function resolveServerForRuntimeAction(
  name: string,
): Promise<ScopedMcpServerConfig | null> {
  const configured = getMcpConfigByName(name)
  if (configured) {
    return configured
  }

  const { servers } = await getAllMcpConfigs()
  return servers[name] ?? null
}

function buildServerConfig(config: unknown): McpServerConfig {
  if (!config || typeof config !== 'object') {
    throw ApiError.badRequest('Missing or invalid "config" in request body')
  }

  const raw = config as Record<string, unknown>
  const type = raw.type

  if (!type || type === 'stdio') {
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (!command) {
      throw ApiError.badRequest('Command is required for stdio MCP servers')
    }

    const args = Array.isArray(raw.args)
      ? raw.args.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []

    const envEntries = raw.env && typeof raw.env === 'object'
      ? Object.entries(raw.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0].trim().length > 0,
        )
      : []

    return {
      type: 'stdio',
      command,
      args,
      ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
    }
  }

  if (type === 'http' || type === 'sse') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (!url) {
      throw ApiError.badRequest('URL is required for remote MCP servers')
    }

    const headersEntries = raw.headers && typeof raw.headers === 'object'
      ? Object.entries(raw.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0].trim().length > 0,
        )
      : []

    const oauthRaw = raw.oauth && typeof raw.oauth === 'object' ? (raw.oauth as Record<string, unknown>) : undefined
    const clientId = typeof oauthRaw?.clientId === 'string' ? oauthRaw.clientId.trim() : ''
    const callbackPort =
      typeof oauthRaw?.callbackPort === 'number'
        ? oauthRaw.callbackPort
        : typeof oauthRaw?.callbackPort === 'string' && oauthRaw.callbackPort.trim()
          ? Number(oauthRaw.callbackPort)
          : undefined

    return {
      type,
      url,
      ...(headersEntries.length > 0 ? { headers: Object.fromEntries(headersEntries) } : {}),
      ...(typeof raw.headersHelper === 'string' && raw.headersHelper.trim()
        ? { headersHelper: raw.headersHelper.trim() }
        : {}),
      ...(clientId || callbackPort
        ? {
            oauth: {
              ...(clientId ? { clientId } : {}),
              ...(callbackPort ? { callbackPort } : {}),
            },
          }
        : {}),
    }
  }

  throw ApiError.badRequest(`Unsupported MCP transport: ${String(type)}`)
}

function cleanupSecureStorage(name: string, config: ScopedMcpServerConfig) {
  if (config.type !== 'sse' && config.type !== 'http') return
  clearServerTokensFromLocalStorage(name, config)
  clearMcpClientConfig(name, config)
}

async function listServers(): Promise<Response> {
  const { servers } = await getAllMcpConfigs()
  const visibleServers = Object.entries(servers)
    .filter(([name, config]) => isVisibleServer(name, config))
    .sort((a, b) => a[0].localeCompare(b[0]))
  return Response.json({
    servers: visibleServers.map(([name, config]) => serializeServerSnapshot(name, config)),
  })
}

async function getServerStatus(name: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
  }

  return Response.json({
    server: await serializeServerWithLiveStatus(name, existing),
  })
}

async function assertHostPrerequisites(config: McpServerConfig) {
  const hostPreflightStatus = await getHostPreflightStatus(config, true)
  if (hostPreflightStatus) {
    throw new ApiError(400, 'MCP host is unavailable', 'MCP_HOST_UNAVAILABLE')
  }
}

async function createServer(body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    throw ApiError.badRequest('Missing or invalid "name" in request body')
  }

  const scope = ensureConfigScope(typeof body.scope === 'string' ? body.scope : undefined)
  const config = buildServerConfig(body.config)
  await assertHostPrerequisites(config)

  try {
    await addMcpConfig(name, config, scope)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already exists')) {
      throw new ApiError(409, 'MCP server already exists', 'MCP_NAME_CONFLICT')
    }
    throw new ApiError(400, 'MCP configuration is invalid', 'MCP_CONFIGURATION_INVALID')
  }

  const created = getMcpConfigByName(name)
  if (!created) {
    throw new ApiError(500, 'MCP server could not be reloaded', 'MCP_MUTATION_FAILED')
  }

  return Response.json({ server: serializeServerSnapshot(name, created) }, { status: 201 })
}

async function updateServer(name: string, body: Record<string, unknown>): Promise<Response> {
  const targetCwd = getCwd()
  const previousCwd = optionalString(body.previousCwd)
  const previousLookupCwd = previousCwd ?? targetCwd
  const existing = runWithCwdOverride(previousLookupCwd, () => getMcpConfigByName(name))
  if (!existing) {
    throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
  }

  if (!EDITABLE_SCOPES.has(existing.scope)) {
    throw new ApiError(400, 'MCP server cannot be changed here', 'MCP_CONFIGURATION_LOCKED')
  }

  const nextScope = ensureConfigScope(typeof body.scope === 'string' ? body.scope : existing.scope)
  const nextConfig = buildServerConfig(body.config)
  await assertHostPrerequisites(nextConfig)
  const previousConfig = stripScope(existing)
  const previousScope = existing.scope

  try {
    await runWithCwdOverride(previousLookupCwd, () => removeMcpConfig(name, previousScope))
    await addMcpConfig(name, nextConfig, nextScope)
  } catch (error) {
    try {
      const restored = runWithCwdOverride(previousLookupCwd, () => getMcpConfigByName(name))
      if (!restored) {
        await runWithCwdOverride(previousLookupCwd, () => addMcpConfig(name, previousConfig, previousScope))
      }
    } catch {
      // Preserve the original update error below.
    }

    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already exists')) {
      throw new ApiError(409, 'MCP server already exists', 'MCP_NAME_CONFLICT')
    }
    throw new ApiError(400, 'MCP configuration is invalid', 'MCP_CONFIGURATION_INVALID')
  }

  const updated = getMcpConfigByName(name)
  if (!updated) {
    throw new ApiError(500, 'MCP server could not be reloaded', 'MCP_MUTATION_FAILED')
  }

  return Response.json({ server: serializeServerSnapshot(name, updated) })
}

async function deleteServer(name: string, url: URL): Promise<Response> {
  const scope = ensureConfigScope(url.searchParams.get('scope') || undefined)
  const existing = getMcpConfigByName(name)
  if (!existing) {
    throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
  }

  await removeMcpConfig(name, scope)
  cleanupSecureStorage(name, existing)
  await clearServerCache(name, existing).catch(() => {})

  return Response.json({ ok: true })
}

async function toggleServer(name: string, sessionId?: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
  }

  const enabled = isMcpServerDisabled(name)
  setMcpServerEnabled(name, enabled)
  const sessionSync = await syncMcpToggleToSession(sessionId, name, enabled)

  if (!enabled) {
    await clearServerCache(name, existing).catch(() => {})
    const updated = serializeServerSnapshot(name, existing)
    return Response.json({ server: updated, ...(sessionSync ? { sessionSync } : {}) })
  }

  const hostPreflightStatus = await getHostPreflightStatus(existing, true)
  if (hostPreflightStatus) {
    await clearServerCache(name, existing).catch(() => {})
    return Response.json({
      server: buildServerDto(name, existing, hostPreflightStatus),
    })
  }

  await reconnectMcpServerImpl(name, existing)
  await clearServerCache(name, existing).catch(() => {})

  const updated = await serializeServerWithLiveStatus(name, existing)
  return Response.json({
    server: updated,
    ...(sessionSync ? { sessionSync } : {}),
  })
}

async function reconnectServer(name: string): Promise<Response> {
  const existing = await resolveServerForRuntimeAction(name)
  if (!existing) {
    throw new ApiError(404, 'MCP server is unavailable', 'MCP_NOT_AVAILABLE')
  }

  const hostPreflightStatus = await getHostPreflightStatus(existing, !isMcpServerDisabled(name))
  if (hostPreflightStatus) {
    await clearServerCache(name, existing).catch(() => {})
    return Response.json({
      server: buildServerDto(name, existing, hostPreflightStatus),
    })
  }

  await reconnectMcpServerImpl(name, existing)
  await clearServerCache(name, existing).catch(() => {})

  const server = await serializeServerWithLiveStatus(name, existing)
  return Response.json({ server })
}

function mcpErrorResponse(error: unknown): Response {
  const status = error instanceof ApiError ? error.statusCode : 500
  const requestedCode = error instanceof ApiError ? error.code : undefined
  const code =
    requestedCode === 'MCP_NOT_AVAILABLE' || requestedCode === 'MCP_NAME_CONFLICT'
      ? requestedCode
      : requestedCode === 'MCP_HOST_UNAVAILABLE' || requestedCode === 'MCP_CONFIGURATION_LOCKED'
        ? requestedCode
        : requestedCode === 'MCP_REQUEST_INVALID' || status === 405
          ? 'MCP_REQUEST_INVALID'
          : requestedCode === 'MCP_CONFIGURATION_INVALID' || status === 400
            ? 'MCP_CONFIGURATION_INVALID'
            : 'MCP_UNAVAILABLE'

  return Response.json({ error: code }, { status })
}

export async function handleMcpApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    enableConfigs()

    const serverName = segments[2] ? decodeURIComponent(segments[2]) : undefined
    const action = segments[3]
    const body =
      req.method === 'POST' || req.method === 'PUT'
        ? await parseJsonBody(req)
        : undefined

    return await runWithCwdOverride(resolveRequestCwd(url, body), async () => {
      if (req.method === 'GET' && !serverName) {
        return listServers()
      }

      if (req.method === 'GET' && serverName && action === 'status') {
        return getServerStatus(serverName)
      }

      if (req.method === 'POST' && !serverName) {
        return createServer(body ?? {})
      }

      if (req.method === 'PUT' && serverName) {
        return updateServer(serverName, body ?? {})
      }

      if (req.method === 'DELETE' && serverName && !action) {
        return deleteServer(serverName, url)
      }

      if (req.method === 'POST' && serverName && action === 'toggle') {
        return toggleServer(serverName, optionalString(body?.sessionId))
      }

      if (req.method === 'POST' && serverName && action === 'reconnect') {
        return reconnectServer(serverName)
      }

      throw new ApiError(405, 'Unsupported MCP request', 'MCP_REQUEST_INVALID')
    })
  } catch (error) {
    return mcpErrorResponse(error)
  }
}
