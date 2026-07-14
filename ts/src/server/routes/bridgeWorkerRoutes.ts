// Remote Bridge worker control plane: transport lifecycle, uploads and credential refresh.

import type { FetchLike } from '../../proxy/ProxyModel'
import { createBridgeCodeSessionClient } from '../../tasks/bridgeCodeSessionClient'
import type { BridgeResolvedInboundMessage } from '../../tasks/bridgeInboundMessages'
import type { BridgePeerRegistry } from '../../tasks/bridgePeerRegistry'
import type { BridgeRemoteCredentialRecord, BridgeRemoteState } from '../../tasks/bridgeRemoteState'
import { projectBridgeSdkEvent } from '../../tasks/bridgeSdkEventProjection'
import { BridgeWorkerClient } from '../../tasks/bridgeWorkerClient'
import { BridgeWorkerRefreshScheduler, type BridgeWorkerRefreshCause } from '../../tasks/bridgeWorkerRefreshScheduler'
import { BridgeWorkerStream } from '../../tasks/bridgeWorkerStream'
import {
  bridgeCodeSessionConfigFromBody,
  bridgeRefreshConfigFromBody,
  bridgeRemoteConfigFromBody,
  bridgeWorkerSessionStateFrom,
} from '../bridgeParams'
import { jsonError, TurnSetupError } from '../middleware/http'
import { providerStatusFor } from '../providerRuntime'
import { isRecord, numberFrom, stringOr } from '../requestParams'

interface BridgeWorkerRouteDependencies {
  state: BridgeRemoteState
  peers: BridgePeerRegistry
  stateRoot: string
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  dispatchInbound: (body: Record<string, unknown>, resolved: BridgeResolvedInboundMessage) => Promise<unknown>
  projectEvent: (body: Record<string, unknown>, payload: Record<string, unknown>) => Promise<void>
}

export interface BridgeWorkerRouteController {
  handle(url: URL, req: Request): Promise<Response | null>
  close(): void
}

type BridgeWorkerStartResult = {
  worker: BridgeWorkerClient
  initialized: Awaited<ReturnType<BridgeWorkerClient['initialize']>>
  stream: BridgeWorkerStream | null
  streamEnabled: boolean
  initialSequence: number
}

type BridgeWorkerRefreshValue = {
  credentials: BridgeRemoteCredentialRecord
  started: BridgeWorkerStartResult
  status: number
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

function routeError(err: unknown): Response {
  return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
}

function codeSessionIdFrom(value: string): string {
  return value.startsWith('bridge:') ? value.slice('bridge:'.length) : value
}

export function createBridgeWorkerRouteController(deps: BridgeWorkerRouteDependencies): BridgeWorkerRouteController {
  const workers = new Map<string, BridgeWorkerClient>()
  const streams = new Map<string, BridgeWorkerStream>()
  const refreshSchedulers = new Map<string, BridgeWorkerRefreshScheduler<BridgeWorkerRefreshValue>>()
  const env = deps.env ?? process.env

  function cancelRefresh(codeSessionId: string): void {
    refreshSchedulers.get(codeSessionId)?.cancel()
    refreshSchedulers.delete(codeSessionId)
  }

  function closeRuntime(codeSessionId: string, options: { cancelRefresh?: boolean } = {}): void {
    if (options.cancelRefresh) cancelRefresh(codeSessionId)
    streams.get(codeSessionId)?.close()
    streams.delete(codeSessionId)
    workers.get(codeSessionId)?.close()
    workers.delete(codeSessionId)
  }

  function refreshStatus(codeSessionId: string) {
    return refreshSchedulers.get(codeSessionId)?.getStatus() ?? {
      enabled: false,
      sessionId: codeSessionId,
      inFlight: false,
      nextRefreshAt: null,
      nextRefreshInMs: null,
      consecutiveFailures: 0,
      lastRefreshAt: null,
      lastError: null,
      lastCause: null,
    }
  }

  async function fetchAndStoreCredentials(codeSessionId: string, body: Record<string, unknown>) {
    const config = bridgeCodeSessionConfigFromBody(body, env)
    if (!config) throw new TurnSetupError('bridge code session client is not configured', 400)
    const trustedDeviceToken = stringOr(body.trustedDeviceToken ?? body.trusted_device_token, '')
    const client = createBridgeCodeSessionClient({ ...config, fetchImpl: deps.fetchImpl })
    const fetched = await client.fetchRemoteCredentials(codeSessionId, trustedDeviceToken || undefined)
    if (!fetched.ok) throw new TurnSetupError(fetched.error, fetched.status ?? 502)
    const credentials = await deps.state.storeCredentials(codeSessionId, fetched.value)
    return { credentials, status: fetched.status }
  }

  async function refreshCredentialsAndTransport(
    codeSessionId: string,
    body: Record<string, unknown>,
    _cause: BridgeWorkerRefreshCause,
    manageRefresh: boolean,
  ): Promise<BridgeWorkerRefreshValue> {
    const fetched = await fetchAndStoreCredentials(codeSessionId, body)
    const started = await startWorker(codeSessionId, fetched.credentials, body, { manageRefresh })
    return { ...fetched, started }
  }

  function scheduleRefresh(codeSessionId: string, body: Record<string, unknown>, credentials: BridgeRemoteCredentialRecord): void {
    const config = bridgeCodeSessionConfigFromBody(body, env)
    const refreshConfig = bridgeRefreshConfigFromBody(body)
    cancelRefresh(codeSessionId)
    if (!config || !refreshConfig.enabled) return
    const scheduler = new BridgeWorkerRefreshScheduler<BridgeWorkerRefreshValue>({
      sessionId: codeSessionId,
      refreshBufferMs: refreshConfig.refreshBufferMs,
      minDelayMs: refreshConfig.minDelayMs,
      retryDelayMs: refreshConfig.retryDelayMs,
      maxConsecutiveFailures: refreshConfig.maxConsecutiveFailures,
      onRefresh: async cause => {
        const refreshed = await refreshCredentialsAndTransport(codeSessionId, body, cause, false)
        return { value: refreshed, expiresInSeconds: refreshed.credentials.expiresIn }
      },
    })
    refreshSchedulers.set(codeSessionId, scheduler)
    scheduler.scheduleFromExpiresIn(credentials.expiresIn)
  }

  async function recoverStreamAuth(codeSessionId: string, code: number): Promise<void> {
    const scheduler = refreshSchedulers.get(codeSessionId)
    if (!scheduler) {
      closeRuntime(codeSessionId, { cancelRefresh: true })
      await deps.peers.updateStatus(codeSessionId, 'error', `worker stream closed ${code}`).catch(() => undefined)
      return
    }
    await deps.peers.updateStatus(codeSessionId, 'connecting', `worker stream closed ${code}; refreshing`).catch(() => undefined)
    const result = await scheduler.refreshNow('auth_401_recovery')
    if (result.ok) return
    if (result.skipped && (result.reason === 'in_flight' || result.reason === 'stale')) return
    closeRuntime(codeSessionId, { cancelRefresh: result.skipped && result.reason === 'cancelled' })
    const detail = result.skipped ? result.reason : result.error
    await deps.peers.updateStatus(codeSessionId, 'error', `worker stream refresh failed: ${detail}`).catch(() => undefined)
  }

  async function startWorker(
    codeSessionId: string,
    credentials: BridgeRemoteCredentialRecord | null,
    body: Record<string, unknown> = {},
    options: { manageRefresh?: boolean } = {},
  ): Promise<BridgeWorkerStartResult> {
    if (!credentials) throw new Error('bridge credentials not found')
    const previousSequence = streams.get(codeSessionId)?.getLastSequenceNum() ?? 0
    const initialSequence = numberFrom(body.initialSequenceNum ?? body.initial_sequence_num, previousSequence)
    const inboundConfig = bridgeRemoteConfigFromBody(body, env)
    const manageRefresh = options.manageRefresh ?? true
    if (manageRefresh) cancelRefresh(codeSessionId)
    closeRuntime(codeSessionId)
    const worker = new BridgeWorkerClient({
      sessionId: codeSessionId,
      credentials,
      heartbeatIntervalMs: numberFrom(body.heartbeatIntervalMs ?? body.heartbeat_interval_ms, 20_000),
      heartbeatJitterFraction: typeof body.heartbeatJitterFraction === 'number'
        ? body.heartbeatJitterFraction
        : typeof body.heartbeat_jitter_fraction === 'number'
          ? body.heartbeat_jitter_fraction
          : 0,
      fetchImpl: deps.fetchImpl,
      onEpochMismatch: () => {
        closeRuntime(codeSessionId, { cancelRefresh: true })
        void deps.peers.updateStatus(codeSessionId, 'error', 'worker epoch mismatch').catch(() => undefined)
      },
    })
    const initialized = await worker.initialize()
    if (!initialized.ok) {
      worker.close()
      throw new TurnSetupError(initialized.error || `worker init failed ${initialized.status ?? ''}`.trim(), initialized.status ?? 502)
    }
    workers.set(codeSessionId, worker)
    if (manageRefresh) scheduleRefresh(codeSessionId, body, credentials)
    const shouldStream = body.stream !== false && body.read_stream !== false
    if (shouldStream) {
      const stream = new BridgeWorkerStream({
        sessionId: codeSessionId,
        apiBaseUrl: credentials.apiBaseUrl,
        workerJwt: credentials.workerJwt,
        initialSequenceNum: initialSequence,
        fetchImpl: deps.fetchImpl,
      }, {
        state: deps.state,
        worker,
        inbound: {
          stateRoot: deps.stateRoot,
          baseUrl: inboundConfig?.baseUrl,
          token: inboundConfig?.token,
          fetchImpl: deps.fetchImpl,
          onResolved: async resolved => { await deps.dispatchInbound({ ...body, bridgeSessionId: codeSessionId }, resolved) },
        },
      }, {
        onEvent: event => { void deps.projectEvent(body, event.payload) },
        onClose: code => {
          streams.delete(codeSessionId)
          if (code === 401 || code === 403) {
            void recoverStreamAuth(codeSessionId, code).catch(err => {
              closeRuntime(codeSessionId, { cancelRefresh: true })
              void deps.peers.updateStatus(codeSessionId, 'error', err instanceof Error ? err.message : String(err)).catch(() => undefined)
            })
          }
        },
      })
      streams.set(codeSessionId, stream)
      stream.connect()
    }
    await deps.peers.register({ sessionId: codeSessionId, status: 'connected', inboundEnabled: true })
    return { worker, initialized, stream: streams.get(codeSessionId) ?? null, streamEnabled: shouldStream, initialSequence }
  }

  async function handle(url: URL, req: Request): Promise<Response | null> {
    const workerMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/code-sessions\/([^/]+)\/worker$/)
    if (workerMatch) {
      const codeSessionId = codeSessionIdFrom(decodeURIComponent(workerMatch[1]!))
      try {
        if (req.method === 'GET') {
          const worker = workers.get(codeSessionId)
          const stream = streams.get(codeSessionId)
          return Response.json({
            sessionId: codeSessionId,
            connected: !!worker,
            workerEpoch: worker?.getWorkerEpoch(),
            stream: stream ? { state: stream.getState(), lastSequenceNum: stream.getLastSequenceNum() } : null,
            refresh: refreshStatus(codeSessionId),
          })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const credentials = await deps.state.getCredentials(codeSessionId)
          if (!credentials) return jsonError('bridge credentials not found', 404)
          const started = await startWorker(codeSessionId, credentials, body)
          return Response.json({
            ok: true,
            sessionId: codeSessionId,
            workerEpoch: started.worker.getWorkerEpoch(),
            initStatus: started.initialized.status,
            stream: started.streamEnabled,
            initialSequenceNum: started.initialSequence,
          })
        }
        if (req.method === 'DELETE') {
          closeRuntime(codeSessionId, { cancelRefresh: true })
          await deps.peers.updateStatus(codeSessionId, 'outbound_only').catch(() => undefined)
          return Response.json({ ok: true, sessionId: codeSessionId })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

    const actionMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/code-sessions\/([^/]+)\/worker\/(event|internal-event|state|metadata|delivery|heartbeat|flush|refresh)$/)
    if (!actionMatch) return null
    const codeSessionId = codeSessionIdFrom(decodeURIComponent(actionMatch[1]!))
    const action = actionMatch[2]!
    try {
      if (action === 'refresh') {
        if (req.method !== 'POST') return methodNotAllowed()
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const refreshed = await refreshCredentialsAndTransport(codeSessionId, body, 'manual_refresh', true)
        return Response.json({
          ok: true,
          sessionId: codeSessionId,
          workerEpoch: refreshed.started.worker.getWorkerEpoch(),
          refreshStatus: refreshed.status,
          initStatus: refreshed.started.initialized.status,
          stream: refreshed.started.streamEnabled,
          initialSequenceNum: refreshed.started.initialSequence,
          refresh: refreshStatus(codeSessionId),
        })
      }
      const worker = workers.get(codeSessionId)
      if (!worker) return jsonError('bridge worker is not connected', 409)
      if (action === 'heartbeat') {
        if (req.method !== 'POST') return methodNotAllowed()
        const result = await worker.sendHeartbeatNow()
        if (!result.ok) return jsonError(result.error || `heartbeat failed ${result.status ?? ''}`.trim(), result.status ?? 502)
        return Response.json({ ok: true, status: result.status })
      }
      if (action === 'flush') {
        if (req.method !== 'POST') return methodNotAllowed()
        await worker.flush()
        return Response.json({ ok: true })
      }
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (action === 'event') {
        if (req.method !== 'POST') return methodNotAllowed()
        const event = isRecord(body.event) ? body.event : body
        if (typeof event.type !== 'string') return jsonError('event.type required', 400)
        await worker.writeEvent(event as Record<string, unknown> & { type: string })
        return Response.json({ ok: true })
      }
      if (action === 'internal-event') {
        if (req.method !== 'POST') return methodNotAllowed()
        const eventType = stringOr(body.eventType ?? body.event_type ?? body.type, '')
        const payload = isRecord(body.payload) ? body.payload : {}
        if (!eventType) return jsonError('eventType required', 400)
        await worker.writeInternalEvent(eventType, payload, {
          isCompaction: body.isCompaction === true || body.is_compaction === true,
          agentId: stringOr(body.agentId ?? body.agent_id, '') || undefined,
        })
        return Response.json({ ok: true })
      }
      if (action === 'state') {
        if (req.method !== 'POST') return methodNotAllowed()
        const state = bridgeWorkerSessionStateFrom(body.state ?? body.worker_status)
        if (!state) return jsonError('state required', 400)
        worker.reportState(state, isRecord(body.details) ? {
          tool_name: stringOr(body.details.tool_name ?? body.details.toolName, ''),
          action_description: stringOr(body.details.action_description ?? body.details.actionDescription, ''),
          tool_use_id: stringOr(body.details.tool_use_id ?? body.details.toolUseId, ''),
          request_id: stringOr(body.details.request_id ?? body.details.requestId, ''),
          input: isRecord(body.details.input) ? body.details.input : undefined,
        } : undefined)
        return Response.json({ ok: true })
      }
      if (action === 'metadata') {
        if (req.method !== 'POST') return methodNotAllowed()
        worker.reportMetadata(isRecord(body.metadata) ? body.metadata : body)
        return Response.json({ ok: true })
      }
      if (action === 'delivery') {
        if (req.method !== 'POST') return methodNotAllowed()
        const eventId = stringOr(body.eventId ?? body.event_id, '')
        const status = body.status === 'received' || body.status === 'processing' || body.status === 'processed' ? body.status : undefined
        if (!eventId || !status) return jsonError('eventId and status required', 400)
        worker.reportDelivery(eventId, status)
        return Response.json({ ok: true })
      }
      return methodNotAllowed()
    } catch (err) {
      return routeError(err)
    }
  }

  return {
    handle,
    close() {
      for (const scheduler of refreshSchedulers.values()) scheduler.cancel()
      refreshSchedulers.clear()
      for (const stream of streams.values()) stream.close()
      streams.clear()
      for (const worker of workers.values()) worker.close()
      workers.clear()
    },
  }
}
