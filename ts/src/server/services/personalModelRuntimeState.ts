import {
  activePersonalModelProfile,
  parsePersonalModelConfiguration,
  type PersonalModelCapability,
  type PersonalModelConfiguration,
  type PersonalModelProfile,
} from '../../../shared/product/personalModels.js'

// Capture the Main-injected configuration before any project extension is
// loaded, then remove it from the process-wide environment. Only trusted Host
// modules can resolve a profile containing the user's API key.
let serializedConfiguration = process.env.BB_PERSONAL_MODEL_CONFIGURATION
delete process.env.BB_PERSONAL_MODEL_CONFIGURATION

export function runtimePersonalModelProfile(
  capability: PersonalModelCapability,
): PersonalModelProfile | null {
  return activePersonalModelProfile(capability, {
    ...(serializedConfiguration
      ? { BB_PERSONAL_MODEL_CONFIGURATION: serializedConfiguration }
      : {}),
  })
}

/** Resolve an already-bound profile without following a later route change. */
export function runtimePersonalModelProfileById(id: string): PersonalModelProfile | null {
  const configuration = parsePersonalModelConfiguration(serializedConfiguration)
  return configuration.profiles.find(profile => profile.id === id) ?? null
}

/** Trusted-only inventory used to reconstruct a previously frozen route. */
export function runtimePersonalModelProfiles(): PersonalModelProfile[] {
  return parsePersonalModelConfiguration(serializedConfiguration).profiles
}

export function setPersonalModelRuntimeConfiguration(
  configuration: PersonalModelConfiguration,
): void {
  serializedConfiguration = configuration.profiles.length > 0
    ? JSON.stringify(configuration)
    : undefined
}
