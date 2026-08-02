/** BilliardBuddy local Product Server for the desktop GUI. */

import { handleApiRequest } from './router.js'
import { resolveCors, type CorsResolution } from './middleware/cors.js'
import { requireAuth } from './middleware/auth.js'
import { diagnosticsService } from './services/diagnosticsService.js'
import { consumeMediaUiCapability, createMediaApiHandler } from './api/media.js'
import { createImageWorkbenchDomainApiHandler } from './api/imageWorkbench.js'
import { createVideoWorkbenchDomainApiHandler } from './api/videoWorkbench.js'
import { isLongMediaRequestPath } from './mediaRequestTimeout.js'
import { handleProductControlApi } from './api/productControl.js'
import { MediaProjectService } from './services/mediaProjectService.js'
import { ImageWorkbenchService } from './services/imageWorkbenchService.js'
import { VideoWorkbenchService } from './services/videoWorkbenchService.js'
import { voiceOperationService } from './services/voiceOperationService.js'
import {
  consumeGatewayAccessTokenCapability,
  updateGatewayAccessToken,
} from './services/gatewayAccessTokenRuntime.js'
import { GATEWAY_ACCESS_TOKEN_UPDATE_PATH } from '../../shared/product/providerGateway.js'

function readArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2)
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

function hasArgFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function resolveServerOptions() {
  const portArg = readArgValue('--port')
  const port = Number.parseInt(portArg || process.env.SERVER_PORT || '3456', 10)
  const host = readArgValue('--host') || process.env.SERVER_HOST || '127.0.0.1'
  const authRequired = hasArgFlag('--auth-required')

  return { port, host, authRequired }
}

const SERVER_OPTIONS = resolveServerOptions()
const PORT = SERVER_OPTIONS.port
const HOST = SERVER_OPTIONS.host
function withCors(response: Response, cors: CorsResolution): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(cors.headers)) {
    headers.set(key, value)
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  })
}

function corsRejectedResponse(cors: CorsResolution): Response {
  return Response.json(
    { error: 'CORS origin not allowed' },
    { status: 403, headers: cors.headers },
  )
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHost(normalized.slice('::ffff:'.length))
  }
  if (normalized === 'localhost' || normalized === '::1') {
    return true
  }

  const parts = normalized.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

/**
 * The desktop sidecar is deliberately local-only.  Do not allow a command-line
 * or environment override to reopen the retired LAN/H5 service surface.
 */
export function resolveLocalServerHost(host: string): string {
  return isLoopbackHost(host) ? host : '127.0.0.1'
}

export function startServer(port = PORT, host = HOST) {
  const localHost = resolveLocalServerHost(host)
  const mediaUiCapability = consumeMediaUiCapability()
  const gatewayAccessTokenCapability = consumeGatewayAccessTokenCapability()
  // The generic media service is now a legacy reader only. Image and video
  // each own their state, operation journal and recovery paths.
  const mediaService = new MediaProjectService()
  const imageWorkbenchService = new ImageWorkbenchService()
  const videoWorkbenchService = new VideoWorkbenchService()
  if (process.env.NODE_ENV !== 'test') {
    void voiceOperationService.purgeExpired().catch(error => diagnosticsService.recordEvent({
      type: 'voice_gc_failed',
      severity: 'error',
      summary: 'Voice transcript retention cleanup failed',
      details: { error },
    }))
  }
  const imageApiHandler = createImageWorkbenchDomainApiHandler(
    imageWorkbenchService,
    mediaUiCapability,
  )
  const videoApiHandler = createVideoWorkbenchDomainApiHandler(
    videoWorkbenchService,
    mediaUiCapability,
  )
  const mediaApiHandler = createMediaApiHandler(
    mediaService,
    mediaUiCapability,
  )
  const sidecarStorageUpgrade = Promise.all([
    mediaService.migrateSupportedStorage(),
    voiceOperationService.migrateSupportedStorage(),
  ])
  // Both importers are one-way and idempotent. They retain the former generic
  // directory as evidence while moving all formal reads/writes to the owning
  // workbench, then settle only local child-process operations after restart.
  const mediaWorkbenchRecovery = sidecarStorageUpgrade
    .then(async () => await Promise.all([
      imageWorkbenchService.migrateLegacyMediaStore(),
      videoWorkbenchService.migrateLegacyMediaStore(),
    ]))
    .then(async () => await Promise.all([
      imageWorkbenchService.recoverInterruptedOperations(),
      videoWorkbenchService.recoverInterruptedOperations(),
    ]))
  const productApiHandler = (req: Request, url: URL, segments: string[]) =>
    handleProductControlApi(req, url, segments)
  // Library consumers can own the global console and process handlers:
  // a test that boots the server would otherwise route every test-side
  // console.error/warn into the user's real diagnostics file.
  if (process.env.NODE_ENV !== 'test') {
    diagnosticsService.installConsoleCapture()
    diagnosticsService.installProcessCapture()
  }
  const forceAuth =
    SERVER_OPTIONS.authRequired ||
    process.env.SERVER_AUTH_REQUIRED === '1'

  try {
    const server = Bun.serve({
      port,
      hostname: localHost,
      idleTimeout: 60,

      async fetch(req, server) {
        await sidecarStorageUpgrade
        await mediaWorkbenchRecovery
        const url = new URL(req.url)
        if (url.pathname === GATEWAY_ACCESS_TOKEN_UPDATE_PATH) {
          return await updateGatewayAccessToken(req, gatewayAccessTokenCapability)
        }
        const origin = req.headers.get('Origin')
        const cors = await resolveCors(origin)

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }
          return new Response(null, { status: 204, headers: cors.headers })
        }

        // REST API
        if (url.pathname.startsWith('/api/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }

          // A media status read can materialize the completed Base64 image from the
          // gateway before returning it to the renderer. Keep Bun's generic 60-second
          // idle guard for ordinary APIs, but let these trusted loopback media routes
          // use their own five-minute end-to-end response deadline.
          if (isLongMediaRequestPath(url.pathname)) server.timeout(req, 0)

          try {
            const response = await handleApiRequest(req, url, {
              media: mediaApiHandler,
              images: imageApiHandler,
              videos: videoApiHandler,
              product: productApiHandler,
            })
            return withCors(response, cors)
          } catch (error) {
            void diagnosticsService.recordEvent({
              type: 'api_request_failed',
              severity: 'error',
              summary: error instanceof Error ? error.message : String(error),
              details: { path: url.pathname, method: req.method, error },
            })
            console.error('[Server] API error:', error)
            return withCors(Response.json(
              { error: 'Internal server error' },
              { status: 500 },
            ), cors)
          }
        }

        // Health check
        if (url.pathname === '/health') {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          return Response.json(
            { status: 'ok', timestamp: new Date().toISOString() },
            { headers: cors.headers },
          )
        }

        if (url.pathname === '/auth/callback' || url.pathname === '/callback') {
          return new Response('Not Found', { status: 404 })
        }

        return new Response('Not Found', { status: 404 })
      },

    })
    if (typeof server.port !== 'number') throw new Error('SERVER_PORT_UNAVAILABLE')
    const serverPort = server.port
    console.log(`[Server] BilliardBuddy local services running at http://${localHost}:${serverPort}`)
    return server
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message.trim() : ''
    const message = originalMessage && originalMessage !== 'Error'
      ? originalMessage
      : `Failed to start server. Is port ${port} in use?`
    const startupError = new Error(message)
    startupError.cause = error
    // Bun can surface a Bun.serve bind failure with a stack whose first line is
    // only "Error" even after it is wrapped. Keep the actionable startup
    // reason explicit for both stderr and the diagnostics record.
    if (!startupError.stack?.includes(message)) {
      startupError.stack = `${startupError.name}: ${message}\n${startupError.stack ?? ''}`
    }
    throw startupError
  }

}
// Direct execution
if (import.meta.main) {
  startServer()
}
