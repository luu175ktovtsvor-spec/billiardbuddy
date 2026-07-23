/**
 * QF Gateway Provider — product-managed provider routed through our gateway.
 *
 * The gateway is configured entirely from process.env (QF_GATEWAY_URL / QF_GATEWAY_TOKEN)
 * and its registry-owned TextReasoning model, so the desktop/server cannot select an upstream.
 *
 * Credential boundary:
 *  - The short-lived installation access bearer lives ONLY in process.env
 *    (QF_GATEWAY_TOKEN). It is overlaid onto the proxy target at request time
 *    (resolveQfGatewayProxyTarget) inside getProviderForProxy — it is NEVER written
 *    to providers.json, never synced to settings.json, and never handed to the CLI subprocess.
 *  - The synthetic SavedProvider carries an empty apiKey placeholder. Because
 *    apiFormat is 'openai_chat', the managed env the CLI receives is only
 *    ANTHROPIC_API_KEY='proxy-managed' + ANTHROPIC_BASE_URL=<local proxy>.
 *  - The gateway is synthetic (like openai-official): it is never appended to the
 *    saved provider list, only referenced by activeId.
 *
 * Nothing in this module logs the token, base URL, or api key.
 */

import { QF_GATEWAY_PROVIDER_ID, type SavedProvider } from '../types/provider.js'
import { defaultProviderModel } from '../../../../gateway/providerRegistry.js'
import type { ProviderService } from './providerService.js'

export { QF_GATEWAY_PROVIDER_ID }
export const QF_GATEWAY_PROVIDER_NAME = 'QF Gateway'

// BilliardBuddy 的唯一文本运行时模型是 registry 中的 TextReasoning；视觉证据仅由 Gateway
// 内部的 Registry-owned VisualEvidence bridge 调用，不能作为桌面/worker 的模型选择。
const QF_GATEWAY_DEFAULT_MODEL = defaultProviderModel()

/** The provider-scoped local proxy path the gateway routes through. */
export const QF_GATEWAY_PROXY_PATH = `/proxy/providers/${QF_GATEWAY_PROVIDER_ID}`

export function isQfGatewayProviderId(id: string | null | undefined): boolean {
  return id === QF_GATEWAY_PROVIDER_ID
}

function readEnv(key: string): string {
  return (process.env[key] ?? '').trim()
}

/** Raw gateway base URL from env (may contain a trailing slash). */
export function getQfGatewayUrl(): string {
  return readEnv('QF_GATEWAY_URL')
}

/**
 * The managed gateway carries an app token, conversations, attachments and audio.
 * Refuse clear-text URLs here as a second outbound choke point in case a caller did
 * not originate from Electron's packaged product-config validation.
 */
function isSecureQfGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/\/+$/, '') === '/gw'
  } catch {
    return false
  }
}

/** Short-lived installation access bearer used to authenticate to the gateway. Lives only in process.env. */
export function getQfGatewayToken(): string {
  return readEnv('QF_GATEWAY_TOKEN')
}

// The registry owns the sole selectable runtime model. Historical values are read only
// by the D3 mapper during Module 22 migration, never by a live provider selector.
export function getQfGatewayModel(): string {
  return QF_GATEWAY_DEFAULT_MODEL
}

/**
 * Legacy observability value injected into the SERVER sidecar only. The Gateway
 * does not authorize or schedule from this header; verified access-token claims
 * are the sole owner identity. Never sent to a non-gateway provider.
 */
export function getInstallationId(): string {
  return readEnv('BB_INSTALLATION_ID')
}

/**
 * The gateway is only usable when BOTH the URL and the app token are present.
 * Requiring the token here is the single choke point: activation, checkAuthStatus
 * and the proxy target all gate on this, so a URL-without-token can never activate,
 * report authed, or emit an empty `Authorization: Bearer ` to the upstream.
 */
export function qfGatewayConfigured(): boolean {
  return isSecureQfGatewayUrl(getQfGatewayUrl()) && getQfGatewayToken().length > 0
}

import { HOST_ONLY_GATEWAY_ENV_KEYS, stripHostOnlyGatewayEnv } from './gatewayEnv.js'
export { HOST_ONLY_GATEWAY_ENV_KEYS, stripHostOnlyGatewayEnv }

/**
 * Resolve the upstream proxy target from process.env at request time.
 * This is where the real app token is overlaid onto the proxy — it is the only
 * place the token is read for outbound requests.
 */
export function resolveQfGatewayProxyTarget(): { baseUrl: string; apiKey: string } {
  const baseUrl = getQfGatewayUrl()
  if (!isSecureQfGatewayUrl(baseUrl)) return { baseUrl: '', apiKey: '' }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: getQfGatewayToken(),
  }
}

/**
 * Build the synthetic SavedProvider for the gateway. Mirrors OPENAI_OFFICIAL_PROVIDER
 * but as an OpenAI-Chat / anthropic-compatible provider. apiKey is an empty
 * placeholder — the real token is overlaid at read time in getProviderForProxy.
 */
export function buildQfGatewayProvider(): SavedProvider {
  const model = getQfGatewayModel()
  return {
    id: QF_GATEWAY_PROVIDER_ID,
    presetId: QF_GATEWAY_PROVIDER_ID,
    name: QF_GATEWAY_PROVIDER_NAME,
    apiKey: '',
    baseUrl: resolveQfGatewayProxyTarget().baseUrl,
    apiFormat: 'openai_chat',
    runtimeKind: 'anthropic_compatible',
    models: {
      main: model,
      haiku: model,
      sonnet: model,
      opus: model,
    },
  }
}

/**
 * Idempotent startup hook: route the product through its managed gateway.
 *
 * When the packaged product supplies a gateway URL and token, that gateway is
 * authoritative. The desktop no longer exposes provider selection, so keeping a
 * stale manual or official provider active would strand upgraded users on a
 * runtime they cannot inspect or change. Saved provider definitions remain on
 * disk for protocol compatibility, but the active runtime is the synthetic
 * gateway provider and the saved list is never mutated here.
 */
export async function ensureQfGatewayProviderRegistered(
  service: ProviderService,
): Promise<void> {
  if (!qfGatewayConfigured()) return

  await service.activateProvider(QF_GATEWAY_PROVIDER_ID)
}

/**
 * Memoized registration used at server startup to remove the fire-and-forget race
 * between registration and the first session. `ensureQfGatewayRegistration` kicks
 * registration off once (errors swallowed so a failed activation never becomes an
 * unhandled rejection or blocks startup), and `whenQfGatewayReady` lets every
 * session-start path wait for it to settle before reading the active provider.
 * After the first resolve the awaited promise is a no-op, so the cost is one-time.
 */
let registration: Promise<void> | null = null

export function ensureQfGatewayRegistration(service: ProviderService): Promise<void> {
  if (!registration) {
    registration = ensureQfGatewayProviderRegistered(service).catch((error) => {
      console.error(
        '[qf-gateway] failed to register product gateway provider:',
        error instanceof Error ? error.message : error,
      )
    })
  }
  return registration
}

/** Resolves once startup registration has settled; immediate no-op if never started. */
export function whenQfGatewayReady(): Promise<void> {
  return registration ?? Promise.resolve()
}

/** Test-only: reset the memoized registration so each case starts clean. */
export function resetQfGatewayRegistrationForTests(): void {
  registration = null
}
