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

// BilliardBuddy 产品默认模型 = DeepSeek V4 Flash(Agent 推理 / 工具选择 / 完整工具循环主模型,
// 扛并发)。MiMo v2.5 仍是唯一真实多模态上游,但图片理解改由服务端网关的视觉桥接按需调用
// (默认模型带图时,网关先用 MiMo 读图成结构化文本再交 DeepSeek 续工具循环),MiMo 不再作为
// 产品默认文本模型。显式请求 qwen3-coder-plus / mimo-v2.5 时由网关按 model 固定路由到对应家,
// 不跨供应商回退。
const QF_GATEWAY_DEFAULT_MODEL = 'deepseek-v4-flash'

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
 * HTTPS is mandatory except for a verified public IPv4 `/gw` entry used while the
 * mainland deployment has no domain. Keep the exception narrow so a clear-text
 * hostname, private address, query, or credential can never activate the provider.
 */
function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return false
  const [first, second, third, fourth] = parts.map(Number)
  if ([first, second, third, fourth].some(part => part > 255)) return false
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && second === 168) return false
  return true
}

function isAllowedQfGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password || url.search || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:'
      && (url.port === '' || url.port === '80')
      && url.pathname.replace(/\/+$/, '') === '/gw'
      && isPublicIpv4(url.hostname)
  } catch {
    return false
  }
}

/** App token used to authenticate to the gateway. Lives only in process.env. */
export function getQfGatewayToken(): string {
  return readEnv('QF_GATEWAY_TOKEN')
}

/** Model the gateway forwards to (Qwen/MiMo/DeepSeek). Defaults to deepseek-v4-flash. */
export function getQfGatewayModel(): string {
  return readEnv('QF_GATEWAY_MODEL') || QF_GATEWAY_DEFAULT_MODEL
}

/**
 * Per-install id (X-QF-Client-ID). Injected by Electron into the SERVER sidecar env only
 * (BB_INSTALLATION_ID). Empty when unset (single-token dev / old build) — the gateway then
 * falls back to token-only scheduling. Never sent to a non-gateway provider.
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
  return isAllowedQfGatewayUrl(getQfGatewayUrl()) && getQfGatewayToken().length > 0
}

/**
 * Env keys the SERVER sidecar holds but NO CLI subprocess — and no adapter sidecar — may
 * inherit: the product-gateway credential/config plus the per-install id. The agent reaches
 * the gateway through the local provider proxy, never these vars. They MUST be stripped at
 * every process spawn chokepoint (interactive CLI, cron/scheduled-task CLI, adapter sidecars)
 * so a single missed path can't leak the token — or the install id — via e.g. `printenv`
 * under bypassPermissions.
 */
export const HOST_ONLY_GATEWAY_ENV_KEYS = [
  'QF_GATEWAY_TOKEN',
  'QF_GATEWAY_URL',
  'QF_GATEWAY_MODEL',
  'BB_INSTALLATION_ID',
  'BB_MEDIA_UI_CAPABILITY',
] as const

/** Return a copy of `env` with the host-only gateway keys removed (never mutates input). */
export function stripHostOnlyGatewayEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of HOST_ONLY_GATEWAY_ENV_KEYS) delete out[key]
  return out
}

/**
 * Resolve the upstream proxy target from process.env at request time.
 * This is where the real app token is overlaid onto the proxy — it is the only
 * place the token is read for outbound requests.
 */
export function resolveQfGatewayProxyTarget(): { baseUrl: string; apiKey: string } {
  const baseUrl = getQfGatewayUrl()
  if (!isAllowedQfGatewayUrl(baseUrl)) return { baseUrl: '', apiKey: '' }
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
