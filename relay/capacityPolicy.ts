export type RelayCapacityEnvironment = Readonly<Record<string, string | undefined>>
export type RelayImageProvider = 'openai' | 'seedream'

export type RelayProviderCapacity = {
  concurrency: number
  owner_concurrency: number
  requests_per_minute: number
  upstream_timeout_ms: number
}

export type RelayAdmissionCapacity = {
  queue_max: number
  owner_task_max: number
  max_body_bytes: number
  pending_input_bytes_max: number
  active_input_bytes_max: number
}

export type RelayCapacityPolicy = {
  revision: string
  providers: Record<RelayImageProvider, RelayProviderCapacity>
  admission: RelayAdmissionCapacity
}

export const RELAY_CAPACITY_POLICY_REVISION_ENV = 'RELAY_CAPACITY_POLICY_REVISION'

const MAX_PROVIDER_CONCURRENCY = 16
const MAX_PROVIDER_RPM = 120
const MIN_UPSTREAM_TIMEOUT_MS = 1_000
const MAX_UPSTREAM_TIMEOUT_MS = 10 * 60_000
const MAX_QUEUE_TASKS = 200
const MAX_OWNER_TASKS = 10
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_PENDING_INPUT_BYTES = 64 * 1024 * 1024
const MAX_ACTIVE_INPUT_BYTES = 256 * 1024 * 1024

/**
 * The Relay's bounded small-scale admission envelope. Existing deployment
 * variable names are retained; the two RPM values are added here for the
 * account-level admission gate that consumes this policy.
 */
export const DEFAULT_RELAY_CAPACITY_POLICY: RelayCapacityPolicy = relayCapacityPolicyFromEnvironment()

export function relayCapacityPolicyFromEnvironment(environment: RelayCapacityEnvironment = process.env): RelayCapacityPolicy {
  const openaiConcurrency = boundedPositiveInteger(environment, 'RELAY_IMG_CONC', 2, MAX_PROVIDER_CONCURRENCY)
  const seedreamConcurrency = boundedPositiveInteger(environment, 'RELAY_SEEDREAM_CONC', 2, MAX_PROVIDER_CONCURRENCY)
  const policy: RelayCapacityPolicy = {
    revision: revision(environment),
    providers: {
      openai: {
        concurrency: openaiConcurrency,
        owner_concurrency: boundedPositiveInteger(environment, 'RELAY_IMG_USER_CONC', 1, MAX_PROVIDER_CONCURRENCY),
        requests_per_minute: boundedPositiveInteger(environment, 'RELAY_OPENAI_RPM', 12, MAX_PROVIDER_RPM),
        upstream_timeout_ms: boundedPositiveInteger(environment, 'RELAY_UPSTREAM_TIMEOUT_MS', 5 * 60_000, MAX_UPSTREAM_TIMEOUT_MS, MIN_UPSTREAM_TIMEOUT_MS),
      },
      seedream: {
        concurrency: seedreamConcurrency,
        owner_concurrency: boundedPositiveInteger(environment, 'RELAY_SEEDREAM_USER_CONC', 1, MAX_PROVIDER_CONCURRENCY),
        requests_per_minute: boundedPositiveInteger(environment, 'RELAY_SEEDREAM_RPM', 30, MAX_PROVIDER_RPM),
        upstream_timeout_ms: boundedPositiveInteger(environment, 'RELAY_UPSTREAM_TIMEOUT_MS', 5 * 60_000, MAX_UPSTREAM_TIMEOUT_MS, MIN_UPSTREAM_TIMEOUT_MS),
      },
    },
    admission: {
      queue_max: boundedPositiveInteger(environment, 'RELAY_QUEUE_MAX', 24, MAX_QUEUE_TASKS),
      owner_task_max: boundedPositiveInteger(environment, 'RELAY_USER_MAX', 4, MAX_OWNER_TASKS),
      max_body_bytes: boundedPositiveInteger(environment, 'RELAY_MAX_BODY_BYTES', 32 * 1024 * 1024, MAX_BODY_BYTES),
      pending_input_bytes_max: boundedPositiveInteger(environment, 'RELAY_PENDING_INPUT_BYTES_MAX', 64 * 1024 * 1024, MAX_PENDING_INPUT_BYTES),
      active_input_bytes_max: boundedPositiveInteger(environment, 'RELAY_ACTIVE_INPUT_BYTES_MAX', 256 * 1024 * 1024, MAX_ACTIVE_INPUT_BYTES),
    },
  }
  validateRelationships(policy)
  return freezePolicy(policy)
}

function revision(environment: RelayCapacityEnvironment): string {
  const value = environment[RELAY_CAPACITY_POLICY_REVISION_ENV]
  if (value === undefined) return 'relay-image-small-scale-v1'
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${RELAY_CAPACITY_POLICY_REVISION_ENV} must be 1-128 ASCII letters, digits, dots, underscores, or hyphens`)
  }
  return value
}

function boundedPositiveInteger(
  environment: RelayCapacityEnvironment,
  name: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const value = environment[name]
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return parsed
}

function validateRelationships(policy: RelayCapacityPolicy): void {
  for (const provider of ['openai', 'seedream'] as const) {
    if (policy.providers[provider].owner_concurrency > policy.providers[provider].concurrency) {
      throw new Error(`${provider} owner concurrency must not exceed provider concurrency`)
    }
  }
  const { admission } = policy
  if (admission.owner_task_max > admission.queue_max) {
    throw new Error('RELAY_USER_MAX must not exceed RELAY_QUEUE_MAX')
  }
  if (admission.pending_input_bytes_max > admission.active_input_bytes_max) {
    throw new Error('RELAY_PENDING_INPUT_BYTES_MAX must not exceed RELAY_ACTIVE_INPUT_BYTES_MAX')
  }
  if (admission.max_body_bytes > admission.pending_input_bytes_max) {
    throw new Error('RELAY_MAX_BODY_BYTES must not exceed RELAY_PENDING_INPUT_BYTES_MAX')
  }
}

function freezePolicy(policy: RelayCapacityPolicy): RelayCapacityPolicy {
  for (const provider of Object.values(policy.providers)) Object.freeze(provider)
  Object.freeze(policy.providers)
  Object.freeze(policy.admission)
  return Object.freeze(policy)
}
