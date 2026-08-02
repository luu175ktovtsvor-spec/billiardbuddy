import { randomBytes } from 'node:crypto'
import {
  normalizePersonalModelProfile,
  parsePersonalModelConfiguration,
  safePersonalModelBaseUrl,
  validPersonalModelProfileId,
  validPersonalModelProviderPresetId,
  type PersonalModelConfiguration,
  type PersonalModelConfigurationSummary,
  type PersonalModelProfile,
  type PersonalModelProfileInput,
  type PersonalModelProviderPresetDiscoveryInput,
  type PersonalModelProviderPresetSelectionInput,
} from '../../../shared/product/personalModels'
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

function summary(value: PersonalModelConfiguration): ProviderCredentialConfigurationSummary {
  return {
    managed_model: 'BilliardBuddy 托管模型',
    profiles: value.profiles.map(({ api_key: _apiKey, ...profile }) => ({ ...profile, configured: true })),
    ...(value.active_profile_id ? { active_profile_id: value.active_profile_id } : {}),
  }
}

/**
 * Electron Main owns the encrypted Key. This service only stores a selected
 * provider connection. It has no model-capacity, context or Agent policy.
 */
export class ProviderCredentialService {
  constructor(private readonly store: CredentialStore) {}

  summary(): ProviderCredentialConfigurationSummary { return summary(this.read()) }

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

  async discoverPreset(input: PersonalModelProviderPresetDiscoveryInput): Promise<PersonalModelDiscoveryResult> {
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
    return await discoverPersonalModels({
      base_url: resolvedProviderPresetBaseUrl(preset, input.base_url, preset.default_protocol),
      api_key: input.api_key,
      protocol: preset.default_protocol,
      auth_mode: preset.auth_mode,
    })
  }

  savePreset(input: PersonalModelProviderPresetSelectionInput): ProviderCredentialConfigurationSummary {
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
      || (input.protocol !== undefined && input.protocol !== 'openai-compatible' && input.protocol !== 'openai-responses')
      || (input.provider_terms_confirmed !== undefined && typeof input.provider_terms_confirmed !== 'boolean')
    ) throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_SELECTION_INVALID')
    const preset = this.providerPreset(input.provider_preset_id)
    if (preset.requires_provider_compatibility_confirmation && input.provider_terms_confirmed !== true) {
      throw new Error('PERSONAL_MODEL_PROVIDER_COMPATIBILITY_CONFIRMATION_REQUIRED')
    }
    const protocol = input.protocol ?? preset.default_protocol
    if (!preset.supported_protocols.includes(protocol)) {
      throw new Error('PERSONAL_MODEL_PROVIDER_PRESET_PROTOCOL_UNSUPPORTED')
    }
    const model = input.model.trim()
    const planName = preset.plan_label ? ` ${preset.plan_label}` : ''
    return this.save({
      id: input.id,
      label: input.label?.trim() || `${preset.provider_label}${planName} · ${model}`.slice(0, 80),
      provider_preset_id: preset.id,
      base_url: resolvedProviderPresetBaseUrl(preset, input.base_url, protocol),
      model,
      api_key: input.api_key,
      protocol,
      auth_mode: preset.auth_mode,
    })
  }

  save(input: PersonalModelProfileInput): ProviderCredentialConfigurationSummary {
    const value = this.read()
    const id = input.id ?? `model_${randomBytes(12).toString('hex')}`
    const index = value.profiles.findIndex(candidate => candidate.id === id)
    const existing = index >= 0 ? value.profiles[index] : undefined
    const profile = normalizePersonalModelProfile({
      ...existing,
      ...input,
      api_key: input.api_key.trim() || existing?.api_key || '',
    }, id)
    if (index >= 0) value.profiles[index] = profile
    else {
      if (value.profiles.length >= 20) throw new Error('PERSONAL_MODEL_PROFILE_LIMIT')
      value.profiles.push(profile)
    }
    // Saving a connection explicitly selects it for the next native Agent
    // session. No separate capability-routing layer is involved.
    value.active_profile_id = profile.id
    this.write(value)
    return summary(value)
  }

  remove(profileId: string): ProviderCredentialConfigurationSummary {
    if (!validPersonalModelProfileId(profileId)) throw new Error('PERSONAL_MODEL_PROFILE_ID_INVALID')
    const value = this.read()
    value.profiles = value.profiles.filter(profile => profile.id !== profileId)
    if (value.active_profile_id === profileId) delete value.active_profile_id
    this.write(value)
    return summary(value)
  }

  /** The currently selected personal connection, if the user chose one. */
  agentTextReasoningProfile(): PersonalModelProfile | null {
    const value = this.read()
    const id = value.active_profile_id
    return id ? value.profiles.find(candidate => candidate.id === id) ?? null : null
  }

  private read(): PersonalModelConfiguration { return parsePersonalModelConfiguration(this.store.load()) }
  private write(value: PersonalModelConfiguration): void {
    if (value.profiles.length === 0) this.store.clear()
    else this.store.save(JSON.stringify(value))
  }
}

export type { PersonalModelProfileInput }
