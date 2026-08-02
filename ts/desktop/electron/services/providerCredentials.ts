import { randomBytes } from 'node:crypto'
import {
  normalizePersonalModelProfile,
  parsePersonalModelConfiguration,
  safePersonalModelBaseUrl,
  validPersonalModelCapability,
  validPersonalModelProfileId,
  type PersonalModelContextLimitSource,
  type PersonalModelCapability,
  type PersonalModelConfiguration,
  type PersonalModelConfigurationSummary,
  type PersonalModelCatalogSelectionInput,
  type PersonalModelProfile,
  type PersonalModelProfileInput,
  type PersonalModelProviderPresetDiscoveryInput,
  type PersonalModelProviderPresetSelectionInput,
  validPersonalModelProviderPresetId,
} from '../../../shared/product/personalModels'
import {
  personalModelCatalogEntries,
  personalModelCatalogEntry,
  personalModelCatalogEntryForEndpoint,
  type PersonalModelCatalogEntry,
} from '../../../shared/product/personalModelCatalog'
import {
  personalModelProviderPreset,
  personalModelProviderPresets,
  type PersonalModelProviderPreset,
} from '../../../shared/product/personalModelProviderCatalog'
import type { CredentialStore } from './keychain'
import {
  discoverPersonalModels,
  type PersonalModelDiscoveryInput,
  type PersonalModelDiscoveryResult,
} from './personalModelDiscovery'

export type ProviderCredentialConfigurationSummary = PersonalModelConfigurationSummary

function verifiedContextLimits(profile: Pick<PersonalModelProfile, 'context_limits_source'>): boolean {
  return profile.context_limits_source === 'product-catalog' || profile.context_limits_source === 'user-declared'
}

function sameCapabilities(actual: unknown, expected: readonly PersonalModelCapability[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((capability, index) => capability === expected[index])
}

/** Resolve a preset route in Electron Main, never from renderer-supplied metadata. */
function resolvedProviderPresetBaseUrl(
  preset: PersonalModelProviderPreset,
  requestedBaseUrl: unknown,
  protocol: PersonalModelProviderPreset['default_protocol'],
): string {
  if (!preset.requires_user_base_url) {
    if (requestedBaseUrl !== undefined) {
      if (typeof requestedBaseUrl !== 'string' || requestedBaseUrl.length > 2_048) {
        throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_BASE_URL_INVALID')
      }
      if (safePersonalModelBaseUrl(requestedBaseUrl, protocol) !== preset.base_url) {
        throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_BASE_URL_FIXED')
      }
    }
    return preset.base_url
  }
  if (typeof requestedBaseUrl !== 'string' || !requestedBaseUrl.trim() || requestedBaseUrl.length > 2_048) {
    throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_BASE_URL_REQUIRED')
  }
  const baseUrl = safePersonalModelBaseUrl(requestedBaseUrl, protocol)
  const template = new URL(preset.base_url)
  const actual = new URL(baseUrl)
  const suffix = preset.base_url_host_suffix?.toLowerCase()
  if (
    !suffix
    || (actual.hostname !== suffix.slice(1) && !actual.hostname.endsWith(suffix))
    || actual.pathname.replace(/\/+$/, '') !== template.pathname.replace(/\/+$/, '')
  ) throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_BASE_URL_INVALID')
  return baseUrl
}

function resolveCatalogEntry(
  input: PersonalModelProfileInput,
  existing: PersonalModelProfile | undefined,
): PersonalModelCatalogEntry | undefined {
  const requested = input.catalog_entry_id
  if (requested === null) return undefined
  const id = requested ?? existing?.catalog_entry_id
  if (id === undefined) return undefined
  const entry = personalModelCatalogEntry(id)
  if (!entry) throw new Error('PERSONAL_MODEL_CATALOG_ENTRY_UNAVAILABLE')
  return entry
}

function assertCatalogContract(input: PersonalModelProfileInput, entry: PersonalModelCatalogEntry): void {
  const authMode = input.auth_mode ?? 'bearer'
  const supportsToolCalls = input.supports_tool_calls ?? true
  const supportsParallelToolCalls = supportsToolCalls && (input.supports_parallel_tool_calls ?? true)
  if (
    input.model.trim() !== entry.model
    || input.protocol !== entry.protocol
    || safePersonalModelBaseUrl(input.base_url, input.protocol) !== entry.base_url
    || authMode !== entry.auth_mode
    || !sameCapabilities(input.capabilities, entry.capabilities)
    || supportsToolCalls !== entry.supports_tool_calls
    || supportsParallelToolCalls !== entry.supports_parallel_tool_calls
  ) throw new Error('PERSONAL_MODEL_CATALOG_CONTRACT_MISMATCH')
}

function summary(value: PersonalModelConfiguration): ProviderCredentialConfigurationSummary {
  return {
    managed_model: 'BilliardBuddy 托管模型',
    profiles: value.profiles.map(({ api_key: _apiKey, ...profile }) => ({ ...profile, configured: true })),
    routes: { ...value.routes },
  }
}

export class ProviderCredentialService {
  constructor(private readonly store: CredentialStore) {}

  summary(): ProviderCredentialConfigurationSummary { return summary(this.read()) }

  catalog(): readonly PersonalModelCatalogEntry[] { return personalModelCatalogEntries() }

  /**
   * Safe public onboarding metadata only: URLs and prefilled endpoint facts,
   * never a saved credential or a model-capacity guess.
   */
  providerPresets(): readonly PersonalModelProviderPreset[] {
    return personalModelProviderPresets()
  }

  providerPreset(id: string): PersonalModelProviderPreset {
    const preset = personalModelProviderPreset(id)
    if (!preset) throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_UNAVAILABLE')
    return preset
  }

  async discover(input: PersonalModelDiscoveryInput): Promise<PersonalModelDiscoveryResult> {
    return await discoverPersonalModels(input)
  }

  /**
   * Preset discovery is the normal onboarding path. The Renderer supplies
   * only the selected preset id and an unsaved Key; Electron Main resolves
   * the destination, protocol and auth header from product-owned data.
   */
  async discoverPreset(
    input: PersonalModelProviderPresetDiscoveryInput,
  ): Promise<PersonalModelDiscoveryResult> {
    if (
      !input
      || typeof input !== 'object'
      || !validPersonalModelProviderPresetId(input.provider_preset_id)
      || typeof input.api_key !== 'string'
      || input.api_key.length < 8
      || input.api_key.length > 4_096
      || (input.base_url !== undefined && (typeof input.base_url !== 'string' || input.base_url.length > 2_048))
    ) throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_DISCOVERY_INVALID')
    const preset = this.providerPreset(input.provider_preset_id)
    if (preset.model_discovery !== 'openai-compatible') {
      throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_DISCOVERY_UNSUPPORTED')
    }
    const baseUrl = resolvedProviderPresetBaseUrl(
      preset,
      input.base_url,
      preset.default_protocol,
    )
    return await discoverPersonalModels({
      base_url: baseUrl,
      api_key: input.api_key,
      protocol: preset.default_protocol,
      auth_mode: preset.auth_mode,
    })
  }

  /**
   * Save an official catalog preset without making the caller repeat its
   * technical contract. This is deliberately separate from `save`: a custom
   * endpoint remains an explicit, advanced user declaration, while every
   * bundled preset is reconstructed from its checked product catalog entry.
   */
  saveCatalog(input: PersonalModelCatalogSelectionInput): ProviderCredentialConfigurationSummary {
    if (
      !input
      || typeof input !== 'object'
      || typeof input.catalog_entry_id !== 'string'
      || typeof input.api_key !== 'string'
      || (input.id !== undefined && !validPersonalModelProfileId(input.id))
      || (input.label !== undefined && (typeof input.label !== 'string' || input.label.trim().length === 0 || input.label.length > 80))
    ) throw new Error('PERSONAL_MODEL_CATALOG_SELECTION_INVALID')
    const entry = personalModelCatalogEntry(input.catalog_entry_id)
    if (!entry) throw new Error('PERSONAL_MODEL_CATALOG_ENTRY_UNAVAILABLE')
    const providerPreset = personalModelProviderPresets().find(preset =>
      !preset.requires_user_base_url
      && preset.provider_id === entry.provider_id
      && preset.base_url === entry.base_url
      && preset.auth_mode === entry.auth_mode
      && preset.supported_protocols.includes(entry.protocol))
    const existing = input.id
      ? this.read().profiles.find(profile => profile.id === input.id)
      : undefined
    return this.save({
      id: input.id,
      label: input.label?.trim() || existing?.label || entry.label,
      ...(providerPreset ? { provider_preset_id: providerPreset.id } : {}),
      base_url: entry.base_url,
      model: entry.model,
      api_key: input.api_key,
      protocol: entry.protocol,
      auth_mode: entry.auth_mode,
      capabilities: [...entry.capabilities],
      supports_tool_calls: entry.supports_tool_calls,
      supports_parallel_tool_calls: entry.supports_parallel_tool_calls,
      catalog_entry_id: entry.id,
    })
  }

  /**
   * Save a model chosen from a BilliardBuddy provider/plan preset without
   * trusting any endpoint data supplied by the renderer. Known models expand
   * to their audited capability contract; an unknown model remains an
   * explicit user declaration instead of borrowing a neighbour's limits.
   */
  savePreset(
    input: PersonalModelProviderPresetSelectionInput,
  ): ProviderCredentialConfigurationSummary {
    if (
      !input
      || typeof input !== 'object'
      || !validPersonalModelProviderPresetId(input.provider_preset_id)
      || typeof input.api_key !== 'string'
      || typeof input.model !== 'string'
      || !input.model.trim()
      || input.model.length > 200
      || (input.base_url !== undefined && (typeof input.base_url !== 'string' || input.base_url.length > 2_048))
      || (input.id !== undefined && !validPersonalModelProfileId(input.id))
      || (input.label !== undefined && (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80))
      || (input.protocol !== undefined && (input.protocol !== 'openai-compatible' && input.protocol !== 'openai-responses'))
      || (input.context_window_tokens === undefined) !== (input.max_output_tokens === undefined)
      || (input.context_window_tokens !== undefined && (!Number.isSafeInteger(input.context_window_tokens) || input.context_window_tokens < 8_192 || input.context_window_tokens > 2_000_000))
      || (input.max_output_tokens !== undefined && (!Number.isSafeInteger(input.max_output_tokens) || input.max_output_tokens < 1_024 || input.max_output_tokens > 1_000_000))
      || (input.context_window_tokens !== undefined && input.max_output_tokens !== undefined && input.max_output_tokens >= input.context_window_tokens)
      || (input.supports_tool_calls !== undefined && typeof input.supports_tool_calls !== 'boolean')
      || (input.supports_parallel_tool_calls !== undefined && typeof input.supports_parallel_tool_calls !== 'boolean')
      || (input.supports_tool_calls === false && input.supports_parallel_tool_calls === true)
      || (input.provider_terms_confirmed !== undefined && typeof input.provider_terms_confirmed !== 'boolean')
    ) throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_SELECTION_INVALID')

    const preset = this.providerPreset(input.provider_preset_id)
    if (preset.requires_provider_compatibility_confirmation && input.provider_terms_confirmed !== true) {
      throw new Error('PERSONAL_MODEL_PROVIDER_COMPATIBILITY_CONFIRMATION_REQUIRED')
    }
    const model = input.model.trim()
    const selectedProtocol = input.protocol ?? preset.default_protocol
    if (!preset.supported_protocols.includes(selectedProtocol)) {
      throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_PROTOCOL_UNSUPPORTED')
    }
    const baseUrl = resolvedProviderPresetBaseUrl(preset, input.base_url, selectedProtocol)
    const catalogEntry = personalModelCatalogEntryForEndpoint({
      base_url: baseUrl,
      model,
      protocol: selectedProtocol,
    })
    const exactCatalogEntry = catalogEntry?.auth_mode === preset.auth_mode
      ? catalogEntry
      : undefined
    if (exactCatalogEntry && (
      (input.context_window_tokens !== undefined && input.context_window_tokens !== exactCatalogEntry.context_window_tokens)
      || (input.max_output_tokens !== undefined && input.max_output_tokens !== exactCatalogEntry.max_output_tokens)
      || (input.supports_tool_calls !== undefined && input.supports_tool_calls !== exactCatalogEntry.supports_tool_calls)
      || (input.supports_parallel_tool_calls !== undefined && input.supports_parallel_tool_calls !== exactCatalogEntry.supports_parallel_tool_calls)
    )) throw new Error('PERSONAL_MODEL_CATALOG_CONTRACT_MISMATCH')
    if (!exactCatalogEntry && (
      input.context_window_tokens === undefined
      || input.max_output_tokens === undefined
      || typeof input.supports_tool_calls !== 'boolean'
      || typeof input.supports_parallel_tool_calls !== 'boolean'
    )) throw new Error('PERSONAL_MODEL_PROVIDER_MODEL_CONTRACT_REQUIRED')

    const planName = preset.plan_label ? ` ${preset.plan_label}` : ''
    const fallbackLabel = `${preset.provider_label}${planName} · ${model}`.slice(0, 80)
    return this.save({
      id: input.id,
      label: input.label?.trim() || exactCatalogEntry?.label || fallbackLabel,
      provider_preset_id: preset.id,
      base_url: baseUrl,
      model,
      api_key: input.api_key,
      protocol: selectedProtocol,
      auth_mode: preset.auth_mode,
      capabilities: [...(exactCatalogEntry?.capabilities ?? ['TextReasoning'])],
      supports_tool_calls: exactCatalogEntry?.supports_tool_calls ?? input.supports_tool_calls,
      supports_parallel_tool_calls: exactCatalogEntry?.supports_parallel_tool_calls ?? input.supports_parallel_tool_calls,
      ...(exactCatalogEntry
        ? { catalog_entry_id: exactCatalogEntry.id }
        : {
          catalog_entry_id: null,
          context_window_tokens: input.context_window_tokens,
          max_output_tokens: input.max_output_tokens,
        }),
    })
  }

  save(input: PersonalModelProfileInput): ProviderCredentialConfigurationSummary {
    const value = this.read()
    const id = input.id ?? `model_${randomBytes(12).toString('hex')}`
    const index = value.profiles.findIndex(candidate => candidate.id === id)
    const existing = index >= 0 ? value.profiles[index] : undefined
    const hasContextWindow = input.context_window_tokens !== undefined
    const hasMaxOutput = input.max_output_tokens !== undefined
    if (hasContextWindow !== hasMaxOutput) throw new Error('PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED')
    if (input.catalog_entry_id === null && !hasContextWindow) {
      // Switching away from a catalog route is deliberate.  The same retained
      // numbers cannot silently become a user declaration for a new endpoint.
      throw new Error('PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED')
    }
    const catalogEntry = resolveCatalogEntry(input, existing)
    const merged = {
      ...existing,
      ...input,
      api_key: input.api_key.trim() || existing?.api_key || '',
    }
    if (catalogEntry) assertCatalogContract(merged, catalogEntry)
    const contextLimitsSource: PersonalModelContextLimitSource = catalogEntry
      ? 'product-catalog'
      : hasContextWindow
        ? 'user-declared'
        : existing?.context_limits_source ?? 'user-declared'
    // Editing a profile must not require Electron Main to disclose its stored
    // secret back to the renderer. An empty key is therefore meaningful only
    // for an existing id and retains the encrypted value already on disk.
    // The renderer only edits the fields it can safely understand. Preserve
    // the existing protocol-specific controls (and the encrypted key when
    // omitted) instead of silently resetting a working Agent route.
    const profile = normalizePersonalModelProfile({
      ...merged,
      ...(catalogEntry
        ? {
          context_window_tokens: catalogEntry.context_window_tokens,
          max_output_tokens: catalogEntry.max_output_tokens,
        }
        : {}),
    }, id, {
      // A catalog entry is itself the declaration.  Otherwise only an
      // explicitly submitted number pair upgrades an old profile; retained
      // historical defaults never become an active Agent route by accident.
      contextLimitsSource,
      ...(catalogEntry ? { catalogEntryId: catalogEntry.id } : {}),
    })
    if (index >= 0) value.profiles[index] = profile
    else {
      if (value.profiles.length >= 20) throw new Error('PERSONAL_MODEL_PROFILE_LIMIT')
      value.profiles.push(profile)
    }
    // Saving a credential is not consent to replace a managed route. Existing
    // route assignments survive edits only while the endpoint still declares
    // the corresponding Agent capability. The main Agent route additionally
    // requires tool calls; an auxiliary visual route does not.
    for (const capability of Object.keys(value.routes) as PersonalModelCapability[]) {
      if (value.routes[capability] !== id) continue
      if (!profile.capabilities.includes(capability) || (capability === 'TextReasoning' && !profile.supports_tool_calls)) {
        delete value.routes[capability]
      }
    }
    this.write(value)
    return summary(value)
  }

  setRoute(capability: PersonalModelCapability, profileId: string | null): ProviderCredentialConfigurationSummary {
    if (!validPersonalModelCapability(capability)) throw new Error('PERSONAL_MODEL_CAPABILITY_INVALID')
    const value = this.read()
    if (profileId === null) delete value.routes[capability]
    else {
      if (!validPersonalModelProfileId(profileId)) throw new Error('PERSONAL_MODEL_PROFILE_ID_INVALID')
      const profile = value.profiles.find(candidate => candidate.id === profileId)
      if (!profile?.capabilities.includes(capability)) throw new Error('PERSONAL_MODEL_CAPABILITY_UNAVAILABLE')
      if (capability === 'TextReasoning' && !profile.supports_tool_calls) throw new Error('PERSONAL_MODEL_TOOL_CALLS_REQUIRED')
      if (capability === 'TextReasoning' && !verifiedContextLimits(profile)) {
        throw new Error('PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED')
      }
      value.routes[capability] = profile.id
    }
    this.write(value)
    return summary(value)
  }

  remove(profileId: string): ProviderCredentialConfigurationSummary {
    if (!validPersonalModelProfileId(profileId)) throw new Error('PERSONAL_MODEL_PROFILE_ID_INVALID')
    const value = this.read()
    value.profiles = value.profiles.filter(profile => profile.id !== profileId)
    for (const capability of Object.keys(value.routes) as PersonalModelCapability[]) {
      if (value.routes[capability] === profileId) delete value.routes[capability]
    }
    this.write(value)
    return summary(value)
  }

  /**
   * Electron Main-only selector for the native Codex route. Unlike
   * `runtimeEnvironment`, this exposes one encrypted profile only to the
   * process that is about to create its short-lived App Server child.
   */
  agentTextReasoningProfile(): PersonalModelProfile | null {
    const value = this.read()
    const id = value.routes.TextReasoning
    const profile = id ? value.profiles.find(candidate => candidate.id === id) ?? null : null
    if (profile && !verifiedContextLimits(profile)) {
      // Never silently fall back to the managed route: a user-selected BYOK
      // route with unknown limits must be repaired explicitly.
      throw new Error('PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED')
    }
    return profile
  }

  private read(): PersonalModelConfiguration { return parsePersonalModelConfiguration(this.store.load()) }
  private write(value: PersonalModelConfiguration): void {
    if (value.profiles.length === 0) this.store.clear()
    else this.store.save(JSON.stringify(value))
  }
}

export type {
  PersonalModelCapability,
  PersonalModelProfileInput,
}
