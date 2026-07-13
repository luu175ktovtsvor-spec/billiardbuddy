// Remote Bridge 会话数据面：事件、入站消息、权限、outbox 与 subscriber 生命周期。

import type { FetchLike } from '../../proxy/ProxyModel'
import type { BridgePeerRegistry } from '../../tasks/bridgePeerRegistry'
import { resolveInboundUserMessage, type BridgeResolvedInboundMessage } from '../../tasks/bridgeInboundMessages'
import type { BridgeRemoteState } from '../../tasks/bridgeRemoteState'
import { BridgeRemoteSubscriber, type BridgeRemoteWebSocketConstructor } from '../../tasks/bridgeRemoteSubscriber'
import { createBridgeRemoteTransport } from '../../tasks/bridgeRemoteTransport'
import {
  bridgeOutboxStatusFrom,
  bridgePermissionResponseFrom,
  bridgePermissionStatusFrom,
  bridgeRemoteConfigFromBody,
} from '../bridgeParams'
import { jsonError } from '../middleware/http'
import { providerStatusFor } from '../providerRuntime'
import { isRecord, numberFrom } from '../requestParams'

interface BridgeSessionRouteDependencies {
  state: BridgeRemoteState
  peers: BridgePeerRegistry
  stateRoot: string
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  WebSocketCtor?: BridgeRemoteWebSocketConstructor
  dispatchInbound: (body: Record<string, unknown>, resolved: BridgeResolvedInboundMessage) => Promise<unknown>
  projectEvent: (body: Record<string, unknown>, payload: Record<string, unknown>) => Promise<void>
}

export interface BridgeSessionRouteController {
  handle(url: URL, req: Request): Promise<Response | null>
  close(): void
}

function methodNotAllowed(): Response {
  return new Response('Method not allowed', { status: 405 })
}

function routeError(err: unknown): Response {
  return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
}

export function createBridgeSessionRouteController(deps: BridgeSessionRouteDependencies): BridgeSessionRouteController {
  const subscribers = new Map<string, BridgeRemoteSubscriber>()
  const env = deps.env ?? process.env

  async function handle(url: URL, req: Request): Promise<Response | null> {
    const eventsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/events$/)
    if (eventsMatch) {
      const sessionId = decodeURIComponent(eventsMatch[1]!)
      try {
        if (req.method === 'GET') {
          return Response.json({
            events: await deps.state.listEvents(sessionId, {
              after: numberFrom(url.searchParams.get('after'), 0),
              limit: numberFrom(url.searchParams.get('limit'), 100),
            }),
          })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const event = isRecord(body.event) ? body.event : body
          return Response.json(await deps.state.ingestEvent(sessionId, event), { status: 201 })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

    const inboundMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/inbound(?:\/resolve)?$/)
    if (inboundMatch) {
      const sessionId = decodeURIComponent(inboundMatch[1]!)
      try {
        if (req.method === 'GET') {
          return Response.json({
            messages: await deps.state.listInboundMessages(sessionId, {
              after: numberFrom(url.searchParams.get('after'), 0),
              limit: numberFrom(url.searchParams.get('limit'), 100),
            }),
          })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const event = isRecord(body.event) ? body.event : isRecord(body.message) ? body.message : body
          const config = bridgeRemoteConfigFromBody(body, env)
          const resolved = await resolveInboundUserMessage(event, {
            sessionId,
            stateRoot: deps.stateRoot,
            baseUrl: config?.baseUrl,
            token: config?.token,
            fetchImpl: deps.fetchImpl,
          })
          if (!resolved) return jsonError('inbound user message content not found', 400)
          const record = body.store !== false ? await deps.state.storeInboundMessage(sessionId, resolved) : undefined
          const dispatch = body.autoRun === true || body.auto_run === true || body.conversationId || body.conversation_id
            ? await deps.dispatchInbound({ ...body, bridgeSessionId: sessionId }, resolved)
            : undefined
          return Response.json({ resolved, ...(record ? { message: record } : {}), ...(dispatch ? { dispatch } : {}) }, { status: 201 })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

    const permissionsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/permissions$/)
    if (permissionsMatch) {
      const sessionId = decodeURIComponent(permissionsMatch[1]!)
      try {
        if (req.method !== 'GET') return methodNotAllowed()
        return Response.json({ permissions: await deps.state.listPermissions(sessionId, bridgePermissionStatusFrom(url.searchParams.get('status'))) })
      } catch (err) {
        return routeError(err)
      }
    }

    const permissionRespondMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/permissions\/([^/]+)\/respond$/)
    if (permissionRespondMatch) {
      const sessionId = decodeURIComponent(permissionRespondMatch[1]!)
      const requestId = decodeURIComponent(permissionRespondMatch[2]!)
      try {
        if (req.method !== 'POST') return methodNotAllowed()
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const result = await deps.state.respondToPermission(sessionId, requestId, bridgePermissionResponseFrom(body))
        if (!result) return jsonError('bridge permission request not found', 404)
        return Response.json(result)
      } catch (err) {
        return routeError(err)
      }
    }

    const outboxMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox$/)
    if (outboxMatch) {
      const sessionId = decodeURIComponent(outboxMatch[1]!)
      try {
        if (req.method !== 'GET') return methodNotAllowed()
        return Response.json({ outbox: await deps.state.listOutbox(sessionId, bridgeOutboxStatusFrom(url.searchParams.get('status'))) })
      } catch (err) {
        return routeError(err)
      }
    }

    const outboxSentMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox\/([^/]+)\/sent$/)
    if (outboxSentMatch) {
      const sessionId = decodeURIComponent(outboxSentMatch[1]!)
      const outboxId = decodeURIComponent(outboxSentMatch[2]!)
      try {
        if (req.method !== 'POST') return methodNotAllowed()
        const item = await deps.state.markOutboxSent(sessionId, outboxId)
        if (!item) return jsonError('bridge outbox item not found', 404)
        return Response.json({ outbox: item })
      } catch (err) {
        return routeError(err)
      }
    }

    const outboxFlushMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox\/flush$/)
    if (outboxFlushMatch) {
      const sessionId = decodeURIComponent(outboxFlushMatch[1]!)
      try {
        if (req.method !== 'POST') return methodNotAllowed()
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const config = bridgeRemoteConfigFromBody(body, env)
        if (!config) return jsonError('bridge remote transport is not configured', 400)
        const transport = createBridgeRemoteTransport({ ...config, fetchImpl: deps.fetchImpl })
        const queued = await deps.state.listOutbox(sessionId, 'queued')
        const results: Array<Record<string, unknown>> = []
        for (const item of queued) {
          const sent = await transport.sendOutboxItem(item)
          if (sent.ok) {
            const marked = await deps.state.markOutboxSent(sessionId, item.id)
            results.push({ id: item.id, requestId: item.requestId, ok: true, status: sent.status, outbox: marked })
          } else {
            results.push({ id: item.id, requestId: item.requestId, ok: false, status: sent.status, error: sent.error })
          }
        }
        return Response.json({ ok: results.every(item => item.ok === true), flushed: results.filter(item => item.ok === true).length, total: results.length, results })
      } catch (err) {
        return routeError(err)
      }
    }

    if (url.pathname === '/api/v1/agent/bridge/subscribers') {
      if (req.method !== 'GET') return methodNotAllowed()
      return Response.json({
        subscribers: [...subscribers.entries()].map(([sessionId, subscriber]) => ({
          sessionId,
          connected: subscriber.isConnected(),
        })),
      })
    }

    const subscribeMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/subscribe$/)
    if (subscribeMatch) {
      const sessionId = decodeURIComponent(subscribeMatch[1]!)
      try {
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const config = bridgeRemoteConfigFromBody(body, env)
          if (!config) return jsonError('bridge remote subscriber is not configured', 400)
          subscribers.get(sessionId)?.close()
          const subscriber = new BridgeRemoteSubscriber(sessionId, {
            baseUrl: config.baseUrl,
            token: config.token,
            orgUuid: config.orgUuid,
            WebSocketCtor: deps.WebSocketCtor,
          }, {
            state: deps.state,
            peers: deps.peers,
            inbound: {
              stateRoot: deps.stateRoot,
              fetchImpl: deps.fetchImpl,
              onResolved: async resolved => { await deps.dispatchInbound({ ...body, bridgeSessionId: sessionId }, resolved) },
            },
            onEvent: async payload => { await deps.projectEvent(body, payload) },
          })
          subscribers.set(sessionId, subscriber)
          subscriber.connect()
          return Response.json({ ok: true, sessionId, connected: subscriber.isConnected() })
        }
        if (req.method === 'DELETE') {
          subscribers.get(sessionId)?.close()
          subscribers.delete(sessionId)
          return Response.json({ ok: true, sessionId })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

    return null
  }

  return {
    handle,
    close() {
      for (const subscriber of subscribers.values()) subscriber.close()
      subscribers.clear()
    },
  }
}
