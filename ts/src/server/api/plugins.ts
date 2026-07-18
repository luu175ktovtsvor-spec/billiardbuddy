import type { PluginScope } from '../../utils/plugins/schemas.js'
import { ApiError } from '../middleware/errorHandler.js'
import { PluginService } from '../services/pluginService.js'
import { conversationService } from '../services/conversationService.js'
import { updateSessionSlashCommands } from '../ws/handler.js'

const pluginService = new PluginService()

type PluginSessionReloadSummary = {
  applied: boolean
  reason?: 'not_running' | 'failed'
  commands: number
  agents: number
  plugins: number
  mcpServers: number
  errors: number
}

export async function handlePluginsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const method = req.method
    const sub = segments[2]
    const cwd = url.searchParams.get('cwd') || undefined

    if (method === 'GET' && !sub) {
      return Response.json(await pluginService.listPlugins(cwd))
    }

    if (method === 'GET' && sub === 'detail') {
      const pluginId = url.searchParams.get('id')
      if (!pluginId) {
        throw new ApiError(400, 'Invalid plugin request', 'PLUGIN_ACTION_INVALID')
      }
      return Response.json({
        detail: await pluginService.getPluginDetail(pluginId, cwd),
      })
    }

    if (method === 'POST' && sub === 'reload') {
      const sessionId = url.searchParams.get('sessionId') || undefined
      const response = await pluginService.reloadPlugins(cwd)
      if (!sessionId) {
        return Response.json(response)
      }

      return Response.json({
        ...response,
        session: await reloadSessionPlugins(sessionId),
      })
    }

    if (method === 'POST' && sub) {
      const body = await parseJsonBody(req)
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw new ApiError(400, 'Invalid plugin request', 'PLUGIN_ACTION_INVALID')
      }

      const scope = coerceScope(body.scope)

      switch (sub) {
        case 'enable':
          return Response.json(await pluginService.enablePlugin(pluginId, scope))
        case 'disable':
          return Response.json(await pluginService.disablePlugin(pluginId, scope))
        case 'update':
          return Response.json(
            await pluginService.updatePlugin(pluginId, scope as PluginScope | undefined),
          )
        case 'uninstall':
          return Response.json(
            await pluginService.uninstallPlugin(
              pluginId,
              scope,
              body.keepData === true,
            ),
          )
        default:
          throw new ApiError(404, 'Plugin endpoint not found', 'PLUGIN_NOT_FOUND')
      }
    }

    throw new ApiError(405, 'Plugin request is not supported', 'PLUGIN_ACTION_INVALID')
  } catch (error) {
    return pluginErrorResponse(error)
  }
}

async function reloadSessionPlugins(
  sessionId: string,
): Promise<PluginSessionReloadSummary> {
  if (!conversationService.hasSession(sessionId)) {
    return {
      applied: false,
      reason: 'not_running',
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
    }
  }

  try {
    const response = await conversationService.requestControl(
      sessionId,
      { subtype: 'reload_plugins' },
      120_000,
    )
    const commands = Array.isArray(response.commands) ? response.commands : []
    const normalizedCommands = updateSessionSlashCommands(sessionId, commands)

    return {
      applied: true,
      commands: normalizedCommands.length,
      agents: Array.isArray(response.agents) ? response.agents.length : 0,
      plugins: Array.isArray(response.plugins) ? response.plugins.length : 0,
      mcpServers: Array.isArray(response.mcpServers) ? response.mcpServers.length : 0,
      errors: typeof response.error_count === 'number' ? response.error_count : 0,
    }
  } catch {
    return {
      applied: false,
      reason: 'failed',
      commands: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      errors: 0,
    }
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw new ApiError(400, 'Invalid plugin request', 'PLUGIN_ACTION_INVALID')
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function coerceScope(value: unknown):
  | 'user'
  | 'project'
  | 'local'
  | 'managed'
  | undefined {
  if (value == null) return undefined
  if (
    value === 'user' ||
    value === 'project' ||
    value === 'local' ||
    value === 'managed'
  ) {
    return value
  }
  throw new ApiError(400, 'Invalid plugin scope', 'PLUGIN_ACTION_INVALID')
}

function pluginErrorResponse(error: unknown): Response {
  const status = error instanceof ApiError ? error.statusCode : 500
  const code = error instanceof ApiError
    ? pluginErrorCode(error)
    : 'PLUGIN_REQUEST_FAILED'

  return Response.json({ error: code }, { status })
}

function pluginErrorCode(error: ApiError):
  | 'PLUGIN_ACTION_FAILED'
  | 'PLUGIN_ACTION_INVALID'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_REQUEST_FAILED' {
  if (error.code === 'PLUGIN_ACTION_FAILED') return 'PLUGIN_ACTION_FAILED'
  if (error.code === 'PLUGIN_ACTION_INVALID' || error.code === 'BAD_REQUEST') {
    return 'PLUGIN_ACTION_INVALID'
  }
  if (error.code === 'PLUGIN_NOT_FOUND' || error.code === 'NOT_FOUND') {
    return 'PLUGIN_NOT_FOUND'
  }
  return 'PLUGIN_REQUEST_FAILED'
}
