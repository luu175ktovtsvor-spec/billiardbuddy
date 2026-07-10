/**
 * HTTP 横切中间件(从 server/index.ts 抽出,行为零变化;对齐第三批 P5"抽 CORS/错误中间件到
 * server/middleware/"的分层口径):本地回环 CORS、统一 JSON 错误体、turn 装配阶段的带状态码错误。
 */

/** 只放行本机回环来源(127.0.0.1/localhost/[::1])的 Origin;其余一律不发 CORS 头(安全边界)。 */
export function localCorsOrigin(req: Request): string | undefined {
  const origin = req.headers.get('origin')
  if (!origin) return undefined
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1') {
      return origin
    }
  } catch {
    return undefined
  }
  return undefined
}

export function withLocalCors(res: Response, req: Request): Response {
  const origin = localCorsOrigin(req)
  if (!origin) return res
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.append('Vary', 'Origin')
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export function localCorsPreflight(req: Request): Response | undefined {
  const origin = localCorsOrigin(req)
  if (!origin || req.method !== 'OPTIONS') return undefined
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': req.headers.get('access-control-request-headers') || 'content-type,authorization',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    },
  })
}

export function jsonError(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status })
}

export function jsonDetailError(message: string, status = 400): Response {
  return Response.json({ ok: false, detail: message, error: message }, { status })
}

/** turn 装配阶段(createTurnStream 等)的带 HTTP 状态码错误,路由层 catch 后转 jsonError。 */
export class TurnSetupError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}
