import { inspect } from 'node:util'

export type GatewayCredentialsEnvironment = Readonly<Record<string, string | undefined>>

export const GATEWAY_PROVIDER_SECRET_SLOTS = {
  deepseek: 'GW_DEEPSEEK_KEY',
  mimo: 'GW_MIMO_KEY',
  qwen: 'GW_QWEN_KEY',
  funasr: 'GW_FUNASR_KEY',
} as const

export const GATEWAY_PROVIDER_BASE_URL_SLOTS = {
  deepseek: 'GW_DEEPSEEK_BASE',
  mimo: 'GW_MIMO_BASE',
  qwen: 'GW_QWEN_BASE',
  funasr: 'GW_FUNASR_URL',
} as const

export type GatewayCredentialProvider = keyof typeof GATEWAY_PROVIDER_SECRET_SLOTS
export type GatewayProviderSecretSlot = (typeof GATEWAY_PROVIDER_SECRET_SLOTS)[GatewayCredentialProvider]

const PROVIDER_BASE_URL_DEFAULTS: Record<GatewayCredentialProvider, string> = {
  deepseek: 'https://api.deepseek.com',
  mimo: 'https://api.xiaomimimo.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  funasr: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
}

const REDACTED = '[REDACTED]'

/** A provider key can be used to build an upstream Authorization value, never serialized or stringified. */
export class GatewayProviderSecret {
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

export type GatewayProviderCredentialView = {
  provider: GatewayCredentialProvider
  secret_slot: GatewayProviderSecretSlot
  secret_configured: boolean
  base_url: string
}

/**
 * Gateway's complete secret ownership boundary. It intentionally has no
 * generic "get environment variable" API and its serialized representation
 * names slots plus availability only, never their values.
 */
export class GatewayProviderCredentials {
  #secrets: Readonly<Record<GatewayCredentialProvider, GatewayProviderSecret | undefined>>
  #baseUrls: Readonly<Record<GatewayCredentialProvider, string>>

  constructor(
    secrets: Record<GatewayCredentialProvider, GatewayProviderSecret | undefined>,
    baseUrls: Record<GatewayCredentialProvider, string>,
  ) {
    this.#secrets = Object.freeze({ ...secrets })
    this.#baseUrls = Object.freeze({ ...baseUrls })
  }

  bearerAuthorization(provider: GatewayCredentialProvider): string | undefined {
    return this.#secrets[provider]?.bearerAuthorization()
  }

  baseUrl(provider: GatewayCredentialProvider): string {
    return this.#baseUrls[provider]
  }

  view(provider: GatewayCredentialProvider): GatewayProviderCredentialView {
    return {
      provider,
      secret_slot: GATEWAY_PROVIDER_SECRET_SLOTS[provider],
      secret_configured: this.#secrets[provider] !== undefined,
      base_url: this.#baseUrls[provider],
    }
  }

  toJSON(): { providers: GatewayProviderCredentialView[] } {
    return { providers: PROVIDERS.map(provider => this.view(provider)) }
  }

  [inspect.custom](): string {
    return `GatewayProviderCredentials ${JSON.stringify(this.toJSON())}`
  }
}

const PROVIDERS = Object.freeze(Object.keys(GATEWAY_PROVIDER_SECRET_SLOTS) as GatewayCredentialProvider[])

export function loadGatewayProviderCredentials(environment: GatewayCredentialsEnvironment = process.env): GatewayProviderCredentials {
  const secrets = {} as Record<GatewayCredentialProvider, GatewayProviderSecret | undefined>
  const baseUrls = {} as Record<GatewayCredentialProvider, string>
  for (const provider of PROVIDERS) {
    const secret = environment[GATEWAY_PROVIDER_SECRET_SLOTS[provider]]?.trim()
    secrets[provider] = secret ? new GatewayProviderSecret(secret) : undefined
    const baseSlot = GATEWAY_PROVIDER_BASE_URL_SLOTS[provider]
    baseUrls[provider] = parseGatewayHttpsBaseUrl(environment[baseSlot], baseSlot, PROVIDER_BASE_URL_DEFAULTS[provider])
  }
  return new GatewayProviderCredentials(secrets, baseUrls)
}

/** Resolve a provider endpoint without accepting protocol downgrade, URL credentials, or query injection. */
export function parseGatewayHttpsBaseUrl(value: string | undefined, slot: string, fallback: string): string {
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
