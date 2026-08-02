/**
 * API Router — 将请求路由到对应的 API handler
 */

import { handleStatusApi } from './api/status.js'
import { handlePluginsApi } from './api/plugins.js'
import { handleDiagnosticsApi } from './api/diagnostics.js'
import { legacyAgentBackendRetiredResponse } from './api/productControl.js'

type ApiRequestHandlers = {
  media: (req: Request, url: URL, segments: string[]) => Promise<Response>
  images: (req: Request, url: URL, segments: string[]) => Promise<Response>
  videos: (req: Request, url: URL, segments: string[]) => Promise<Response>
  product: (req: Request, url: URL, segments: string[]) => Promise<Response>
}

export async function handleApiRequest(
  req: Request,
  url: URL,
  handlers: ApiRequestHandlers,
): Promise<Response> {
  const path = url.pathname
  const segments = path.split('/').filter(Boolean) // ['api', 'sessions', ...]

  // Route to appropriate handler based on the second segment
  const resource = segments[1]

  switch (resource) {
    case 'status':
      return handleStatusApi(req, url, segments)

    case 'mcp':
      return legacyAgentBackendRetiredResponse()

    case 'plugins':
      return handlePluginsApi(req, url, segments)

    case 'diagnostics':
      return handleDiagnosticsApi(req, url, segments)

    case 'media':
      return handlers.media(req, url, segments)

    case 'images':
      return handlers.images(req, url, segments)

    case 'videos':
      return handlers.videos(req, url, segments)

    case 'product':
      return handlers.product(req, url, segments)

    case 'browser':
      return legacyAgentBackendRetiredResponse()

    default:
      return Response.json(
        { error: 'Not Found', message: `Unknown API resource: ${resource}` },
        { status: 404 }
      )
  }
}
