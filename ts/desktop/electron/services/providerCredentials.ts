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
  type PersonalModelProfile,
  type PersonalModelProfileInput,
} from '../../../shared/product/personalModels'
import {
  personalModelCatalogEntries,
  personalModelCatalogEntry,
  type PersonalModelCatalogEntry,
} from '../../../shared/product/personalModelCatalog'
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

  async discover(input: PersonalModelDiscoveryInput): Promise<PersonalModelDiscoveryResult> {
    return await discoverPersonalModels(input)
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
