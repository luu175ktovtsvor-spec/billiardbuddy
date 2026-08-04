import { inspect } from 'node:util'

export type RelayCredentialsEnvironment = Readonly<Record<string, string | undefined>>

/** The Seedream account is served through ByteDance Ark, so its deployed slot keeps the existing RELAY_ARK name. */
export const RELAY_PROVIDER_SECRET_SLOTS = {
  openai: 'RELAY_OPENAI_KEY',
  seedream: 'RELAY_ARK_KEY',
} as const

export const RELAY_PROVIDER_BASE_URL_SLOTS = {
  openai: 'RELAY_OPENAI_BASE',
  seedream: 'RELAY_ARK_BASE',
} as const

export type RelayCredentialProvider = keyof typeof RELAY_PROVIDER_SECRET_SLOTS
export type RelayProviderSecretSlot = (typeof RELAY_PROVIDER_SECRET_SLOTS)[RelayCredentialProvider]

const PROVIDERS = Object.freeze(Object.keys(RELAY_PROVIDER_SECRET_SLOTS) as RelayCredentialProvider[])
const DEFAULT_BASE_URLS: Record<RelayCredentialProvider, string> = {
  openai: 'https://api.openai.com/v1',
  seedream: 'https://ark.cn-beijing.volces.com/api/v3',
}
const REDACTED = '[REDACTED]'

/** A paid-provider secret is usable only to create the outbound Authorization header. */
export class RelayProviderSecret {
  #value: string

  constructor(value: string) {
    this.#value = value
  }

  bearerAuthorization(): string {
    return `Bearer ${this.#value}`
  }

  toString(): string { return REDACTED }
  toJSON(): string { return REDACTED }
  [inspect.custom](): string { return REDACTED }
}

export type RelayProviderCredentialView = {
  provider: RelayCredentialProvider
  secret_slot: RelayProviderSecretSlot
  secret_configured: boolean
  base_url: string
}

/**
 * The Relay has exactly two credential ownership slots. Its public view is
 * deliberately safe for health diagnostics: it carries availability and base
 * URL, never a key or a serializable secret object.
 */
export class RelayProviderCredentials {
  #secrets: Readonly<Record<RelayCredentialProvider, RelayProviderSecret | undefined>>
  #baseUrls: Readonly<Record<RelayCredentialProvider, string>>

  constructor(
    secrets: Record<RelayCredentialProvider, RelayProviderSecret | undefined>,
    baseUrls: Record<RelayCredentialProvider, string>,
  ) {
    this.#secrets = Object.freeze({ ...secrets })
    this.#baseUrls = Object.freeze({ ...baseUrls })
  }

  bearerAuthorization(provider: RelayCredentialProvider): string | undefined {
    return this.#secrets[provider]?.bearerAuthorization()
  }

  baseUrl(provider: RelayCredentialProvider): string {
    return this.#baseUrls[provider]
  }

  view(provider: RelayCredentialProvider): RelayProviderCredentialView {
    return {
      provider,
      secret_slot: RELAY_PROVIDER_SECRET_SLOTS[provider],
      secret_configured: this.#secrets[provider] !== undefined,
      base_url: this.#baseUrls[provider],
    }
  }

  toJSON(): { providers: RelayProviderCredentialView[] } {
    return { providers: PROVIDERS.map(provider => this.view(provider)) }
  }

  [inspect.custom](): string {
    return `RelayProviderCredentials ${JSON.stringify(this.toJSON())}`
  }
}

export function loadRelayProviderCredentials(environment: RelayCredentialsEnvironment = process.env): RelayProviderCredentials {
  const secrets = {} as Record<RelayCredentialProvider, RelayProviderSecret | undefined>
  const baseUrls = {} as Record<RelayCredentialProvider, string>
  for (const provider of PROVIDERS) {
    const key = environment[RELAY_PROVIDER_SECRET_SLOTS[provider]]?.trim()
    secrets[provider] = key ? new RelayProviderSecret(key) : undefined
    const slot = RELAY_PROVIDER_BASE_URL_SLOTS[provider]
    baseUrls[provider] = parseRelayHttpsBaseUrl(environment[slot], slot, DEFAULT_BASE_URLS[provider])
  }
  return new RelayProviderCredentials(secrets, baseUrls)
}

/** Reject an endpoint that could downgrade transport or smuggle credential/query data into provider routing. */
export function parseRelayHttpsBaseUrl(value: string | undefined, slot: string, fallback: string): string {
  const candidate = value === undefined || value === '' ? fallback : value
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`${slot} must be a valid HTTPS base URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${slot} must be an HTTPS base URL without credentials, query, or fragment`)
  }
  return url.toString().replace(/\/$/, '')
}
