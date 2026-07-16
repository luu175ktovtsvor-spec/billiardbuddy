/**
 * QF Gateway Provider — product-managed provider routed through our gateway.
 *
 * The gateway speaks OpenAI Chat Completions and fans out to Qwen/MiMo upstreams.
 * It is configured entirely from process.env (QF_GATEWAY_URL / QF_GATEWAY_TOKEN /
 * QF_GATEWAY_MODEL) so the desktop/server can auto-route the agent WITHOUT the
 * user entering any Base URL, provider, or upstream key.
 *
 * Credential boundary:
 *  - The app token lives ONLY in process.env (QF_GATEWAY_TOKEN). It is overlaid
 *    onto the proxy target at request time (resolveQfGatewayProxyTarget) inside
 *    getProviderForProxy — it is NEVER written to providers.json, never synced to
 *    settings.json, and never handed to the CLI subprocess.
 *  - The synthetic SavedProvider carries an empty apiKey placeholder. Because
 *    apiFormat is 'openai_chat', the managed env the CLI receives is only
 *    ANTHROPIC_API_KEY='proxy-managed' + ANTHROPIC_BASE_URL=<local proxy>.
 *  - The gateway is synthetic (like openai-official): it is never appended to the
 *    saved provider list, only referenced by activeId.
 *
 * Nothing in this module logs the token, base URL, or api key.
 */

import { QF_GATEWAY_PROVIDER_ID, type SavedProvider } from '../types/provider.js'
import type { ProviderService } from './providerService.js'

export { QF_GATEWAY_PROVIDER_ID }
export const QF_GATEWAY_PROVIDER_NAME = 'QF Gateway'

const QF_GATEWAY_DEFAULT_MODEL = 'qwen3-coder-plus'

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

/** App token used to authenticate to the gateway. Lives only in process.env. */
export function getQfGatewayToken(): string {
  return readEnv('QF_GATEWAY_TOKEN')
}

/** Model the gateway forwards to (Qwen/MiMo). Defaults to qwen3-coder-plus. */
export function getQfGatewayModel(): string {
  return readEnv('QF_GATEWAY_MODEL') || QF_GATEWAY_DEFAULT_MODEL
}

/** The gateway is only usable when QF_GATEWAY_URL is configured. */
export function qfGatewayConfigured(): boolean {
  return getQfGatewayUrl().length > 0
}

/**
 * Resolve the upstream proxy target from process.env at request time.
 * This is where the real app token is overlaid onto the proxy — it is the only
 * place the token is read for outbound requests.
 */
export function resolveQfGatewayProxyTarget(): { baseUrl: string; apiKey: string } {
  return {
    baseUrl: getQfGatewayUrl().replace(/\/+$/, ''),
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
 * Idempotent startup hook: auto-route the agent through the product gateway.
 *
 * Only activates when the gateway is configured AND the user has NOT chosen a
 * provider of their own. Never overwrites a non-null activeId that points at a
 * user's manual provider, and never mutates the saved provider list.
 */
export async function ensureQfGatewayProviderRegistered(
  service: ProviderService,
): Promise<void> {
  if (!qfGatewayConfigured()) return

  const { activeId } = await service.listProviders()
  // Respect a user's explicit choice — only claim a null or already-gateway slot.
  if (activeId !== null && !isQfGatewayProviderId(activeId)) return

  await service.activateProvider(QF_GATEWAY_PROVIDER_ID)
}
