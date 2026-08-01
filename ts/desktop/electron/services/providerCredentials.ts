import { randomBytes } from 'node:crypto'
import {
  normalizePersonalModelProfile,
  parsePersonalModelConfiguration,
  validPersonalModelCapability,
  validPersonalModelProfileId,
  type PersonalModelCapability,
  type PersonalModelConfiguration,
  type PersonalModelConfigurationSummary,
  type PersonalModelProfileInput,
} from '../../../shared/product/personalModels'
import type { CredentialStore } from './keychain'

export type ProviderCredentialConfigurationSummary = PersonalModelConfigurationSummary

type ProviderCredentialSnapshot = {
  models: PersonalModelConfiguration
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

  /** Electron Main-only rollback snapshot; never return this through IPC. */
  capture(): ProviderCredentialSnapshot { return { models: this.read() } }

  restore(value: ProviderCredentialSnapshot): void {
    this.write(value.models)
  }

  save(input: PersonalModelProfileInput): ProviderCredentialConfigurationSummary {
    const value = this.read()
    const id = input.id ?? `model_${randomBytes(12).toString('hex')}`
    const index = value.profiles.findIndex(candidate => candidate.id === id)
    const existing = index >= 0 ? value.profiles[index] : undefined
    // Editing a profile must not require Electron Main to disclose its stored
    // secret back to the renderer. An empty key is therefore meaningful only
    // for an existing id and retains the encrypted value already on disk.
    const profile = normalizePersonalModelProfile({
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

  runtimeEnvironment(): NodeJS.ProcessEnv {
    // The trusted Product Server needs every configured profile because a
    // Composer can choose a non-default model for one task. Routes remain only
    // the defaults used by new tasks; no secret is exposed to the renderer.
    const value = this.read()
    return {
      ...(value.profiles.length > 0 ? { BB_PERSONAL_MODEL_CONFIGURATION: JSON.stringify(value) } : {}),
    }
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
