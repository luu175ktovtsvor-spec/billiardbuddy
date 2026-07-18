/**
 * Diagnostics incident intake API.
 *
 * The ordinary product never exposes captured diagnostics, raw logs, or
 * export/cleanup controls. The renderer may only record a bounded incident
 * category for automatic recovery diagnostics.
 */

import { diagnosticsService } from '../services/diagnosticsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

export async function handleDiagnosticsApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const action = segments[2]

    if (action === 'events' && req.method === 'POST') {
      const body = await parseJsonBody(req)
      // Never accept renderer-controlled summaries, request data, session ids,
      // or exception details. The client may report only a bounded incident type
      // and severity; the service derives the safe stored summary/category.
      await diagnosticsService.recordClientEvent({
        type: body.type,
        severity: body.severity,
      })
      return Response.json({ ok: true })
    }

    throw new ApiError(404, `Unknown diagnostics endpoint: ${action ?? '(root)'}`, 'NOT_FOUND')
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' ? body as Record<string, unknown> : {}
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}
