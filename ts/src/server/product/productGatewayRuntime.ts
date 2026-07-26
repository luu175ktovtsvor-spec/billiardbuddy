import { defaultProviderModel, providerRegistryEntry } from '../../../../gateway/providerRegistry.js'

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

export function productDefaultTextModel(): string {
  return defaultProviderModel()
}

/** Canonical non-secret binding persisted with each claimed ProductTask run. */
export function productTextReasoningBinding(): { provider: string; model: string } {
  const model = resolveProductTextModel()
  const entry = model ? providerRegistryEntry(model) : undefined
  if (!entry?.capabilities.includes('TextReasoning')) throw new Error('MODEL_CONFIGURATION_INVALID')
  return { provider: entry.provider, model: entry.model_id }
}

export function productCompactThreshold(model = productDefaultTextModel()): number {
  const entry = providerRegistryEntry(model)
  if (!entry?.capabilities.includes('TextReasoning')) throw new Error('MODEL_CONFIGURATION_INVALID')
  return entry.compact_threshold
}

export function resolveProductTextModel(requested?: string): string | null {
  const model = requested?.trim() || environment('BB_GATEWAY_MODEL') || productDefaultTextModel()
  const entry = providerRegistryEntry(model)
  return entry?.capabilities.includes('TextReasoning') ? entry.model_id : null
}

export function productGatewayTarget(): { baseUrl: string; token: string } | null {
  const baseUrl = secureGatewayUrl(environment('BB_GATEWAY_URL'))
  const token = environment('BB_GATEWAY_TOKEN')
  return baseUrl && token ? { baseUrl, token } : null
}

export function productGatewayConfigured(): boolean {
  return productGatewayTarget() !== null
}
