import type {
  PersonalModelAuthMode,
  PersonalModelProtocol,
} from './personalModels'
import {
  personalModelCatalogEntries,
  type PersonalModelCatalogEntry,
} from './personalModelCatalog'

/**
 * Product-owned onboarding facts for user-supplied model credentials.
 *
 * These records deliberately describe only a provider's public setup path:
 * where to obtain a Key, its canonical API base URL, and the wire protocols
 * that BilliardBuddy can route.  They do not claim model capacity.  Exact
 * context and output limits remain in `personalModelCatalog.ts`, where each
 * model must have its own official evidence.
 */
export const PERSONAL_MODEL_PROVIDER_SETUP_CATALOG_REVISION = 2 as const

type PersonalModelProviderSetupPreset = {
  /** Stable BilliardBuddy identifier, never derived from the display label. */
  id: string
  provider_id: string
  provider_label: string
  /** Canonical origin used to prefill a new direct-provider configuration. */
  base_url: string
  default_protocol: PersonalModelProtocol
  supported_protocols: readonly PersonalModelProtocol[]
  auth_mode: PersonalModelAuthMode
  /** Official account portal where the user can create or manage an API Key. */
  api_key_url: string
  /** Official provider documentation, not a community compatibility guide. */
  documentation_url: string
}

/**
 * A setup preset plus only the verified model contracts that exactly match its
 * direct upstream route.  Keeping this derived prevents the provider list and
 * the model-capability list from becoming two competing sources of truth.
 */
export type PersonalModelProviderPreset = PersonalModelProviderSetupPreset & {
  catalog_entries: readonly PersonalModelCatalogEntry[]
}

// These URLs are onboarding links only. They are sent to the Renderer as
// immutable catalog data; the user Key is never part of this catalog or URL.
const PERSONAL_MODEL_PROVIDER_SETUP_CATALOG: readonly PersonalModelProviderSetupPreset[] = [
  {
    id: 'deepseek',
    provider_id: 'deepseek',
    provider_label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    default_protocol: 'openai-responses',
    supported_protocols: ['openai-responses', 'openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.deepseek.com/api_keys',
    documentation_url: 'https://api-docs.deepseek.com/quick_start/pricing/',
  },
  {
    id: 'openai',
    provider_id: 'openai',
    provider_label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    default_protocol: 'openai-responses',
    supported_protocols: ['openai-responses', 'openai-compatible'],
    auth_mode: 'bearer',
    api_key_url: 'https://platform.openai.com/api-keys',
    documentation_url: 'https://developers.openai.com/api/docs/models',
  },
] as const

function normalizedProviderPresetId(value: string | undefined | null): string | undefined {
  const id = value?.trim()
  return id || undefined
}

export function personalModelProviderPresets(): readonly PersonalModelProviderPreset[] {
  return PERSONAL_MODEL_PROVIDER_SETUP_CATALOG.map(providerPresetWithCatalogEntries)
}

export function personalModelProviderPreset(
  id: string | undefined | null,
): PersonalModelProviderPreset | undefined {
  const normalized = normalizedProviderPresetId(id)
  const preset = normalized
    ? PERSONAL_MODEL_PROVIDER_SETUP_CATALOG.find(entry => entry.id === normalized)
    : undefined
  return preset ? providerPresetWithCatalogEntries(preset) : undefined
}

function providerPresetWithCatalogEntries(
  preset: PersonalModelProviderSetupPreset,
): PersonalModelProviderPreset {
  const catalogEntries = personalModelCatalogEntries().filter(entry =>
    entry.provider_id === preset.provider_id
    && entry.base_url === preset.base_url
    && entry.auth_mode === preset.auth_mode
    && preset.supported_protocols.includes(entry.protocol))
  if (catalogEntries.length === 0) {
    throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_CATALOG_CORRUPT')
  }
  return { ...preset, catalog_entries: catalogEntries }
}
