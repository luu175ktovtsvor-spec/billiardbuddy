import {
  DEFAULT_GRANT_FLAGS,
  type AppGrant,
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
