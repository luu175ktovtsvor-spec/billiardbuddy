import type {
  PersonalModelConfigurationSummary,
  PersonalModelProfileInput,
  PersonalModelProviderPresetDiscoveryInput,
  PersonalModelProviderPresetSelectionInput,
  PersonalModelDiscoveryInput,
  PersonalModelDiscoveryResult,
} from '../product/personalModels'
import type { PersonalModelProviderPreset } from '../product/personalModelProviderCatalog'

/**
 * Stable future-Renderer contract for user-owned model connections.
 *
 * The bridge exposes connection and discovery facts only. Thread/Turn state,
 * tools, approvals, context and compression remain on the native Agent bridge.
 */
export type PersonalModelPreloadBridge = {
  summary(): Promise<PersonalModelConfigurationSummary>
  providerPresets(): Promise<readonly PersonalModelProviderPreset[]>
  openProviderPortal(providerPresetId: string): Promise<void>
  openProviderDocumentation(providerPresetId: string): Promise<void>
  discover(input: PersonalModelDiscoveryInput): Promise<PersonalModelDiscoveryResult>
  discoverPreset(input: PersonalModelProviderPresetDiscoveryInput): Promise<PersonalModelDiscoveryResult>
  discoverProfile(profileId: string): Promise<PersonalModelDiscoveryResult>
  savePreset(input: PersonalModelProviderPresetSelectionInput): Promise<PersonalModelConfigurationSummary>
  save(input: PersonalModelProfileInput): Promise<PersonalModelConfigurationSummary>
  activate(profileId: string): Promise<PersonalModelConfigurationSummary>
  useManaged(): Promise<PersonalModelConfigurationSummary>
  remove(profileId: string): Promise<PersonalModelConfigurationSummary>
}
