/** BilliardBuddy local Product Server for the desktop GUI. */

import { handleApiRequest } from './router.js'
import { createProductTaskWebSocket, type ProductTaskWebSocketData } from './product/taskWebSocket.js'
import { resolveCors, type CorsResolution } from './middleware/cors.js'
import { requireAuth } from './middleware/auth.js'
import { CronScheduler } from './services/cronScheduler.js'
import { diagnosticsService } from './services/diagnosticsService.js'
import { consumeMediaUiCapability, createMediaApiHandler } from './api/media.js'
import { isLongMediaRequestPath } from './mediaRequestTimeout.js'
import { handleProductApi } from './api/product.js'
import { createProductTaskService, type ProductTaskService } from './product/taskService.js'
import { MediaProjectService } from './services/mediaProjectService.js'
import { voiceOperationService } from './services/voiceOperationService.js'
import { getProductConfigDir } from './product/productPaths.js'
import { configureChromeSessionBridge, getChromeSessionBridge } from './services/chromeSessionBridge.js'
import { ProductCapabilitySnapshotService } from './services/productCapabilitySnapshot.js'
import { ProductResourceScheduler } from './product/resourceScheduler.js'
import { ProductStorageMigrationCoordinator } from './services/productStorageMigrations.js'
import { CronService } from './services/cronService.js'
import { ProductScheduledTaskService } from './product/scheduledTaskService.js'
import { createProductTaskReviewService } from './product/taskReviewService.js'
import { createRuntimeTaskLifecycleParticipants } from './product/taskLifecycleParticipants.js'
import { ProductCoreOperationBridge } from './product/productCoreOperationBridge.js'
import { createProductTaskRunComposition, type ProductTaskRunComposition } from './agent-worker/taskRunComposition.js'
import type { ProductTaskRunDispatchPort } from './product/taskRunDispatchPort.js'
import { createProductTaskRuntimeEventPort } from './product/taskRuntimeEventPort.js'
import { ProductTaskWorkerRuntimeEvents } from './product/taskWorkerRuntimeEvents.js'
import { migrateSupportedScheduledTaskRuns, purgeScheduledTaskRunsForDeletedTask } from './services/cronScheduler.js'
import {
  consumeGatewayAccessTokenCapability,
  updateGatewayAccessToken,
} from './services/gatewayAccessTokenRuntime.js'
import { GATEWAY_ACCESS_TOKEN_UPDATE_PATH } from '../../shared/product/providerGateway.js'
import {
  consumePersonalModelConfigurationCapability,
  updatePersonalModelRuntimeConfiguration,
} from './services/personalModelRuntimeConfiguration.js'
import { PERSONAL_MODEL_CONFIGURATION_UPDATE_PATH } from '../../shared/product/personalModels.js'
import * as path from 'node:path'

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
let liveCronScheduler: CronScheduler | undefined
let liveTaskRunComposition: ProductTaskRunComposition | undefined
let liveProductTaskWebSocket: ReturnType<typeof createProductTaskWebSocket> | undefined

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
  const personalModelConfigurationCapability = consumePersonalModelConfigurationCapability()
  const gatewayAccessTokenCapability = consumeGatewayAccessTokenCapability()
  const configDir = getProductConfigDir()
  const cronService = new CronService(configDir)
  const coreOperationBridge = new ProductCoreOperationBridge()
  const taskRuntimeEvents = new ProductTaskWorkerRuntimeEvents()
  const taskRuntimeEventPort = createProductTaskRuntimeEventPort(taskRuntimeEvents)
  let chromeSessionBridge: ReturnType<typeof configureChromeSessionBridge> | undefined
  let desktopResourceScheduler!: ProductResourceScheduler
  let productTaskService!: ProductTaskService
  let taskRunComposition: ProductTaskRunComposition | undefined
  const dispatcher: ProductTaskRunDispatchPort = {
    dispatch: async (...input) => taskRunComposition
      ? await taskRunComposition.dispatcher.dispatch(...input)
      : 'recovery_required',
    stop: async (...input) => { await taskRunComposition?.dispatcher.stop?.(...input) },
    approve: async (...input) => await taskRunComposition?.dispatcher.approve?.(...input) ?? false,
    answer: async (...input) => await taskRunComposition?.dispatcher.answer?.(...input) ?? false,
    steer: async (...input) => await taskRunComposition?.dispatcher.steer?.(...input) ?? false,
  }
  productTaskService = createProductTaskService({
    dispatcher,
    runtimeEvents: taskRuntimeEventPort,
    additionalLifecycleParticipants: createRuntimeTaskLifecycleParticipants({
      schedules: cronService,
      recruiting: () => chromeSessionBridge,
      resources: () => desktopResourceScheduler,
      operationJournal: coreOperationBridge,
      scheduledRuns: {
        purgeTaskRuns: (taskId, scheduleIds) => purgeScheduledTaskRunsForDeletedTask(taskId, scheduleIds, configDir),
      },
    }),
  })
  desktopResourceScheduler = new ProductResourceScheduler({ statePath: productTaskService.workerSchedulerStatePath() })
  taskRunComposition = createProductTaskRunComposition(
    productTaskService,
    desktopResourceScheduler,
    taskRuntimeEventPort,
  )
  liveTaskRunComposition = taskRunComposition
  const scheduler = new CronScheduler(cronService, productTaskService)
  liveCronScheduler = scheduler
  const scheduledTasks = new ProductScheduledTaskService(cronService, scheduler, {
    get: taskId => productTaskService.getScheduledTaskContext(taskId),
  })
  const taskReview = createProductTaskReviewService(productTaskService)
  const browserRoot = path.join(getProductConfigDir(), 'billiardbuddy', 'browser')
  chromeSessionBridge = configureChromeSessionBridge({
    statePath: path.join(browserRoot, 'actions.json'),
    descriptorPath: path.join(browserRoot, 'native-bridge.json'),
    scheduler: desktopResourceScheduler,
  })
  let productTaskQueueRecovery: Promise<void> | undefined
  // The independent image and video workbenches share one process-local media
  // service. Chat/ProductTask routes never receive this service.
  const mediaService = new MediaProjectService()
  if (process.env.NODE_ENV !== 'test') {
    void voiceOperationService.purgeExpired().catch(error => diagnosticsService.recordEvent({
      type: 'voice_gc_failed',
      severity: 'error',
      summary: 'Voice transcript retention cleanup failed',
      details: { error },
    }))
  }
  const mediaApiHandler = createMediaApiHandler(
    mediaService,
    mediaUiCapability,
  )
  const productCapabilitySnapshots = new ProductCapabilitySnapshotService({
    mediaToolchainStatus: () => mediaService.toolchainStatus(),
    scheduledRuns: () => scheduledTasks.listRecentRuns(100),
  })
  const productStorageUpgrade = new ProductStorageMigrationCoordinator(
    configDir,
    {
      migrateProductTasks: () => productTaskService.migrateSupportedStorage(),
      migrateMedia: () => mediaService.migrateSupportedStorage(),
      migrateVoice: () => voiceOperationService.migrateSupportedStorage(),
      migrateScheduledTasks: () => new CronService(configDir).migrateSupportedStorage(),
      migrateScheduledTaskRuns: () => migrateSupportedScheduledTaskRuns(configDir),
    },
  ).ensureUpgraded()
  if (process.env.NODE_ENV !== 'test') {
    void productStorageUpgrade
      .then(() => mediaService.purgeExpiredDeletions(), () => undefined)
      .catch(error => diagnosticsService.recordEvent({
        type: 'media_gc_failed',
        severity: 'error',
        summary: 'Media retention cleanup failed',
        details: { error },
      }))
  }
  const productApiHandler = (req: Request, url: URL, segments: string[]) => (
    handleProductApi(
      req,
      url,
      segments,
      productTaskService,
      taskReview,
      scheduledTasks,
      productCapabilitySnapshots,
      coreOperationBridge,
    )
  )
  const productTaskWebSocket = createProductTaskWebSocket(productTaskService, taskRuntimeEvents)
  liveProductTaskWebSocket = productTaskWebSocket
  // Library consumers can own the global console and process handlers:
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

  let server: ReturnType<typeof Bun.serve<ProductTaskWebSocketData>>

  try {
    server = Bun.serve<ProductTaskWebSocketData>({
      port,
      hostname: localHost,
      idleTimeout: 60,

      async fetch(req, server) {
        await productStorageUpgrade
        productTaskQueueRecovery ??= productTaskService.recoverDurableTaskRunQueue()
        await productTaskQueueRecovery
        const url = new URL(req.url)
        if (url.pathname === PERSONAL_MODEL_CONFIGURATION_UPDATE_PATH) {
          return await updatePersonalModelRuntimeConfiguration(req, personalModelConfigurationCapability)
        }
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
              handoff: 'awaiting_resume',
              pending_live_events: [],
            },
          })
          if (upgraded) return undefined
          return new Response('WebSocket upgrade failed', { status: 400 })
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

      websocket: productTaskWebSocket,
    })
    if (typeof server.port !== 'number') throw new Error('SERVER_PORT_UNAVAILABLE')
    serverPort = server.port
    void chromeSessionBridge.activate(`http://${localConnectHost}:${serverPort}`).catch(() => undefined)
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

  // Never execute an unattended task against a partially migrated store.
  void productStorageUpgrade.then(() => scheduler.start()).catch(() => undefined)

  console.log(`[Server] BilliardBuddy Agent service running at http://${localHost}:${serverPort}`)
  return server
}

// ─── Graceful shutdown: stop product workers and local services ──────────────

let shutdownInProgress: Promise<void> | null = null

export async function stopServerRuntimeForShutdown(
  _options: { waitForCli?: boolean } = {},
): Promise<void> {
  liveCronScheduler?.stop()
  liveCronScheduler = undefined
  liveProductTaskWebSocket?.shutdown()
  liveProductTaskWebSocket = undefined
  try {
    await getChromeSessionBridge().deactivate()
  } catch {
    // Tests and failed early startups may shut down before the browser bridge
    // is configured. There is no descriptor or live session to clean up then.
  }

  const composition = liveTaskRunComposition
  liveTaskRunComposition = undefined
  await composition?.shutdown()
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
