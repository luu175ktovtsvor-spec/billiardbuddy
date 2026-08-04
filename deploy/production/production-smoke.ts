const gatewayBase = (process.env.PRODUCTION_SMOKE_GATEWAY_BASE_URL ?? 'https://zzyppz.cn/gw').replace(/\/+$/, '')
if (process.env.BILLIARDBUDDY_PRODUCTION_SMOKE_CONFIRMATION !== 'ONE_TEXT_ONE_IMAGE_FOUR_VIDEO_OPERATIONS') {
  throw new Error('BILLIARDBUDDY_PRODUCTION_SMOKE_CONFIRMATION must be ONE_TEXT_ONE_IMAGE_FOUR_VIDEO_OPERATIONS')
}
if (new URL(gatewayBase).protocol !== 'https:') throw new Error('PRODUCTION_SMOKE_GATEWAY_BASE_URL must use HTTPS')

type Session = { access_token?: unknown; refresh_token?: unknown }
// Auth bootstrap intentionally keeps one durable installation registration
// after its session is logged out. Reuse one operational identity so repeated
// releases rotate a single session instead of accumulating unbounded synthetic
// registrations in the production authority database.
const installationId = 'deployment-smoke-production'
const bootstrap = await fetch(`${gatewayBase}/v1/auth/bootstrap`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ installation_id: installationId }),
  signal: AbortSignal.timeout(30_000),
})
if (!bootstrap.ok) throw new Error(`production smoke session bootstrap failed with ${bootstrap.status}`)
const session = await bootstrap.json() as Session
if (typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string') {
  throw new Error('production smoke session bootstrap omitted credentials')
}

let primaryError: unknown
try {
  Object.assign(process.env, {
    GATEWAY_SMOKE_BASE_URL: gatewayBase,
    GATEWAY_SMOKE_ACCESS_TOKEN: session.access_token,
    GATEWAY_SMOKE_CONFIRMATION: 'ONE_BILLED_TEXT_RESPONSE',
    GATEWAY_SMOKE_MAX_TASKS: '1',
    IMAGE_RELAY_SMOKE_BASE_URL: process.env.PRODUCTION_SMOKE_IMAGE_BASE_URL ?? 'https://zzyppz.cn/image-generation',
    IMAGE_RELAY_SMOKE_ACCESS_TOKEN: session.access_token,
    IMAGE_RELAY_SMOKE_CONFIRMATION: 'ONE_BILLED_IMAGE_TASK',
    IMAGE_RELAY_SMOKE_MAX_TASKS: '1',
    VIDEO_MEDIA_SMOKE_BASE_URL: process.env.PRODUCTION_SMOKE_VIDEO_BASE_URL ?? 'https://zzyppz.cn/video-media',
    VIDEO_MEDIA_SMOKE_ACCESS_TOKEN: session.access_token,
    VIDEO_MEDIA_SMOKE_CONFIRMATION: 'FOUR_BILLED_VIDEO_OPERATIONS',
    VIDEO_MEDIA_SMOKE_MAX_PROVIDER_OPERATIONS: '4',
  })
  await import('./gateway-smoke.ts')
  await import('./image-relay-smoke.ts')
  await import('./video-media-smoke.ts')
} catch (error) {
  primaryError = error
} finally {
  for (const name of [
    'GATEWAY_SMOKE_ACCESS_TOKEN', 'GATEWAY_SMOKE_CONFIRMATION', 'GATEWAY_SMOKE_MAX_TASKS',
    'IMAGE_RELAY_SMOKE_ACCESS_TOKEN', 'IMAGE_RELAY_SMOKE_CONFIRMATION', 'IMAGE_RELAY_SMOKE_MAX_TASKS',
    'VIDEO_MEDIA_SMOKE_ACCESS_TOKEN', 'VIDEO_MEDIA_SMOKE_CONFIRMATION', 'VIDEO_MEDIA_SMOKE_MAX_PROVIDER_OPERATIONS',
  ]) delete process.env[name]
}

let logoutError: unknown
try {
  const logout = await fetch(`${gatewayBase}/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
    signal: AbortSignal.timeout(30_000),
  })
  if (logout.status !== 204) throw new Error(`production smoke session logout failed with ${logout.status}`)
} catch (error) { logoutError = error }

if (primaryError && logoutError) throw new AggregateError([primaryError, logoutError], 'production smoke and session cleanup both failed')
if (primaryError) throw primaryError
if (logoutError) throw logoutError
console.log('BILLIARDBUDDY_PRODUCTION_SMOKE_OK')
