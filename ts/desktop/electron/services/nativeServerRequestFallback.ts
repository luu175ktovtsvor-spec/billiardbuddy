import type { CodexNativeJsonObject, CodexNativeServerRequest } from './codexNativeAppServer'

/**
 * The frozen Renderer can presently present only command/file approvals. The
 * source App Server also has several interactive request forms. Until their
 * native UI is productized, answer them with valid source-protocol failures
 * instead of returning JSON-RPC errors that can leave Core waiting or make an
 * implicit permission decision.
 *
 * This is deliberately not a second permission engine: no requested profile
 * is inspected, persisted, or widened here. A later Renderer can replace the
 * fallback by presenting the same server request and returning the user's
 * source-shaped response through Main.
 */
export function nativeServerRequestSafeFallback(
  request: Pick<CodexNativeServerRequest, 'method'>,
): CodexNativeJsonObject | undefined {
  switch (request.method) {
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn', strictAutoReview: false }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      // The pinned App Server schema keeps nullable `content` and `_meta`
      // fields even for a cancellation. Return the complete source-shaped
      // response, rather than relying on serde's optional-field behavior.
      return { action: 'cancel', content: null, _meta: null }
    case 'item/tool/call':
      return { contentItems: [], success: false }
    default:
      return undefined
  }
}
