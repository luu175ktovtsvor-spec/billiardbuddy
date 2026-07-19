/**
 * Claude Code Desktop App — HTTP + WebSocket Server
 *
 * 为桌面端 UI 提供 REST API 和 WebSocket 实时通信。
 * 读写与 CLI 完全相同的文件系统，确保 CLI/UI 数据互通。
 */

import { handleApiRequest } from './router.js'
import { handleWebSocket, type WebSocketData } from './ws/handler.js'
import { resolveCors, type CorsResolution } from './middleware/cors.js'
import { requireAuth } from './middleware/auth.js'
import { teamWatcher } from './services/teamWatcher.js'
import { cronScheduler } from './services/cronScheduler.js'
import { handleProxyRequest } from './proxy/handler.js'
import { ProviderService } from './services/providerService.js'
import { ensureQfGatewayRegistration } from './services/qfGatewayProvider.js'
import { handlePreviewFs } from './api/previewFs.js'
import { handleLocalFile } from './api/localFile.js'
import { sessionService } from './services/sessionService.js'
import { conversationService } from './services/conversationService.js'
import { enableConfigs } from '../utils/config.js'
import { diagnosticsService } from './services/diagnosticsService.js'
import { ensurePersistentStorageUpgraded } from './services/persistentStorageMigrations.js'
import { consumeMediaUiCapability, createMediaApiHandler } from './api/media.js'
import { productTaskService } from './product/taskService.js'

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
  const cliPath = readArgValue('--cli-path')
  const authRequired = hasArgFlag('--auth-required')

  if (cliPath) {
    process.env.CLAUDE_CLI_PATH = cliPath
  }

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
  const mediaApiHandler = createMediaApiHandler(
    undefined,
    consumeMediaUiCapability(),
  )
  enableConfigs()
  // Don't hijack the global console / process handlers under `bun test`:
  // a test that boots the server would otherwise route every test-side
  // console.error/warn into the user's real diagnostics file.
  if (process.env.NODE_ENV !== 'test') {
    diagnosticsService.installConsoleCapture()
    diagnosticsService.installProcessCapture()
  }
  let serverPort = port
  const localConnectHost =
    localHost === '127.0.0.1' || localHost === 'localhost'
      ? '127.0.0.1'
      : localHost

  const forceAuth =
    SERVER_OPTIONS.authRequired ||
    process.env.SERVER_AUTH_REQUIRED === '1'

  let server: ReturnType<typeof Bun.serve<WebSocketData>>

  try {
    server = Bun.serve<WebSocketData>({
      port,
      hostname: localHost,
      idleTimeout: 60,

      async fetch(req, server) {
        await ensurePersistentStorageUpgraded()
        const url = new URL(req.url)
        const origin = req.headers.get('Origin')
        const cors = await resolveCors(origin)

        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }
          return new Response(null, { status: 204, headers: cors.headers })
        }

        // Product task websocket. The URL and browser-visible protocol are
        // task-scoped; only this server-side adapter resolves the Core session.
        if (url.pathname.startsWith('/ws/product/tasks/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req, url.searchParams.get('token'))
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const parts = url.pathname.split('/').filter(Boolean)
          const taskId = parts.length === 4 ? parts[3] || '' : ''
          if (!taskId || !/^[0-9a-zA-Z_-]{1,64}$/.test(taskId)) {
            return new Response('Invalid product task ID', { status: 400 })
          }

          let sessionId: string
          try {
            sessionId = await productTaskService.resolveCoreSessionId(taskId)
          } catch {
            return new Response('Product task not found', { status: 404 })
          }
          if (!/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
            return new Response('Product task not found', { status: 404 })
          }

          const upgraded = server.upgrade(req, {
            data: {
              sessionId,
              productTaskId: taskId,
              connectedAt: Date.now(),
              channel: 'product',
              sdkToken: null,
              serverPort,
              serverHost: localConnectHost,
            },
          })
          if (upgraded) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // Internal SDK WebSocket used by the spawned Claude CLI.
        if (url.pathname.startsWith('/sdk/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req, url.searchParams.get('token'))
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const sessionId = url.pathname.split('/').pop() || ''
          if (!sessionId || !/^[0-9a-zA-Z_-]{1,64}$/.test(sessionId)) {
            return new Response('Invalid session ID', { status: 400 })
          }
          const upgraded = server.upgrade(req, {
            data: {
              sessionId,
              connectedAt: Date.now(),
              channel: 'sdk',
              sdkToken: url.searchParams.get('token'),
              serverPort,
              serverHost: localConnectHost,
            },
          })
          if (upgraded) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // Preview filesystem — serve sandboxed workspace files for a session.
        if (url.pathname.startsWith('/preview-fs/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const response = await handlePreviewFs(
            url,
            async (sessionId) =>
              conversationService.getSessionWorkDir(sessionId) ||
              (await sessionService.getSessionWorkDir(sessionId)) ||
              null,
            req.headers,
          )
          return withCors(response, cors)
        }

        // Local filesystem — serve an ABSOLUTE local file ($HOME/tmp/registered
        // roots sandbox) so `file://` links / AI-emitted absolute paths open in
        // the in-app browser. Gated identically to /preview-fs above.
        if (url.pathname.startsWith('/local-file/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }

          const response = await handleLocalFile(url, req.headers)
          return withCors(response, cors)
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

          try {
            const response = await handleApiRequest(req, url, { media: mediaApiHandler })
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

        // Proxy — protocol-translating reverse proxy for OpenAI-compatible APIs
        if (url.pathname.startsWith('/proxy/')) {
          if (cors.rejected) {
            return corsRejectedResponse(cors)
          }

          if (forceAuth) {
            const authError = await requireAuth(req)
            if (authError) {
              return withCors(authError, cors)
            }
          }
          try {
            const response = await handleProxyRequest(req, url)
            return withCors(response, cors)
          } catch (error) {
            void diagnosticsService.recordEvent({
              type: 'proxy_request_failed',
              severity: 'error',
              summary: error instanceof Error ? error.message : String(error),
              details: { path: url.pathname, method: req.method, error },
            })
            console.error('[Server] Proxy error:', error)
            return withCors(Response.json(
              { type: 'error', error: { type: 'api_error', message: 'Internal proxy error' } },
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

      websocket: handleWebSocket,
    })
    serverPort = server.port
    ProviderService.setServerPort(serverPort)
  } catch (error) {
    const message = error instanceof Error && error.message
      ? error.message
      : `Failed to start server. Is port ${port} in use?`
    throw new Error(message, { cause: error })
  }

  // Product-managed gateway auto-routing: when the gateway is configured (URL+token)
  // and the user hasn't chosen their own provider, route the agent through the local
  // proxy → gateway. Idempotent; never overwrites a user's active provider.
  // startServer is synchronous, so registration is kicked off (not awaited) here —
  // but it is memoized, and every session-start path awaits whenQfGatewayReady()
  // before reading the active provider, so the first session never races a
  // pre-registration null activeId. Kept AFTER setServerPort so the proxy base URL
  // synced into settings carries the finalized port.
  void ensureQfGatewayRegistration(new ProviderService())

  // Start watching ~/.claude/teams/ for real-time WebSocket push
  teamWatcher.start()

  // Start the cron scheduler to execute scheduled tasks
  cronScheduler.start()

  console.log(`[Server] BilliardBuddy Agent service running at http://${localHost}:${serverPort}`)
  return server
}

// ─── Graceful shutdown: kill all CLI subprocesses on exit ────────────────────

let shutdownInProgress: Promise<void> | null = null

export async function stopServerRuntimeForShutdown(
  options: { waitForCli?: boolean } = {},
): Promise<void> {
  teamWatcher.stop()
  cronScheduler.stop()

  const active = conversationService.getActiveSessions()
  if (active.length > 0) {
    console.log(`[Server] Shutting down — killing ${active.length} CLI subprocess(es)`)
    if (options.waitForCli === false) {
      conversationService.stopAllSessions()
    } else {
      await conversationService.stopAllSessionsAndWait()
    }
  }
}

function cleanupAllSessions() {
  void stopServerRuntimeForShutdown({ waitForCli: false })
}

async function cleanupAllSessionsAndWait() {
  await stopServerRuntimeForShutdown({ waitForCli: true })
}

function shutdownAndExit(signal: 'SIGTERM' | 'SIGINT', exitCode: number) {
  if (shutdownInProgress) return

  shutdownInProgress = (async () => {
    console.log(`[Server] Received ${signal}`)
    await cleanupAllSessionsAndWait()
    process.exit(exitCode)
  })().catch((error) => {
    console.error(
      `[Server] ${signal} shutdown cleanup failed:`,
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  })
}

process.on('SIGTERM', () => {
  shutdownAndExit('SIGTERM', 0)
})

process.on('SIGINT', () => {
  shutdownAndExit('SIGINT', 0)
})

process.on('exit', () => {
  cleanupAllSessions()
})

// Direct execution
if (import.meta.main) {
  startServer()
}
