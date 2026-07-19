import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Product gateway configuration source for the SERVER sidecar.
 *
 * A Finder-launched .app has no shell to export QF_GATEWAY_* — so besides the
 * dev/ops env override we resolve the config from packaged resources:
 *
 *  - `product-config.json` — PUBLIC config, safe to commit and ship: the stable
 *    HTTPS product gateway URL and the default upstream model. No secrets.
 *  - `product-secrets.json` — the revocable client app token. Git-ignored; it is
 *    written into the build resources at release/packaging time from a build
 *    secret, never committed. It never appears in product-config.json, source,
 *    Git, the renderer, providers.json, settings.json, the CLI subprocess, or logs.
 *
 * Precedence per field: env override (dev/ops) > packaged file > undefined.
 *
 * Threat boundary: the app token is a client credential shared by every install,
 * not a per-user account. Anyone who extracts it can only make metered, rate-
 * limited, revocable proxy calls — the upstream Qwen/MiMo/Fun-ASR keys stay on the
 * gateway server (gw.env, 600). Real defense is server-side rate-limit + revocation
 * + rotation; rotation = re-issue a token, rebuild/redeploy, revoke the old one.
 */
export type ProductGatewayConfig = {
  url?: string
  token?: string
  model?: string
}

export type ProductConfigSource = {
  isPackaged: boolean
  /** process.resourcesPath — where packaged extraResources land. */
  resourcesPath?: string
  /** Repo `build/` dir, used in unpackaged/dev runs. */
  devBuildDir?: string
  env?: NodeJS.ProcessEnv
}

export class ProductGatewayConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductGatewayConfigError'
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Directory that holds the packaged config files for the current run. */
export function productConfigDir(source: ProductConfigSource): string | undefined {
  return source.isPackaged ? source.resourcesPath : source.devBuildDir
}

export function resolveProductGatewayConfig(source: ProductConfigSource): ProductGatewayConfig {
  const env = source.env ?? process.env
  const dir = productConfigDir(source)
  const publicCfg = dir ? readJsonObject(path.join(dir, 'product-config.json')) : null
  const secretCfg = dir ? readJsonObject(path.join(dir, 'product-secrets.json')) : null

  return {
    url: trimmed(env.QF_GATEWAY_URL) ?? trimmed(publicCfg?.gatewayUrl),
    // The token is only ever env or the git-ignored secrets file — never public config.
    token: trimmed(env.QF_GATEWAY_TOKEN) ?? trimmed(secretCfg?.gatewayToken),
    model: trimmed(env.QF_GATEWAY_MODEL) ?? trimmed(publicCfg?.gatewayModel),
  }
}

/**
 * The BilliardBuddy desktop is a managed product, so it must never fall through
 * to an unrelated provider/login path when its packaged gateway config is absent.
 */
export function requireProductGatewayConfig(
  config: ProductGatewayConfig,
): ProductGatewayConfig & { url: string; token: string } {
  if (!config.url) {
    throw new ProductGatewayConfigError('Product gateway is not configured: missing gateway URL.')
  }

  let parsed: URL
  try {
    parsed = new URL(config.url)
  } catch {
    throw new ProductGatewayConfigError('Product gateway is not configured: gateway URL is invalid.')
  }
  if (parsed.protocol !== 'https:') {
    throw new ProductGatewayConfigError('Product gateway is not configured: gateway URL must use HTTPS.')
  }
  if (!config.token) {
    throw new ProductGatewayConfigError('Product gateway is not configured: missing app token.')
  }

  return { ...config, url: config.url, token: config.token }
}

/**
 * Overlay resolved gateway config onto a SERVER sidecar env. A value already present
 * (shell/ops override) always wins over the injected default. Returns a new object;
 * pass `undefined` gateway (e.g. for adapter sidecars) to get the base env untouched.
 */
export function applyGatewayConfigToEnv(
  baseEnv: NodeJS.ProcessEnv,
  gateway: ProductGatewayConfig | undefined,
): NodeJS.ProcessEnv {
  if (!gateway) return baseEnv
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (gateway.url && !env.QF_GATEWAY_URL) env.QF_GATEWAY_URL = gateway.url
  if (gateway.token && !env.QF_GATEWAY_TOKEN) env.QF_GATEWAY_TOKEN = gateway.token
  if (gateway.model && !env.QF_GATEWAY_MODEL) env.QF_GATEWAY_MODEL = gateway.model
  return env
}
