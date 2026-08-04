/**
 * Paid image work is charged from this explicit deployment policy rather than
 * from model defaults hidden in the worker.  Model Catalog supplies the
 * versioned per-output upper bound; this policy supplies who may spend it.
 */
export type ImageQuotaEnvironment = Readonly<Record<string, string | undefined>>

export type ImageRelayQuotaPolicy = {
  revision: string
  /** Trusted Gateway-derived owner, aggregated across OpenAI and Seedream. */
  owner_daily_usd_minor_limit: number
  /** One physical credential/account per provider. */
  provider_daily_usd_minor_limit: {
    openai: number
    seedream: number
  }
}

export const IMAGE_RELAY_QUOTA_POLICY_ENVIRONMENT_VARIABLES = [
  'RELAY_QUOTA_POLICY_REVISION',
  'RELAY_OWNER_DAILY_USD_MINOR_LIMIT',
  'RELAY_OPENAI_DAILY_USD_MINOR_LIMIT',
  'RELAY_SEEDREAM_DAILY_USD_MINOR_LIMIT',
] as const

const MAX_DAILY_USD_MINOR_LIMIT = 1_000_000_000

function nonNegativeInteger(
  environment: ImageQuotaEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative decimal integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > MAX_DAILY_USD_MINOR_LIMIT) {
    throw new Error(`${name} must be between 0 and ${MAX_DAILY_USD_MINOR_LIMIT}`)
  }
  return value
}

function revision(environment: ImageQuotaEnvironment): string {
  const value = environment.RELAY_QUOTA_POLICY_REVISION?.trim()
  if (!value) return 'relay-image-quota-small-v1'
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error('RELAY_QUOTA_POLICY_REVISION must be 1-128 ASCII letters, digits, dots, underscores, or hyphens')
  }
  return value
}

/** Defaults exist only for local tests and a single local developer process. */
export function imageRelayQuotaPolicyFromEnvironment(
  environment: ImageQuotaEnvironment = process.env,
): ImageRelayQuotaPolicy {
  return Object.freeze({
    revision: revision(environment),
    owner_daily_usd_minor_limit: nonNegativeInteger(environment, 'RELAY_OWNER_DAILY_USD_MINOR_LIMIT', 10_000),
    provider_daily_usd_minor_limit: Object.freeze({
      openai: nonNegativeInteger(environment, 'RELAY_OPENAI_DAILY_USD_MINOR_LIMIT', 100_000),
      seedream: nonNegativeInteger(environment, 'RELAY_SEEDREAM_DAILY_USD_MINOR_LIMIT', 100_000),
    }),
  })
}
