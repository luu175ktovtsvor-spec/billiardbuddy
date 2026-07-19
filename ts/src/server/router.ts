/**
 * API Router — 将请求路由到对应的 API handler
 */

import { handleAgentsApi } from './api/agents.js'
import { handleStatusApi } from './api/status.js'
import { handlePluginsApi } from './api/plugins.js'
import { handleSkillsApi } from './api/skills.js'
import { handleComputerUseApi } from './api/computer-use.js'
import { handleMcpApi } from './api/mcp.js'
import { handleDiagnosticsApi } from './api/diagnostics.js'
import { handleDesktopUiApi } from './api/desktop-ui.js'
import { handleMediaApi } from './api/media.js'
import { handleVoiceApi } from './api/voice.js'
import { handleProductApi } from './api/product.js'

type ApiRequestHandlers = {
  media?: typeof handleMediaApi
}

export async function handleApiRequest(
  req: Request,
  url: URL,
  handlers: ApiRequestHandlers = {},
): Promise<Response> {
  const path = url.pathname
  const segments = path.split('/').filter(Boolean) // ['api', 'sessions', ...]

  // Route to appropriate handler based on the second segment
  const resource = segments[1]

  switch (resource) {
    case 'agents':
      return handleAgentsApi(req, url, segments)

    case 'status':
      return handleStatusApi(req, url, segments)

    case 'skills':
      return handleSkillsApi(req, url, segments)

    case 'mcp':
      return handleMcpApi(req, url, segments)

    case 'plugins':
      return handlePluginsApi(req, url, segments)

    case 'computer-use':
      return handleComputerUseApi(req, url, segments)

    case 'diagnostics':
      return handleDiagnosticsApi(req, url, segments)

    case 'desktop-ui':
      return handleDesktopUiApi(req, url, segments)

    case 'media':
      return (handlers.media ?? handleMediaApi)(req, url, segments)

    case 'voice':
      return handleVoiceApi(req, segments)

    case 'product':
      return handleProductApi(req, url, segments)

    default:
      return Response.json(
        { error: 'Not Found', message: `Unknown API resource: ${resource}` },
        { status: 404 }
      )
  }
}
