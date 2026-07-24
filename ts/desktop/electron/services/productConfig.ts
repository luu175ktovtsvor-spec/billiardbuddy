import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defaultProviderModel } from '../../../../gateway/providerRegistry.js'

/**
 * Product gateway configuration source for the SERVER sidecar.
 *
 * A Finder-launched .app has no shell to export QF_GATEWAY_* — so besides the
 * dev/ops env override we resolve the config from packaged resources:
 *
 *  - `product-config.json` — PUBLIC config, safe to commit and ship: the stable
 *    HTTPS product gateway URL and the default upstream model. No secrets.
 *  - `product-secrets.json` — the activation bootstrap credential and License key. Git-ignored; it is
 *    written into the build resources at release/packaging time from a build
 *    secret, never committed. It never appears in product-config.json, source,
 *    Git, the renderer, providers.json, settings.json, the CLI subprocess, or logs.
 *
 * Precedence per field: env override (dev/ops) > packaged file > undefined.
 *
 * Threat boundary: the managed bootstrap credential and License key are activation
 * inputs, not upstream provider credentials. Provider keys stay in the gateway's
 * mode-600 gw.env; successful activation returns a revocable installation session.
 */
export type ProductGatewayConfig = {
  url?: string
  /** Managed-build bootstrap credential; it can only call /v1/auth/activate. */
  token?: string
  /** Provisioned License key, never sent to the sidecar. */
  licenseKey?: string
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

/**
 * Product traffic carries installation authorization and user content. Keep the
 * packaged URL on HTTPS and bind it to the product gateway base path, rather
 * than accepting an arbitrary secure website as a proxy target.
 */
export function isAllowedProductGatewayUrl(value: string): boolean {
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
    token: trimmed(env.QF_GATEWAY_BOOTSTRAP_CREDENTIAL) ?? trimmed(secretCfg?.gatewayBootstrapCredential),
    licenseKey: trimmed(env.QF_LICENSE_KEY) ?? trimmed(secretCfg?.licenseKey),
    model: trimmed(env.QF_GATEWAY_MODEL) ?? trimmed(publicCfg?.gatewayModel),
  }
}

/**
 * The BilliardBuddy desktop is a managed product, so it must never fall through
 * to an unrelated provider/login path when its packaged gateway config is absent.
 */
export function requireProductGatewayConfig(
  config: ProductGatewayConfig,
): ProductGatewayConfig & { url: string; token: string; licenseKey: string } {
  if (!config.url) {
    throw new ProductGatewayConfigError('Product gateway is not configured: missing gateway URL.')
  }

  try {
    new URL(config.url)
  } catch {
    throw new ProductGatewayConfigError('Product gateway is not configured: gateway URL is invalid.')
  }
  if (!isAllowedProductGatewayUrl(config.url)) {
    throw new ProductGatewayConfigError(
      'Product gateway is not configured: gateway URL must use HTTPS at the /gw endpoint.',
    )
  }
  if (!config.token) {
    throw new ProductGatewayConfigError('Product gateway is not configured: missing bootstrap credential.')
  }
  if (!config.licenseKey) {
    throw new ProductGatewayConfigError('Product gateway is not configured: missing License key.')
  }

  return { ...config, url: config.url, token: config.token, licenseKey: config.licenseKey }
}

/**
 * Overlay public gateway routing config onto a SERVER sidecar env. The bootstrap
 * credential is deliberately not propagated; Main exchanges it for an access token.
 */
export function applyGatewayConfigToEnv(
  baseEnv: NodeJS.ProcessEnv,
  gateway: ProductGatewayConfig | undefined,
): NodeJS.ProcessEnv {
  if (!gateway) return baseEnv
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (gateway.url && !env.QF_GATEWAY_URL) env.QF_GATEWAY_URL = gateway.url
  if (!env.QF_GATEWAY_MODEL) env.QF_GATEWAY_MODEL = gateway.model ?? defaultProviderModel()
  return env
}
