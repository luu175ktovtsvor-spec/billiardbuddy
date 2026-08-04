import {
  ProviderAdmissionGate,
  ProviderRateLimiter,
  type ProviderAdmissionConfig,
  type ProviderAdmissionOptions,
  type ProviderAdmissionPermit,
  type ProviderAdmissionSnapshot,
} from '../ts/shared/kernel/providerAdmission.js'

export type RelayCapacityEnvironment = Readonly<Record<string, string | undefined>>
export type RelayImageProvider = 'openai' | 'seedream'

export type RelayProviderCapacity = {
  /** Versioned physical-account binding. Capacity and quota consumers must use
   * this key rather than the provider name, which survives account rotation. */
  account_key: string
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

/** Gateway identity runs before a trusted owner exists, so it has a separate
 * shared envelope rather than inheriting a caller-controlled owner lane. */
export type RelayIdentityAdmissionCapacity = {
  max_active: number
  max_queued: number
  max_wait_ms: number
}
export const DEFAULT_RELAY_IDENTITY_ADMISSION_CAPACITY: RelayIdentityAdmissionCapacity = Object.freeze({
  max_active: 8,
  max_queued: 32,
  max_wait_ms: 10_000,
})

export type RelayCapacityPolicy = {
  revision: string
  providers: Record<RelayImageProvider, RelayProviderCapacity>
  admission: RelayAdmissionCapacity
  identity_admission: RelayIdentityAdmissionCapacity
}

/** One provider-account admission decision contains both a concurrent-execution
 * lease and an RPM reservation. Route code must not know whether either is
 * process-local today or a fenced, shared lease tomorrow. */
export type RelayProviderAdmissionConfig = {
  provider: RelayImageProvider
  account_key: string
  concurrency: ProviderAdmissionConfig
  requests_per_minute: number
  rate_queue_max: number
}
export type RelayProviderAdmissionAcquireOptions = ProviderAdmissionOptions & {
  rate_limit_wait_seconds: number
}
export type RelayRateAdmissionSnapshot = {
  available: number
  queued: number
  rpm: number
  queueMax: number
}
export type RelayProviderAdmissionSnapshot = ProviderAdmissionSnapshot & {
  rate: RelayRateAdmissionSnapshot
}
/** The current production backend is process-local. `assertCurrent` fixes the
 * provider call boundary, but it is not by itself a multi-worker task-claim
 * protocol; a shared backend also requires a durable TaskStore write fence. */
export type RelayAdmissionPermit = ProviderAdmissionPermit
export type RelayProviderAdmission = {
  /** Holds the task-wide execution lease.  A Seedream task can issue several
   * billable generation POSTs while retaining this one concurrency permit. */
  acquire(owner: string, options: RelayProviderAdmissionAcquireOptions): Promise<RelayAdmissionPermit>
  /** Reserves exactly one Provider request-rate slot.  This is deliberately
   * separate from `acquire`: asset downloads must not consume generation RPM,
   * while every billable generation POST must consume one slot. */
  acquireGenerationRate(options: RelayProviderAdmissionAcquireOptions): Promise<void>
  snapshot(): RelayProviderAdmissionSnapshot
}
export type RelayIdentityAdmission = {
  acquire(options?: ProviderAdmissionOptions): Promise<RelayAdmissionPermit>
}
/** The sole Relay capacity execution seam. It isolates scheduling policy from
 * handlers. Multi-replica execution additionally needs a durable task claim
 * and fenced terminal writes; swapping this interface alone is insufficient. */
export type RelayAdmissionBackend = {
  createProviderAdmission(config: RelayProviderAdmissionConfig): RelayProviderAdmission
  createIdentityAdmission(config: ProviderAdmissionConfig): RelayIdentityAdmission
}

export const localRelayAdmissionBackend: RelayAdmissionBackend = Object.freeze({
  createProviderAdmission(config) {
    const concurrency = new ProviderAdmissionGate(config.concurrency)
    const rate = new ProviderRateLimiter(config.requests_per_minute, config.rate_queue_max)
    return {
      async acquire(owner, options) {
        return await concurrency.acquire(owner, options)
      },
      async acquireGenerationRate(options) {
        await rate.acquire(options.rate_limit_wait_seconds, options.signal)
      },
      snapshot() { return { ...concurrency.snapshot(), rate: rate.snapshot() } },
    }
  },
  createIdentityAdmission(config) {
    const admission = new ProviderAdmissionGate(config)
    return { async acquire(options = {}) { return await admission.acquire('gateway-introspection', options) } }
  },
})

export function relayIdentityAdmissionConfig(capacity: RelayIdentityAdmissionCapacity): ProviderAdmissionConfig {
  return {
    maxActive: capacity.max_active,
    maxActivePerOwner: capacity.max_active,
    maxQueued: capacity.max_queued,
    maxQueuedPerOwner: capacity.max_queued,
    maxWaitMs: capacity.max_wait_ms,
  }
}

export const RELAY_CAPACITY_POLICY_REVISION_ENV = 'RELAY_CAPACITY_POLICY_REVISION'
export const RELAY_OPENAI_ACCOUNT_REF_ENV = 'RELAY_OPENAI_ACCOUNT_REF'
export const RELAY_OPENAI_ACCOUNT_BINDING_REVISION_ENV = 'RELAY_OPENAI_ACCOUNT_BINDING_REVISION'
export const RELAY_SEEDREAM_ACCOUNT_REF_ENV = 'RELAY_SEEDREAM_ACCOUNT_REF'
export const RELAY_SEEDREAM_ACCOUNT_BINDING_REVISION_ENV = 'RELAY_SEEDREAM_ACCOUNT_BINDING_REVISION'

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
        account_key: providerAccountKey(environment, 'openai'),
        concurrency: openaiConcurrency,
        owner_concurrency: boundedPositiveInteger(environment, 'RELAY_IMG_USER_CONC', 1, MAX_PROVIDER_CONCURRENCY),
        requests_per_minute: boundedPositiveInteger(environment, 'RELAY_OPENAI_RPM', 12, MAX_PROVIDER_RPM),
        upstream_timeout_ms: boundedPositiveInteger(environment, 'RELAY_UPSTREAM_TIMEOUT_MS', 5 * 60_000, MAX_UPSTREAM_TIMEOUT_MS, MIN_UPSTREAM_TIMEOUT_MS),
      },
      seedream: {
        account_key: providerAccountKey(environment, 'seedream'),
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
    identity_admission: {
      max_active: boundedPositiveInteger(environment, 'RELAY_IDENTITY_MAX_ACTIVE', DEFAULT_RELAY_IDENTITY_ADMISSION_CAPACITY.max_active, MAX_PROVIDER_CONCURRENCY),
      max_queued: boundedPositiveInteger(environment, 'RELAY_IDENTITY_QUEUE_MAX', DEFAULT_RELAY_IDENTITY_ADMISSION_CAPACITY.max_queued, MAX_QUEUE_TASKS),
      max_wait_ms: boundedPositiveInteger(environment, 'RELAY_IDENTITY_MAX_WAIT_MS', DEFAULT_RELAY_IDENTITY_ADMISSION_CAPACITY.max_wait_ms, MAX_UPSTREAM_TIMEOUT_MS),
    },
  }
  validateRelationships(policy)
  return freezePolicy(policy)
}

function providerAccountKey(environment: RelayCapacityEnvironment, provider: RelayImageProvider): string {
  const accountRefName = provider === 'openai' ? RELAY_OPENAI_ACCOUNT_REF_ENV : RELAY_SEEDREAM_ACCOUNT_REF_ENV
  const bindingRevisionName = provider === 'openai'
    ? RELAY_OPENAI_ACCOUNT_BINDING_REVISION_ENV
    : RELAY_SEEDREAM_ACCOUNT_BINDING_REVISION_ENV
  const accountRef = accountBindingComponent(environment, accountRefName, `${provider}-managed-default`)
  const bindingRevision = accountBindingComponent(environment, bindingRevisionName, 'legacy-v1')
  return `image:${provider}:${accountRef}@${bindingRevision}`
}

function accountBindingComponent(
  environment: RelayCapacityEnvironment,
  name: string,
  fallback: string,
): string {
  const value = environment[name]?.trim() || fallback
  // `@` is intentionally excluded because it separates the account reference
  // from its binding revision in the durable account key.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new Error(`${name} must be 1-128 ASCII letters, digits, dots, underscores, colons, slashes, or hyphens`)
  }
  return value
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
  Object.freeze(policy.identity_admission)
  return Object.freeze(policy)
}
