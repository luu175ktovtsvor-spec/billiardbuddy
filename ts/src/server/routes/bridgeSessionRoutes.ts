// Remote Bridge 会话数据面：事件、入站消息、权限、outbox 与 subscriber 生命周期。

import type { FetchLike } from '../../proxy/ProxyModel'
import { createBridgeCodeSessionClient } from '../../tasks/bridgeCodeSessionClient'
import type { BridgePeerRegistry } from '../../tasks/bridgePeerRegistry'
import { resolveInboundUserMessage, type BridgeResolvedInboundMessage } from '../../tasks/bridgeInboundMessages'
import type { BridgeRemoteState } from '../../tasks/bridgeRemoteState'
import { BridgeRemoteSubscriber, type BridgeRemoteWebSocketConstructor } from '../../tasks/bridgeRemoteSubscriber'
import { createBridgeRemoteTransport } from '../../tasks/bridgeRemoteTransport'
import {
  bridgeOutboxStatusFrom,
  bridgeCodeSessionConfigFromBody,
  bridgePermissionResponseFrom,
  bridgePermissionStatusFrom,
  bridgeRemoteConfigFromBody,
} from '../bridgeParams'
import { jsonError } from '../middleware/http'
import { providerStatusFor } from '../providerRuntime'
import { isRecord, numberFrom, stringArray, stringOr } from '../requestParams'

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
    if (url.pathname === '/api/v1/agent/bridge/peers') {
      try {
        if (req.method === 'GET') return Response.json({ peers: await deps.peers.list() })
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json({
            peer: await deps.peers.register({
              sessionId: stringOr(body.sessionId ?? body.session_id, ''),
              label: typeof body.label === 'string' ? body.label : undefined,
              workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : typeof body.workspace_root === 'string' ? body.workspace_root : undefined,
              machineName: typeof body.machineName === 'string' ? body.machineName : typeof body.machine_name === 'string' ? body.machine_name : undefined,
              status: body.status === 'connected' || body.status === 'connecting' || body.status === 'disconnected' || body.status === 'outbound_only' || body.status === 'error' ? body.status : undefined,
              inboundEnabled: typeof body.inboundEnabled === 'boolean' ? body.inboundEnabled : typeof body.inbound_enabled === 'boolean' ? body.inbound_enabled : undefined,
              lastError: typeof body.lastError === 'string' ? body.lastError : typeof body.last_error === 'string' ? body.last_error : undefined,
            }),
          }, { status: 201 })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

    const peerMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/peers\/([^/]+)$/)
    if (peerMatch) {
      const sessionId = decodeURIComponent(peerMatch[1]!)
      try {
        if (req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const status = body.status === 'connected' || body.status === 'connecting' || body.status === 'disconnected' || body.status === 'outbound_only' || body.status === 'error'
            ? body.status
            : undefined
          if (!status) return jsonError('status required', 400)
          const peer = await deps.peers.updateStatus(sessionId, status, typeof body.lastError === 'string' ? body.lastError : typeof body.last_error === 'string' ? body.last_error : undefined)
          if (!peer) return jsonError('bridge peer not found', 404)
          return Response.json({ peer })
        }
        if (req.method === 'DELETE') {
          await deps.peers.unregister(sessionId)
          return Response.json({ ok: true })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

    if (url.pathname === '/api/v1/agent/bridge/code-sessions') {
      try {
        if (req.method !== 'POST') return methodNotAllowed()
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const config = bridgeCodeSessionConfigFromBody(body, env)
        if (!config) return jsonError('bridge code session client is not configured', 400)
        const title = stringOr(body.title, 'Desktop Coding Agent Session')
        const client = createBridgeCodeSessionClient({ ...config, fetchImpl: deps.fetchImpl })
        const created = await client.createCodeSession({ title, tags: stringArray(body.tags) })
        if (!created.ok) return jsonError(created.error, created.status ?? 502)
        await deps.peers.register({ sessionId: created.value, label: title, status: 'outbound_only', inboundEnabled: false })
        return Response.json({ ok: true, sessionId: created.value, status: created.status })
      } catch (err) {
        return routeError(err)
      }
    }

    const credentialsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/code-sessions\/([^/]+)\/credentials$/)
    if (credentialsMatch) {
      const sessionId = decodeURIComponent(credentialsMatch[1]!)
      const codeSessionId = sessionId.startsWith('bridge:') ? sessionId.slice('bridge:'.length) : sessionId
      try {
        if (req.method === 'GET') {
          const credentials = await deps.state.getCredentials(sessionId)
          if (!credentials) return jsonError('bridge credentials not found', 404)
          return Response.json({ credentials })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const config = bridgeCodeSessionConfigFromBody(body, env)
          if (!config) return jsonError('bridge code session client is not configured', 400)
          const trustedDeviceToken = stringOr(body.trustedDeviceToken ?? body.trusted_device_token, '')
          const client = createBridgeCodeSessionClient({ ...config, fetchImpl: deps.fetchImpl })
          const fetched = await client.fetchRemoteCredentials(codeSessionId, trustedDeviceToken || undefined)
          if (!fetched.ok) return jsonError(fetched.error, fetched.status ?? 502)
          const credentials = await deps.state.storeCredentials(codeSessionId, fetched.value)
          await deps.peers.register({ sessionId: codeSessionId, status: 'outbound_only', inboundEnabled: false })
          return Response.json({ ok: true, sessionId: codeSessionId, credentials, status: fetched.status })
        }
        return methodNotAllowed()
      } catch (err) {
        return routeError(err)
      }
    }

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
