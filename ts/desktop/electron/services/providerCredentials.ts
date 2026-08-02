import { randomBytes } from 'node:crypto'
import {
  normalizePersonalModelProfile,
  parsePersonalModelConfiguration,
  validPersonalModelCapability,
  validPersonalModelProfileId,
  type PersonalModelCapability,
  type PersonalModelConfiguration,
  type PersonalModelConfigurationSummary,
  type PersonalModelProfile,
  type PersonalModelProfileInput,
} from '../../../shared/product/personalModels'
import type { CredentialStore } from './keychain'

export type ProviderCredentialConfigurationSummary = PersonalModelConfigurationSummary

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

  save(input: PersonalModelProfileInput): ProviderCredentialConfigurationSummary {
    const value = this.read()
    const id = input.id ?? `model_${randomBytes(12).toString('hex')}`
    const index = value.profiles.findIndex(candidate => candidate.id === id)
    const existing = index >= 0 ? value.profiles[index] : undefined
    // Editing a profile must not require Electron Main to disclose its stored
    // secret back to the renderer. An empty key is therefore meaningful only
    // for an existing id and retains the encrypted value already on disk.
    // The renderer only edits the fields it can safely understand. Preserve
    // the existing protocol-specific controls (and the encrypted key when
    // omitted) instead of silently resetting a working Agent route.
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
    // Saving a credential is not consent to replace a managed route. Existing
    // route assignments survive edits only while the endpoint still declares
    // the corresponding Agent capability. The main Agent route additionally
    // requires tool calls; an auxiliary visual route does not.
    for (const capability of Object.keys(value.routes) as PersonalModelCapability[]) {
      if (value.routes[capability] !== id) continue
      if (!profile.capabilities.includes(capability) || (capability === 'TextReasoning' && (!profile.supports_tool_calls || profile.protocol === 'anthropic-messages'))) {
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
      if (capability === 'TextReasoning' && profile.protocol === 'anthropic-messages') throw new Error('PERSONAL_MODEL_PROTOCOL_UNSUPPORTED')
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
    return profile?.protocol === 'anthropic-messages' ? null : profile
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
