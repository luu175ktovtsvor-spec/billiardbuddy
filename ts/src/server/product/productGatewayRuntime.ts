function environment(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function secureProductUrl(value: string, requiredPath: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null
    if (url.pathname.replace(/\/+$/, '') !== requiredPath) return null
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * The Bun sidecar uses the remote Gateway only for the independent media
 * domains and capability status. Agent model routing lives exclusively in
 * Electron Main plus the Rust Codex App Server.
 */
export function productGatewayTarget(): { baseUrl: string; token: string } | null {
  const baseUrl = secureProductUrl(environment('BB_GATEWAY_URL'), '/gw')
  const token = environment('BB_GATEWAY_TOKEN')
  return baseUrl && token ? { baseUrl, token } : null
}

export function productGatewayConfigured(): boolean {
  return productGatewayTarget() !== null
}

/**
 * Paid image task transport is a separate public Image Relay surface. It reuses
 * the short-lived installation bearer injected by Electron Main, but never falls
 * back to the Gateway URL when the relay route is absent or malformed.
 */
export function productImageRelayTarget(): { baseUrl: string; token: string } | null {
  const baseUrl = secureProductUrl(environment('BB_IMAGE_RELAY_URL'), '/image-generation')
  const token = environment('BB_GATEWAY_TOKEN')
  return baseUrl && token ? { baseUrl, token } : null
}

export function productImageRelayConfigured(): boolean {
  return productImageRelayTarget() !== null
}
