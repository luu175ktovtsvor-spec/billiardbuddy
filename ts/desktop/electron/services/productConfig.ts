import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Product gateway configuration source for the SERVER sidecar.
 *
 * A Finder-launched .app has no shell to export BB_GATEWAY_* — so besides the
 * dev/ops env override we resolve the config from packaged resources:
 *
 *  - `product-config.json` — PUBLIC config, safe to commit and ship: the stable
 *    HTTPS Gateway, Image Relay and Video Media Relay URLs. No secrets or model selection.
 * A distributed desktop package cannot keep a reusable server secret. Main silently
 * registers its stable installation identity and keeps the rotating session
 * only for the running app process. Provider keys remain in the OS credential
 * store only when the user explicitly configures a personal provider.
 */
export type ProductGatewayConfig = {
  url?: string
  imageRelayUrl?: string
  videoMediaRelayUrl?: string
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

export function isAllowedImageRelayUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/\/+$/, '') === '/image-generation'
  } catch {
    return false
  }
}

/** Video Media Relay is a separate public task surface. It may not fall back
 * to Gateway or Image Relay just because all three share one product domain. */
export function isAllowedVideoMediaRelayUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname.length > 0
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/\/+$/, '') === '/video-media'
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
  return {
    url: trimmed(env.BB_GATEWAY_URL) ?? trimmed(publicCfg?.gatewayUrl),
    imageRelayUrl: trimmed(env.BB_IMAGE_RELAY_URL) ?? trimmed(publicCfg?.imageRelayUrl),
    videoMediaRelayUrl: trimmed(env.BB_VIDEO_MEDIA_RELAY_URL) ?? trimmed(publicCfg?.videoMediaRelayUrl),
  }
}

/**
 * The Gateway is independently sufficient for installation authentication and
 * the managed Agent Responses route. Image and video Relay configuration is
 * deliberately not an implicit prerequisite for those operations.
 */
export function requireProductGatewayRoute(
  config: ProductGatewayConfig,
): ProductGatewayConfig & { url: string } {
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
  return { ...config, url: config.url }
}

/**
 * The BilliardBuddy desktop is a managed product, so it must never fall through
 * to an unrelated provider/login path when its packaged gateway config is absent.
 */
export function requireProductGatewayConfig(
  config: ProductGatewayConfig,
): ProductGatewayConfig & { url: string; imageRelayUrl: string; videoMediaRelayUrl: string } {
  const gateway = requireProductGatewayRoute(config)
  if (!config.imageRelayUrl) {
    throw new ProductGatewayConfigError('Product image relay is not configured: missing image relay URL.')
  }
  if (!config.videoMediaRelayUrl) {
    throw new ProductGatewayConfigError('Product video media relay is not configured: missing video media relay URL.')
  }

  try {
    new URL(config.imageRelayUrl)
  } catch {
    throw new ProductGatewayConfigError('Product image relay is not configured: image relay URL is invalid.')
  }
  if (!isAllowedImageRelayUrl(config.imageRelayUrl)) {
    throw new ProductGatewayConfigError(
      'Product image relay is not configured: image relay URL must use HTTPS at the /image-generation endpoint.',
    )
  }
  try {
    new URL(config.videoMediaRelayUrl)
  } catch {
    throw new ProductGatewayConfigError('Product video media relay is not configured: video media relay URL is invalid.')
  }
  if (!isAllowedVideoMediaRelayUrl(config.videoMediaRelayUrl)) {
    throw new ProductGatewayConfigError(
      'Product video media relay is not configured: video media relay URL must use HTTPS at the /video-media endpoint.',
    )
  }
  return { ...gateway, imageRelayUrl: config.imageRelayUrl, videoMediaRelayUrl: config.videoMediaRelayUrl }
}

/**
 * Overlay public gateway routing config onto a SERVER sidecar env. Reusable
 * credentials are deliberately not part of this configuration; Main silently
 * exchanges its stable installation identity for a short-lived access token.
 */
export function applyGatewayConfigToEnv(
  baseEnv: NodeJS.ProcessEnv,
  gateway: ProductGatewayConfig | undefined,
): NodeJS.ProcessEnv {
  if (!gateway) return baseEnv
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (gateway.url && !env.BB_GATEWAY_URL) env.BB_GATEWAY_URL = gateway.url
  if (gateway.imageRelayUrl && !env.BB_IMAGE_RELAY_URL) env.BB_IMAGE_RELAY_URL = gateway.imageRelayUrl
  if (gateway.videoMediaRelayUrl && !env.BB_VIDEO_MEDIA_RELAY_URL) env.BB_VIDEO_MEDIA_RELAY_URL = gateway.videoMediaRelayUrl
  return env
}
