/**
 * Gateway resource governance.  This is deliberately the single place that turns
 * deployment environment into scheduling limits.  A malformed value is never
 * silently replaced with a more permissive fallback: the gateway must fail before
 * it starts accepting traffic.
 */

export type CapacityPolicyEnv = Record<string, string | undefined>

export type GatewayProviderAccount = 'deepseek' | 'mimo' | 'qwen' | 'funasr'

/** A deployment-owned physical provider account binding. It never contains a
 * secret or credential fingerprint, but its revision makes a rebind explicit
 * to a future shared capacity backend. */
export type GatewayProviderAccountScope = {
  kind: 'provider-account'
  account_key: string
  scope_key: string
}

export type GatewayBootstrapScope = {
  kind: 'bootstrap'
  scope_key: 'gateway-bootstrap'
}

export type GatewayIngressScope = {
  kind: 'ingress'
  scope_key: 'gateway-ingress'
}

export type GatewayProviderAccountBinding = {
  account_ref: string
  binding_revision: string
  account_key: string
  scope: GatewayProviderAccountScope
}

type ProviderCapacityLimits = {
  rpm: number
  maxConcurrent: number
  maxConcurrentPerUser: number
  maxConcurrentPerToken: number
  maxInflightPerUser: number
  queueMax: number
  queueMaxWaitMs: number
  responseTimeoutMs: number
}
export type ProviderCapacityPolicy = ProviderCapacityLimits & GatewayProviderAccountBinding

type MimoCapacityLimits = {
  /** One physical MiMo account is partitioned between media reasoning and visual evidence. */
  rpm: number
  maxConcurrent: number
  mediaConcurrent: number
  visionConcurrent: number
  maxConcurrentPerUser: number
  maxConcurrentPerToken: number
  maxInflightPerUser: number
  mediaQueueMax: number
  visionQueueMax: number
  mediaQueueMaxWaitMs: number
  visionQueueMaxWaitMs: number
  visionMaxConcurrentPerUser: number
  visionMaxInflightPerUser: number
  visionPerRequestConcurrent: number
  visionTimeoutMs: number
}
export type MimoCapacityPolicy = MimoCapacityLimits & GatewayProviderAccountBinding

type FunAsrCapacityLimits = {
  rpm: number
  maxConcurrent: number
  maxConcurrentPerUser: number
  maxConcurrentPerToken: number
  maxInflightPerUser: number
  queueMax: number
  queueMaxWaitMs: number
  maxBytes: number
  timeoutMs: number
}
export type FunAsrCapacityPolicy = FunAsrCapacityLimits & GatewayProviderAccountBinding

export type BootstrapCapacityPolicy = {
  rpm: number
  queueMax: number
  queueMaxWaitMs: number
  /** Authentication shaping is operational capacity, never a model account. */
  scope: GatewayBootstrapScope
}

export type IngressCapacityPolicy = {
  inflightBodyBytes: number
  bodyReadTimeoutMs: number
  serverIdleTimeoutSeconds: number
  /** Ingress reserves Gateway memory, not provider capacity. */
  scope: GatewayIngressScope
}

export type GatewayCapacityPolicy = {
  revision: string
  deepseek: ProviderCapacityPolicy
  /** Reserved shared account lanes; visual and media work must add up exactly. */
  mimo: MimoCapacityPolicy
  /** Reserved for a later Qwen adapter. It is intentionally not a MiMo lane. */
  qwen: ProviderCapacityPolicy
  funasr: FunAsrCapacityPolicy
  /** Authentication request shaping is operational capacity, even though it
   * does not consume a model account. Keep it in the same external policy. */
  bootstrap: BootstrapCapacityPolicy
  ingress: IngressCapacityPolicy
}

export const GATEWAY_CAPACITY_POLICY_REVISION_ENV = 'GW_CAPACITY_POLICY_REVISION'

const LIMITS = {
  rpm: 1_000_000,
  concurrency: 10_000,
  queue: 100_000,
  durationMs: 30 * 60_000,
  bytes: 1024 * 1024 * 1024,
} as const

function supplied(env: CapacityPolicyEnv, name: string): boolean {
  return env[name]?.trim() !== '' && env[name] !== undefined
}

function integer(env: CapacityPolicyEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim() ?? ''
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a decimal integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return value
}

/** Existing queue-wait variables are expressed in seconds; expose one unit (ms) to callers. */
function queueWaitSeconds(env: CapacityPolicyEnv, name: string, fallbackSeconds: number): number {
  const raw = env[name]?.trim() ?? ''
  if (!raw) return fallbackSeconds * 1_000
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${name} must be a non-negative decimal number of seconds`)
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > LIMITS.durationMs / 1_000) {
    throw new Error(`${name} must be between 0 and ${LIMITS.durationMs / 1_000}`)
  }
  return Math.round(seconds * 1_000)
}

function requireAtMost(name: string, value: number, ceilingName: string, ceiling: number): void {
  if (value > ceiling) throw new Error(`${name} must not exceed ${ceilingName}`)
}

function providerPolicy(
  env: CapacityPolicyEnv,
  names: { rpm: string; conc: string; userConc: string; tokenConc: string; inflightPerUser: string; queueMax: string; queueWait: string; timeout: string },
  defaults: ProviderCapacityLimits,
): ProviderCapacityLimits {
  const maxConcurrent = integer(env, names.conc, defaults.maxConcurrent, 1, LIMITS.concurrency)
  // A deployment that only lowers its existing global ceiling keeps working. An
  // explicitly supplied per-user/per-token value still has to fit that ceiling.
  const maxConcurrentPerUser = integer(env, names.userConc, Math.min(defaults.maxConcurrentPerUser, maxConcurrent), 1, LIMITS.concurrency)
  const maxConcurrentPerToken = integer(env, names.tokenConc, Math.min(defaults.maxConcurrentPerToken, maxConcurrent), 1, LIMITS.concurrency)
  const maxInflightPerUser = integer(env, names.inflightPerUser, Math.max(defaults.maxInflightPerUser, maxConcurrentPerUser), 1, LIMITS.concurrency)
  requireAtMost(names.userConc, maxConcurrentPerUser, names.conc, maxConcurrent)
  requireAtMost(names.tokenConc, maxConcurrentPerToken, names.conc, maxConcurrent)
  requireAtMost(names.userConc, maxConcurrentPerUser, names.inflightPerUser, maxInflightPerUser)
  return {
    rpm: integer(env, names.rpm, defaults.rpm, 1, LIMITS.rpm),
    maxConcurrent,
    maxConcurrentPerUser,
    maxConcurrentPerToken,
    maxInflightPerUser,
    queueMax: integer(env, names.queueMax, defaults.queueMax, 0, LIMITS.queue),
    queueMaxWaitMs: queueWaitSeconds(env, names.queueWait, defaults.queueMaxWaitMs / 1_000),
    responseTimeoutMs: integer(env, names.timeout, defaults.responseTimeoutMs, 1, LIMITS.durationMs),
  }
}

/**
 * Load the deliberately small default profile.  Operators may tune every value
 * through its existing environment name, but every supplied value is parsed and
 * bounded before a server can start.
 */
export function loadCapacityPolicy(env: CapacityPolicyEnv = process.env): GatewayCapacityPolicy {
  const deepseek = { ...providerPolicy(env, {
    rpm: 'GW_DEEPSEEK_RPM', conc: 'GW_DEEPSEEK_CONC', userConc: 'GW_DEEPSEEK_USER_CONC',
    tokenConc: 'GW_DEEPSEEK_TOKEN_CONC', queueMax: 'GW_DEEPSEEK_QUEUE_MAX',
    inflightPerUser: 'GW_DEEPSEEK_INFLIGHT_PER_USER',
    queueWait: 'GW_DEEPSEEK_QUEUE_MAX_WAIT', timeout: 'GW_DEEPSEEK_RESPONSE_TIMEOUT_MS',
  }, {
    rpm: 120, maxConcurrent: 8, maxConcurrentPerUser: 2, maxConcurrentPerToken: 4, maxInflightPerUser: 4,
    queueMax: 24, queueMaxWaitMs: 5_000, responseTimeoutMs: 120_000,
  }), ...providerAccountBinding(env, 'DEEPSEEK', 'deepseek', 'local-deepseek-account') }

  const mimoTotal = integer(env, 'GW_MIMO_CONC', 8, 2, LIMITS.concurrency)
  const defaultVision = Math.min(3, mimoTotal - 1)
  const visionConcurrent = supplied(env, 'GW_VISION_CONC')
    ? integer(env, 'GW_VISION_CONC', defaultVision, 1, mimoTotal - 1)
    : supplied(env, 'GW_MIMO_MEDIA_CONC')
      ? mimoTotal - integer(env, 'GW_MIMO_MEDIA_CONC', mimoTotal - defaultVision, 1, mimoTotal - 1)
      : defaultVision
  const mediaConcurrent = supplied(env, 'GW_MIMO_MEDIA_CONC')
    ? integer(env, 'GW_MIMO_MEDIA_CONC', mimoTotal - visionConcurrent, 1, mimoTotal - 1)
    : mimoTotal - visionConcurrent
  if (mediaConcurrent + visionConcurrent !== mimoTotal) {
    throw new Error('GW_MIMO_MEDIA_CONC + GW_VISION_CONC must equal GW_MIMO_CONC')
  }
  const mimoUserConc = integer(env, 'GW_MIMO_USER_CONC', 1, 1, mimoTotal)
  const mimoTokenConc = integer(env, 'GW_MIMO_TOKEN_CONC', 2, 1, mimoTotal)
  const mimoInflightPerUser = integer(env, 'GW_MIMO_INFLIGHT_PER_USER', 1, 1, LIMITS.concurrency)
  const visionPerClientConc = integer(env, 'GW_VISION_PER_CLIENT_CONC', 1, 1, visionConcurrent)
  const visionMaxInflightPerClient = integer(env, 'GW_VISION_MAX_INFLIGHT_PER_CLIENT', 1, 1, LIMITS.concurrency)
  const visionPerRequestConcurrent = integer(env, 'GW_VISION_PER_REQUEST_CONC', 1, 1, visionConcurrent)
  requireAtMost('GW_VISION_PER_REQUEST_CONC', visionPerRequestConcurrent, 'GW_VISION_PER_CLIENT_CONC', visionPerClientConc)
  requireAtMost('GW_VISION_PER_REQUEST_CONC', visionPerRequestConcurrent, 'GW_VISION_MAX_INFLIGHT_PER_CLIENT', visionMaxInflightPerClient)

  const qwen = { ...providerPolicy(env, {
    rpm: 'GW_QWEN_RPM', conc: 'GW_QWEN_CONC', userConc: 'GW_QWEN_USER_CONC', tokenConc: 'GW_QWEN_TOKEN_CONC',
    inflightPerUser: 'GW_QWEN_INFLIGHT_PER_USER',
    queueMax: 'GW_QWEN_QUEUE_MAX', queueWait: 'GW_QWEN_QUEUE_MAX_WAIT', timeout: 'GW_QWEN_RESPONSE_TIMEOUT_MS',
  }, {
    rpm: 60, maxConcurrent: 4, maxConcurrentPerUser: 1, maxConcurrentPerToken: 2, maxInflightPerUser: 2,
    queueMax: 12, queueMaxWaitMs: 3_000, responseTimeoutMs: 60_000,
  }), ...providerAccountBinding(env, 'QWEN', 'qwen', 'local-qwen-account') }
  const funAsrMaxConcurrent = integer(env, 'GW_TRANSCRIBE_CONC', 1, 1, LIMITS.concurrency)
  const funAsrMaxConcurrentPerUser = integer(env, 'GW_TRANSCRIBE_USER_CONC', 1, 1, funAsrMaxConcurrent)
  const funAsrMaxConcurrentPerToken = integer(env, 'GW_TRANSCRIBE_TOKEN_CONC', funAsrMaxConcurrent, 1, funAsrMaxConcurrent)
  const funAsrMaxInflightPerUser = integer(env, 'GW_TRANSCRIBE_INFLIGHT_PER_USER', funAsrMaxConcurrentPerUser, funAsrMaxConcurrentPerUser, LIMITS.concurrency)

  return {
    revision: capacityPolicyRevision(env),
    deepseek,
    mimo: {
      rpm: integer(env, 'GW_MIMO_RPM', 60, 1, LIMITS.rpm),
      maxConcurrent: mimoTotal,
      mediaConcurrent,
      visionConcurrent,
      maxConcurrentPerUser: mimoUserConc,
      maxConcurrentPerToken: mimoTokenConc,
      maxInflightPerUser: mimoInflightPerUser,
      mediaQueueMax: integer(env, 'GW_MIMO_QUEUE_MAX', 16, 0, LIMITS.queue),
      visionQueueMax: integer(env, 'GW_VISION_QUEUE_MAX', 8, 0, LIMITS.queue),
      mediaQueueMaxWaitMs: queueWaitSeconds(env, 'GW_MIMO_QUEUE_MAX_WAIT', 3),
      visionQueueMaxWaitMs: integer(env, 'GW_VISION_QUEUE_MAX_WAIT_MS', 2_000, 0, LIMITS.durationMs),
      visionMaxConcurrentPerUser: visionPerClientConc,
      visionMaxInflightPerUser: visionMaxInflightPerClient,
      visionPerRequestConcurrent,
      visionTimeoutMs: integer(env, 'GW_VISION_TIMEOUT_MS', 30_000, 1, LIMITS.durationMs),
      ...providerAccountBinding(env, 'MIMO', 'mimo', 'local-mimo-account'),
    },
    qwen,
    funasr: {
      rpm: integer(env, 'GW_TRANSCRIBE_RPM', 6, 1, LIMITS.rpm),
      maxConcurrent: funAsrMaxConcurrent,
      maxConcurrentPerUser: funAsrMaxConcurrentPerUser,
      maxConcurrentPerToken: funAsrMaxConcurrentPerToken,
      maxInflightPerUser: funAsrMaxInflightPerUser,
      queueMax: integer(env, 'GW_TRANSCRIBE_QUEUE_MAX', 4, 0, LIMITS.queue),
      queueMaxWaitMs: queueWaitSeconds(env, 'GW_QUEUE_MAX_WAIT', 15),
      maxBytes: integer(env, 'GW_TRANSCRIBE_MAX_BYTES', 64 * 1024 * 1024, 1, LIMITS.bytes),
      timeoutMs: integer(env, 'GW_TRANSCRIBE_TIMEOUT_MS', 180_000, 1, LIMITS.durationMs),
      ...providerAccountBinding(env, 'FUNASR', 'funasr', 'local-funasr-account'),
    },
    bootstrap: {
      rpm: integer(env, 'GW_BOOTSTRAP_RPM', 30, 1, LIMITS.rpm),
      queueMax: integer(env, 'GW_BOOTSTRAP_QUEUE_MAX', 0, 0, LIMITS.queue),
      queueMaxWaitMs: queueWaitSeconds(env, 'GW_BOOTSTRAP_QUEUE_MAX_WAIT', 0),
      scope: { kind: 'bootstrap', scope_key: 'gateway-bootstrap' },
    },
    ingress: {
      inflightBodyBytes: integer(env, 'GW_INGRESS_INFLIGHT_BODY_BYTES', 64 * 1024 * 1024, 1, LIMITS.bytes),
      bodyReadTimeoutMs: integer(env, 'GW_INGRESS_BODY_READ_TIMEOUT_MS', 30_000, 1, LIMITS.durationMs),
      serverIdleTimeoutSeconds: integer(env, 'GW_SERVER_IDLE_TIMEOUT_SECONDS', 120, 30, 255),
      scope: { kind: 'ingress', scope_key: 'gateway-ingress' },
    },
  }
}

function providerAccountBinding(
  env: CapacityPolicyEnv,
  environmentPrefix: 'DEEPSEEK' | 'MIMO' | 'QWEN' | 'FUNASR',
  provider: GatewayProviderAccount,
  fallbackRef: string,
): GatewayProviderAccountBinding {
  const account_ref = accountBindingComponent(env, `GW_${environmentPrefix}_ACCOUNT_REF`, fallbackRef)
  const binding_revision = accountBindingComponent(env, `GW_${environmentPrefix}_ACCOUNT_BINDING_REVISION`, 'local-v1')
  const account_key = `gateway-${provider}-account:${account_ref}:${binding_revision}`
  return {
    account_ref,
    binding_revision,
    account_key,
    scope: { kind: 'provider-account', account_key, scope_key: account_key },
  }
}

function accountBindingComponent(env: CapacityPolicyEnv, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${name} must be 1-128 ASCII letters, digits, dots, underscores, or hyphens`)
  }
  return value
}

function capacityPolicyRevision(env: CapacityPolicyEnv): string {
  const value = env[GATEWAY_CAPACITY_POLICY_REVISION_ENV]
  if (value === undefined || value.trim() === '') return 'gateway-small-v1'
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error(`${GATEWAY_CAPACITY_POLICY_REVISION_ENV} must be 1-128 ASCII letters, digits, dots, underscores, or hyphens`)
  }
  return value
}
