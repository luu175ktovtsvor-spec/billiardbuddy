/**
 * Authentication middleware
 *
 * 本地桌面应用的可选 bearer 鉴权。此令牌只保护 Product Server，
 * 与模型供应商凭据完全分离。
 */

type AuthResult = { valid: boolean; error?: string }

function parseBearerToken(authHeader: string | null): AuthResult & { token?: string } {
  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' }
  }

  const [scheme, token] = authHeader.split(' ')

  if (scheme !== 'Bearer' || !token) {
    return { valid: false, error: 'Invalid Authorization format. Use: Bearer <token>' }
  }

  return { valid: true, token }
}

export function validateAuth(req: Request): AuthResult {
  const parsedAuth = parseBearerToken(req.headers.get('Authorization'))
  if (!parsedAuth.valid || !parsedAuth.token) {
    return parsedAuth
  }

  return validateApiKey(parsedAuth.token)
}

function validateApiKey(token: string): AuthResult {
  const apiKey = process.env.BILLIARDBUDDY_SERVER_TOKEN
  if (!apiKey) {
    return { valid: false, error: 'BilliardBuddy server token is not configured' }
  }

  if (token !== apiKey) {
    return { valid: false, error: 'Invalid API key' }
  }

  return { valid: true }
}

/**
 * Helper to check auth and return 401 if invalid
 */
export async function validateRequestAuth(
  req: Request,
  tokenOverride?: string | null,
): Promise<AuthResult> {
  if (tokenOverride) {
    return validateApiKey(tokenOverride)
  }

  return validateAuth(req)
}

export async function requireAuth(req: Request, tokenOverride?: string | null): Promise<Response | null> {
  const { valid, error } = await validateRequestAuth(req, tokenOverride)
  if (!valid) {
    return Response.json({ error: 'Unauthorized', message: error }, { status: 401 })
  }
  return null
}
