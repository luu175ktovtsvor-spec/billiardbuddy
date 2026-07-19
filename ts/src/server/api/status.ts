/**
 * Status REST API
 *
 * GET /api/status              — 健康检查
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'

// 服务器启动时间（用于计算 uptime）
const startedAt = Date.now()

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleStatusApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (req.method !== 'GET') {
      throw new ApiError(405, `Method ${req.method} not allowed`, 'METHOD_NOT_ALLOWED')
    }

    if (segments[2] === undefined) return handleHealthCheck()

    throw ApiError.notFound(`Unknown status endpoint: ${segments[2]}`)
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleHealthCheck(): Response {
  return Response.json({
    status: 'ok',
    version: getVersion(),
    uptime: Date.now() - startedAt,
  })
}

function getVersion(): string {
  // 从 package.json 的 version 字段读取；回退到环境变量或 unknown
  return process.env.APP_VERSION || '999.0.0-local'
}
