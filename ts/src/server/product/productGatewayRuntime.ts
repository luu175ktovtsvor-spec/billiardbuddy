function environment(name: string): string {
  return process.env[name]?.trim() ?? ''
}

function secureGatewayUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null
    if (url.pathname.replace(/\/+$/, '') !== '/gw') return null
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
  const baseUrl = secureGatewayUrl(environment('BB_GATEWAY_URL'))
  const token = environment('BB_GATEWAY_TOKEN')
  return baseUrl && token ? { baseUrl, token } : null
}

export function productGatewayConfigured(): boolean {
  return productGatewayTarget() !== null
}
