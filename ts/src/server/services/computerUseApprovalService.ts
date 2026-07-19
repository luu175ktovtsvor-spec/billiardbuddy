import {
  DEFAULT_GRANT_FLAGS,
  type AppGrant,
  type CuGrantFlags,
  type CuPermissionRequest,
  type CuPermissionResponse,
} from '../../vendor/computer-use-mcp/types.js'
import { sendToSession } from '../ws/handler.js'
import type { ComputerUsePermissionRequest } from '../ws/events.js'

type PendingApproval = {
  sessionId: string
  request: CuPermissionRequest
  resolve: (response: CuPermissionResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const GRANT_FLAG_KEYS = [
  'clipboardRead',
  'clipboardWrite',
  'systemKeyCombos',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deniedResponse(): CuPermissionResponse {
  return {
    granted: [],
    denied: [],
    flags: { ...DEFAULT_GRANT_FLAGS },
    userConsented: false,
  }
}

/**
 * Product task clients can only make a single allow/deny decision. Build the
 * complete Computer Use response from the server-owned pending request so a
 * browser cannot add an application, alter a tier, or enable an unrequested
 * capability.
 */
function approvedProductTaskResponse(request: CuPermissionRequest): CuPermissionResponse {
  const granted: AppGrant[] = []
  const grantedBundleIds = new Set<string>()
  for (const app of request.apps) {
    const resolved = app.resolved
    if (!resolved || grantedBundleIds.has(resolved.bundleId)) continue
    grantedBundleIds.add(resolved.bundleId)
    granted.push({
      bundleId: resolved.bundleId,
      displayName: resolved.displayName,
      grantedAt: Date.now(),
      tier: app.proposedTier,
    })
  }

  return {
    granted,
    // Unresolved applications never become grants. There is no need to echo
    // model-provided selectors back into this internal response either.
    denied: [],
    flags: {
      clipboardRead: request.requestedFlags.clipboardRead === true,
      clipboardWrite: request.requestedFlags.clipboardWrite === true,
      systemKeyCombos: request.requestedFlags.systemKeyCombos === true,
    },
    userConsented: true,
  }
}

/**
 * The Agent-side request carries local application paths and icon payloads for
 * the executor. The desktop approval dialog only needs a stable app identity,
 * so keep those implementation details on the server with the pending request.
 */
function projectPermissionRequestForDesktop(
  request: CuPermissionRequest,
): ComputerUsePermissionRequest {
  return {
    requestId: request.requestId,
    reason: 'Computer Use needs permission to continue this task.',
    apps: request.apps.map(app => ({
      requestedName: app.requestedName,
      ...(app.resolved
        ? {
            resolved: {
              bundleId: app.resolved.bundleId,
              displayName: app.resolved.displayName,
            },
          }
        : {}),
      isSentinel: app.isSentinel,
      alreadyGranted: app.alreadyGranted,
      proposedTier: app.proposedTier,
    })),
    requestedFlags: request.requestedFlags,
    screenshotFiltering: request.screenshotFiltering,
    ...(request.tccState ? { tccState: request.tccState } : {}),
    ...(request.willHide
      ? {
          willHide: request.willHide,
        }
      : {}),
    ...(request.autoUnhideEnabled === undefined
      ? {}
      : { autoUnhideEnabled: request.autoUnhideEnabled }),
  }
}

/**
 * The WebSocket carries untrusted JSON. Only send grants back to the tool
 * process when every privilege was present in the pending, task-bound request.
 */
function normalizeApprovalResponse(
  request: CuPermissionRequest,
  response: CuPermissionResponse,
): CuPermissionResponse | null {
  const raw = response as unknown
  if (!isRecord(raw) || !Array.isArray(raw.granted) || !isRecord(raw.flags)) {
    return null
  }

  const requestedApps = new Map(
    request.apps
      .filter((app): app is typeof app & { resolved: NonNullable<typeof app.resolved> } => (
        app.resolved !== undefined
      ))
      .map(app => [app.resolved.bundleId, app]),
  )
  const granted: AppGrant[] = []
  const grantedBundleIds = new Set<string>()

  for (const candidate of raw.granted) {
    if (!isRecord(candidate) || typeof candidate.bundleId !== 'string') return null
    const requested = requestedApps.get(candidate.bundleId)
    if (!requested || grantedBundleIds.has(candidate.bundleId)) return null

    grantedBundleIds.add(candidate.bundleId)
    granted.push({
      bundleId: requested.resolved.bundleId,
      displayName: requested.resolved.displayName,
      grantedAt: Date.now(),
      tier: requested.proposedTier,
    })
  }

  const flags = {} as CuGrantFlags
  for (const key of GRANT_FLAG_KEYS) {
    const value = raw.flags[key]
    if (typeof value !== 'boolean') return null
    if (value && request.requestedFlags[key] !== true) return null
    flags[key] = value && request.requestedFlags[key] === true
  }

  const userConsented = raw.userConsented
  if (userConsented !== undefined && typeof userConsented !== 'boolean') return null
  if (userConsented === false && (granted.length > 0 || GRANT_FLAG_KEYS.some(key => flags[key]))) {
    return null
  }

  const denyableBundleIds = new Set(
    request.apps.map(app => app.resolved?.bundleId ?? app.requestedName),
  )
  const denied = Array.isArray(raw.denied)
    ? raw.denied.flatMap(candidate => {
        if (!isRecord(candidate) || typeof candidate.bundleId !== 'string') return []
        if (!denyableBundleIds.has(candidate.bundleId)) return []
        if (candidate.reason !== 'user_denied' && candidate.reason !== 'not_installed') return []
        return [{ bundleId: candidate.bundleId, reason: candidate.reason }]
      })
    : []

  return { granted, denied, flags, ...(userConsented === undefined ? {} : { userConsented }) }
}

export class ComputerUseApprovalService {
  private pending = new Map<string, PendingApproval>()

  constructor(
    private readonly send = sendToSession,
  ) {}

  async requestApproval(
    sessionId: string,
    request: CuPermissionRequest,
  ): Promise<CuPermissionResponse> {
    const existing = this.pending.get(request.requestId)
    if (existing) {
      clearTimeout(existing.timeout)
      existing.reject(new Error('Computer Use approval request superseded'))
      this.pending.delete(request.requestId)
    }

    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('Computer Use approval timed out'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(request.requestId, {
        sessionId,
        request,
        resolve,
        reject,
        timeout,
      })

      const desktopRequest = projectPermissionRequestForDesktop(request)
      const sent = this.send(sessionId, {
        type: 'computer_use_permission_request',
        requestId: request.requestId,
        request: desktopRequest,
      })

      if (!sent) {
        clearTimeout(timeout)
        this.pending.delete(request.requestId)
        reject(new Error('Desktop session is not connected'))
      }
    })
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    response: CuPermissionResponse,
  ): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.sessionId !== sessionId) return false
    clearTimeout(pending.timeout)
    this.pending.delete(requestId)
    const normalized = normalizeApprovalResponse(pending.request, response)
    pending.resolve(normalized ?? deniedResponse())
    return normalized !== null
  }

  /**
   * Resolve a product task Computer Use prompt without accepting a raw grant
   * payload from the browser. The pending request remains the sole authority
   * for its task/session binding and all granted capabilities.
   */
  resolveProductTaskApproval(
    sessionId: string,
    requestId: string,
    allowed: boolean,
  ): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.sessionId !== sessionId) return false

    clearTimeout(pending.timeout)
    this.pending.delete(requestId)
    pending.resolve(allowed ? approvedProductTaskResponse(pending.request) : deniedResponse())
    return true
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timeout)
      this.pending.delete(requestId)
      pending.reject(new Error('Desktop session disconnected during Computer Use approval'))
    }
  }
}

export const computerUseApprovalService = new ComputerUseApprovalService()
