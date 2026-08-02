/**
 * Personal model configuration is intentionally only a connection profile.
 * The Rust Codex App Server owns Agent state, tools, context and settings;
 * this layer must not grow a second model-capability or token-policy system.
 */
export const PERSONAL_MODEL_PROTOCOLS = [
  'openai-compatible',
  'openai-responses',
] as const
export type PersonalModelProtocol = (typeof PERSONAL_MODEL_PROTOCOLS)[number]

export const PERSONAL_MODEL_AUTH_MODES = ['bearer', 'x-api-key', 'api-key'] as const
export type PersonalModelAuthMode = (typeof PERSONAL_MODEL_AUTH_MODES)[number]

export type PersonalModelProfile = {
  id: string
  label: string
  provider_preset_id?: string
  base_url: string
  model: string
  protocol: PersonalModelProtocol
  auth_mode: PersonalModelAuthMode
  api_key: string
}

export type PersonalModelProfileInput = Omit<PersonalModelProfile, 'id' | 'auth_mode'> & {
  id?: string
  auth_mode?: PersonalModelAuthMode
}

/** A provider preset supplies endpoint, protocol and authentication defaults. */
export type PersonalModelProviderPresetSelectionInput = {
  id?: string
  provider_preset_id: string
  api_key: string
  model: string
  label?: string
  base_url?: string
  protocol?: PersonalModelProtocol
  provider_terms_confirmed?: boolean
}

/** A Key is supplied transiently; Electron Main resolves the preset route. */
export type PersonalModelProviderPresetDiscoveryInput = {
  provider_preset_id: string
  api_key: string
  base_url?: string
}

export type PersonalModelConfiguration = {
  version: 2
  profiles: PersonalModelProfile[]
  active_profile_id?: string
}

export type PersonalModelProfileSummary = Omit<PersonalModelProfile, 'api_key'> & { configured: true }
export type PersonalModelConfigurationSummary = {
  managed_model: string
  profiles: PersonalModelProfileSummary[]
  active_profile_id?: string
}

export function validPersonalModelProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value)
}

export function validPersonalModelProviderPresetId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,80}$/i.test(value)
}

export function validPersonalModelProtocol(value: unknown): value is PersonalModelProtocol {
  return typeof value === 'string' && (PERSONAL_MODEL_PROTOCOLS as readonly string[]).includes(value)
}

export function validPersonalModelAuthMode(value: unknown): value is PersonalModelAuthMode {
  return typeof value === 'string' && (PERSONAL_MODEL_AUTH_MODES as readonly string[]).includes(value)
}

export function defaultPersonalModelAuthMode(): PersonalModelAuthMode {
  return 'bearer'
}

export function safePersonalModelBaseUrl(value: string, protocol: PersonalModelProtocol): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('PERSONAL_MODEL_BASE_URL_INVALID') }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new Error('PERSONAL_MODEL_BASE_URL_INVALID')
  }
  for (const name of url.searchParams.keys()) {
    if (/(?:api[-_]?key|token|secret|signature|credential|authorization|^sig$)/i.test(name)) {
      throw new Error('PERSONAL_MODEL_BASE_URL_CONTAINS_SECRET')
    }
  }
  let pathname = url.pathname.replace(/\/+$/, '')
  const endpointSuffix = protocol === 'openai-compatible' ? '/chat/completions' : '/responses'
  if (pathname.endsWith(endpointSuffix)) pathname = pathname.slice(0, -endpointSuffix.length)
  url.pathname = pathname || '/v1'
  return url.toString().replace(/\/$/, '')
}

export function normalizePersonalModelProfile(
  input: PersonalModelProfileInput,
  id: string,
): PersonalModelProfile {
  if (!validPersonalModelProfileId(id)) throw new Error('PERSONAL_MODEL_PROFILE_ID_INVALID')
  const label = input.label.trim()
  const providerPresetId = input.provider_preset_id?.trim()
  const model = input.model.trim()
  const apiKey = input.api_key.trim()
  if (
    !label
    || label.length > 80
    || (input.provider_preset_id !== undefined && !validPersonalModelProviderPresetId(providerPresetId))
    || !model
    || model.length > 200
    || apiKey.length < 8
    || apiKey.length > 4_096
    || /[\r\n\0]/.test(model)
    || /[\r\n\0]/.test(apiKey)
  ) throw new Error('PERSONAL_MODEL_PROFILE_INVALID')
  if (!validPersonalModelProtocol(input.protocol)) throw new Error('PERSONAL_MODEL_PROTOCOL_UNSUPPORTED')
  const authMode = input.auth_mode ?? defaultPersonalModelAuthMode()
  if (!validPersonalModelAuthMode(authMode)) throw new Error('PERSONAL_MODEL_AUTH_MODE_UNSUPPORTED')
  return {
    id,
    label,
    ...(providerPresetId ? { provider_preset_id: providerPresetId } : {}),
    base_url: safePersonalModelBaseUrl(input.base_url, input.protocol),
    model,
    protocol: input.protocol,
    auth_mode: authMode,
    api_key: apiKey,
  }
}

/**
 * Reads current profiles and migrates earlier saved shapes by retaining only
 * the connection fields. Old capability and token declarations are discarded.
 */
export function parsePersonalModelConfiguration(raw: string | undefined | null): PersonalModelConfiguration {
  if (!raw) return { version: 2, profiles: [] }
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
  const record = value as { version?: unknown; profiles?: unknown; active_profile_id?: unknown; routes?: unknown }
  if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.profiles)) {
    throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
  }
  const profiles = record.profiles.flatMap(rawProfile => {
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
      throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
    }
    const profile = rawProfile as PersonalModelProfile
    if (profile.protocol === ('anthropic-messages' as string)) return []
    return [normalizePersonalModelProfile(profile, profile.id)]
  })
  if (profiles.length > 20 || new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    throw new Error('PERSONAL_MODEL_CONFIGURATION_CORRUPT')
  }
  const legacyActiveProfileId = record.version === 1 && record.routes && typeof record.routes === 'object'
    ? (record.routes as { TextReasoning?: unknown }).TextReasoning
    : undefined
  const requestedActiveProfileId = record.active_profile_id ?? legacyActiveProfileId
  const activeProfileId = validPersonalModelProfileId(requestedActiveProfileId)
    && profiles.some(profile => profile.id === requestedActiveProfileId)
    ? requestedActiveProfileId
    : undefined
  return { version: 2, profiles, ...(activeProfileId ? { active_profile_id: activeProfileId } : {}) }
}
