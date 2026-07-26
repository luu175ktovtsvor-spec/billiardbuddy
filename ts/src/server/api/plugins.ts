import { ApiError } from '../middleware/errorHandler.js'
import { PluginService } from '../services/pluginService.js'
import type { ProductPluginScope } from '../services/productPluginRegistry.js'

const pluginService = new PluginService()

type PluginTaskReloadSummary = {
  applied: boolean
  reason?: 'next_turn'
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
      const taskId = optionalProductTaskId(url.searchParams)
      const response = await pluginService.reloadPlugins(cwd)
      if (!taskId) {
        return Response.json(response)
      }

      return Response.json({
        ...response,
        task: nextTurnPluginSummary(),
      })
    }

    if (method === 'POST' && sub) {
      const body = await parseJsonBody(req)
      const actionCwd = cwd || (typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined)
      if (sub === 'install') {
        const sourcePath = asString(body.sourcePath)
        if (!sourcePath) throw new ApiError(400, 'Invalid plugin source', 'PLUGIN_ACTION_INVALID')
        return Response.json(await pluginService.installPlugin(sourcePath, coerceScope(body.scope) ?? 'user', actionCwd))
      }
      const pluginId = asString(body.id)
      if (!pluginId) {
        throw new ApiError(400, 'Invalid plugin request', 'PLUGIN_ACTION_INVALID')
      }

      const scope = coerceScope(body.scope)

      switch (sub) {
        case 'enable':
          return Response.json(await pluginService.enablePlugin(pluginId, scope, actionCwd))
        case 'disable':
          return Response.json(await pluginService.disablePlugin(pluginId, scope, actionCwd))
        case 'update':
          return Response.json(
            await pluginService.updatePlugin(pluginId, scope, actionCwd),
          )
        case 'uninstall':
          return Response.json(
            await pluginService.uninstallPlugin(
              pluginId,
              scope,
              body.keepData === true,
              actionCwd,
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

function optionalProductTaskId(searchParams: URLSearchParams): string | undefined {
  if (!searchParams.has('taskId')) return undefined
  const taskId = searchParams.get('taskId')?.trim()
  if (taskId) return taskId
  throw new ApiError(503, 'Product task is unavailable', 'PRODUCT_TASK_UNAVAILABLE')
}

function nextTurnPluginSummary(): PluginTaskReloadSummary {
  return {
    applied: false,
    reason: 'next_turn',
    commands: 0,
    agents: 0,
    plugins: 0,
    mcpServers: 0,
    errors: 0,
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

function coerceScope(value: unknown): ProductPluginScope | undefined {
  if (value == null) return undefined
  if (
    value === 'user' ||
    value === 'project'
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
  | 'PRODUCT_TASK_UNAVAILABLE'
  | 'PLUGIN_REQUEST_FAILED' {
  if (error.code === 'PRODUCT_TASK_UNAVAILABLE') return 'PRODUCT_TASK_UNAVAILABLE'
  if (error.code === 'PLUGIN_ACTION_FAILED') return 'PLUGIN_ACTION_FAILED'
  if (error.code === 'PLUGIN_ACTION_INVALID' || error.code === 'BAD_REQUEST') {
    return 'PLUGIN_ACTION_INVALID'
  }
  if (error.code === 'PLUGIN_NOT_FOUND' || error.code === 'NOT_FOUND') {
    return 'PLUGIN_NOT_FOUND'
  }
  return 'PLUGIN_REQUEST_FAILED'
}
