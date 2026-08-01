import { createHash } from 'node:crypto'
import { defaultProviderModel, providerRegistryEntry } from '../../../../gateway/providerRegistry.js'
import type { PersonalModelProfile } from '../../../shared/product/personalModels.js'
import {
  runtimePersonalModelProfile,
  runtimePersonalModelProfileById,
} from '../services/personalModelRuntimeState.js'

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

export type ProductTextReasoningRoute = {
  binding: { provider: string; model: string }
  personalProfile: PersonalModelProfile | null
  fingerprint: string
}

function managedTextReasoningRoute(): ProductTextReasoningRoute {
  const model = resolveProductTextModel()
  const entry = model ? providerRegistryEntry(model) : undefined
  if (!entry?.capabilities.includes('TextReasoning')) throw new Error('MODEL_CONFIGURATION_INVALID')
  const binding = { provider: entry.provider, model: entry.model_id }
  return { binding, personalProfile: null, fingerprint: routeFingerprint(binding, null) }
}

function routeFingerprint(binding: { provider: string; model: string }, profile: PersonalModelProfile | null): string {
  return createHash('sha256').update(JSON.stringify({
    binding,
    profile: profile && {
      id: profile.id,
      base_url: profile.base_url,
      model: profile.model,
      protocol: profile.protocol,
      auth_mode: profile.auth_mode,
      supports_tool_calls: profile.supports_tool_calls,
      supports_parallel_tool_calls: profile.supports_parallel_tool_calls,
      capabilities: [...profile.capabilities].sort(),
      api_key_digest: createHash('sha256').update(profile.api_key).digest('hex'),
    },
  })).digest('hex')
}

/** Select one trusted route, then persist only its non-secret binding and digest. */
export function productTextReasoningRoute(): ProductTextReasoningRoute {
  const profile = runtimePersonalModelProfile('TextReasoning')
  if (!profile) return managedTextReasoningRoute()
  if (!profile.supports_tool_calls || !profile.capabilities.includes('TextReasoning')) {
    throw new Error('MODEL_CONFIGURATION_INVALID')
  }
  const binding = { provider: `personal-${profile.protocol}:${profile.id}`, model: profile.model }
  return { binding, personalProfile: profile, fingerprint: routeFingerprint(binding, profile) }
}

/** Rebuild an already accepted route without following the current default. */
export function restoreProductTextReasoningRoute(
  binding: { provider: string; model: string },
  fingerprint: string,
): ProductTextReasoningRoute {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('MODEL_CONFIGURATION_INVALID')
  if (!binding.provider.startsWith('personal-')) {
    const route = managedTextReasoningRoute()
    if (route.binding.provider !== binding.provider || route.binding.model !== binding.model || route.fingerprint !== fingerprint) {
      throw new Error('MODEL_CONFIGURATION_INVALID')
    }
    return route
  }
  const match = /^personal-(openai-compatible|openai-responses|anthropic-messages):([A-Za-z0-9_-]{8,80})$/.exec(binding.provider)
  const profile = match ? runtimePersonalModelProfileById(match[2]!) : null
  if (!profile || profile.protocol !== match?.[1] || profile.model !== binding.model || !profile.supports_tool_calls || !profile.capabilities.includes('TextReasoning')) {
    throw new Error('MODEL_CONFIGURATION_INVALID')
  }
  const route = { binding, personalProfile: profile, fingerprint: routeFingerprint(binding, profile) }
  if (route.fingerprint !== fingerprint) throw new Error('MODEL_CONFIGURATION_INVALID')
  return route
}

/** Canonical non-secret binding persisted with each claimed ProductTask run. */
export function productTextReasoningBinding(): { provider: string; model: string; fingerprint: string } {
  const route = productTextReasoningRoute()
  return { ...route.binding, fingerprint: route.fingerprint }
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
