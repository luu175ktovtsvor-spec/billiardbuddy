import type { ManagedModelWorkload } from '../ts/shared/product/providerContracts.js'
import {
  ProviderAdmissionGate,
  ProviderRateLimiter,
  type ProviderAdmissionConfig,
  type ProviderAdmissionOptions,
  type ProviderAdmissionPermit,
} from '../ts/shared/kernel/providerAdmission.js'

export type VideoMediaCapacityEnvironment = Readonly<Record<string, string | undefined>>
export type VideoMediaCapacityLane = 'visual' | 'reasoning' | 'asr' | 'embedding'

export type VideoMediaAdmissionCapacity = {
  max_active: number
  max_active_per_owner: number
  max_queued: number
  max_queued_per_owner: number
  max_wait_ms: number
}

export type VideoMediaRateCapacity = {
  requests_per_minute: number
}

/** The current physical DashScope account binding. The logical pool name stays
 * stable in the shared catalog; this deployment-owned key distinguishes the
 * credential/account and binding revision that actually carry its limits. */
export type VideoMediaAccountCapacity = VideoMediaAdmissionCapacity & VideoMediaRateCapacity & {
  account_ref: string
  binding_revision: string
  account_key: string
}

export type VideoMediaCapacityPolicy = {
  revision: string
  /** One physical DashScope credential/account.  The lane gates below do not
   * turn it into four independent accounts; this gate is always acquired too. */
  account: VideoMediaAccountCapacity
  lanes: Record<VideoMediaCapacityLane, VideoMediaAdmissionCapacity & VideoMediaRateCapacity>
}

/**
 * Reading an OSS object is real, untrusted I/O rather than a metadata lookup.
 * Keep that verification pool separate from provider capacity so a slow or
 * malicious upload cannot consume the DashScope admission envelope.
 */
export type VideoMediaObjectVerificationPolicy = {
  max_active: number
  max_active_per_owner: number
  max_queued: number
  max_queued_per_owner: number
  max_wait_ms: number
  timeout_ms: number
}

/** Identity is resolved before an installation owner is known, so this is a
 * shared authority envelope rather than an owner-fair workload lane. */
export type VideoMediaIdentityAdmissionPolicy = {
  max_active: number
  max_queued: number
  max_wait_ms: number
}

/** Business paths depend on this narrow permit factory. A future distributed
 * lease backend can replace it without changing Relay route call sites. */
export type VideoMediaAdmissionGate = {
  acquire(owner: string, options?: ProviderAdmissionOptions): Promise<ProviderAdmissionPermit>
}
export type VideoMediaRateGate = {
  acquire(maxWaitSeconds: number, signal?: AbortSignal): Promise<void>
}

/**
 * A backend scope identifies the resource coordinated by an admission or rate
 * gate. `provider-lane` deliberately carries the parent account key but is
 * not itself an account: callers always acquire the outer provider-account
 * gate as the physical DashScope ceiling.
 */
export type VideoMediaAdmissionScope =
  | { kind: 'provider-account'; account_key: string; scope_key: string }
  | { kind: 'provider-lane'; account_key: string; lane: VideoMediaCapacityLane; scope_key: string }
  | { kind: 'object-verification'; scope_key: 'video-media-object-verification' }
  | { kind: 'gateway-identity'; scope_key: 'video-media-gateway-identity' }

export type VideoMediaAdmissionBackend = {
  createGate(config: ProviderAdmissionConfig, scope: VideoMediaAdmissionScope): VideoMediaAdmissionGate
  createRateGate(requestsPerMinute: number, maxQueued: number, scope: VideoMediaAdmissionScope): VideoMediaRateGate
}
export const localVideoMediaAdmissionBackend: VideoMediaAdmissionBackend = Object.freeze({
  createGate(config, _scope) { return new ProviderAdmissionGate(config) },
  createRateGate(requestsPerMinute, maxQueued, _scope) { return new ProviderRateLimiter(requestsPerMinute, maxQueued) },
})

const MAX_ACTIVE = 32
const MAX_QUEUED = 512
const MAX_RPM = 10_000
const MAX_WAIT_MS = 10 * 60_000
const ACCOUNT_BINDING_COMPONENT = /^[A-Za-z0-9._-]{1,128}$/

const LANE_WORKLOADS: Record<VideoMediaCapacityLane, ManagedModelWorkload> = {
  visual: 'video_visual_evidence',
  reasoning: 'video_media_reasoning',
  asr: 'video_speech_transcription',
  embedding: 'video_semantic_embedding',
}

export function videoMediaLaneForWorkload(workload: ManagedModelWorkload): VideoMediaCapacityLane {
  const lane = (Object.entries(LANE_WORKLOADS) as Array<[VideoMediaCapacityLane, ManagedModelWorkload]>).find(([, value]) => value === workload)?.[0]
  if (!lane) throw new Error(`video media workload has no DashScope lane: ${workload}`)
  return lane
}

/** Stable key for account-scoped policy and ledger rows. It deliberately never
 * contains a credential or its fingerprint. Rotating a credential for the
 * same account retains the ref/revision; moving the pool to another account
 * requires a new ref and/or binding revision. */
export function videoMediaDashscopeAccountKey(accountRef: string, bindingRevision: string): string {
  return `video-dashscope-account:${accountRef}:${bindingRevision}`
}

export function videoMediaProviderAccountScope(accountKey: string): VideoMediaAdmissionScope {
  return Object.freeze({ kind: 'provider-account', account_key: accountKey, scope_key: accountKey })
}

export function videoMediaProviderLaneScope(accountKey: string, lane: VideoMediaCapacityLane): VideoMediaAdmissionScope {
  return Object.freeze({ kind: 'provider-lane', account_key: accountKey, lane, scope_key: `${accountKey}:lane:${lane}` })
}

export const videoMediaObjectVerificationScope: VideoMediaAdmissionScope = Object.freeze({
  kind: 'object-verification', scope_key: 'video-media-object-verification',
})

export const videoMediaGatewayIdentityScope: VideoMediaAdmissionScope = Object.freeze({
  kind: 'gateway-identity', scope_key: 'video-media-gateway-identity',
})

/**
 * Capacity is policy, not code shape: all deployment values are external and
 * validated as a coherent envelope.  The defaults merely keep local tests and
 * a single small instance safe; production deployment validation requires each
 * value to be present explicitly.
 */
export function videoMediaCapacityPolicyFromEnvironment(environment: VideoMediaCapacityEnvironment = process.env): VideoMediaCapacityPolicy {
  const maxQueued = positive(environment, 'VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX', 32, MAX_QUEUED)
  const maxQueuedPerOwner = positive(environment, 'VIDEO_MEDIA_DASHSCOPE_OWNER_QUEUE_MAX', 4, maxQueued)
  const maxWaitMs = positive(environment, 'VIDEO_MEDIA_DASHSCOPE_MAX_WAIT_MS', 30_000, MAX_WAIT_MS)
  const accountLimits = capacity(environment, 'VIDEO_MEDIA_DASHSCOPE_ACCOUNT', {
    max_active: 4,
    max_active_per_owner: 1,
    requests_per_minute: 120,
  }, maxQueued, maxQueuedPerOwner, maxWaitMs)
  const account_ref = accountBindingComponent(environment, 'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF', 'local-dashscope-account')
  const binding_revision = accountBindingComponent(environment, 'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION', 'local-v1')
  const account: VideoMediaAccountCapacity = {
    ...accountLimits,
    account_ref,
    binding_revision,
    account_key: videoMediaDashscopeAccountKey(account_ref, binding_revision),
  }
  const lanes = {
    visual: capacity(environment, 'VIDEO_MEDIA_DASHSCOPE_VISUAL', { max_active: 2, max_active_per_owner: 1, requests_per_minute: 60 }, maxQueued, maxQueuedPerOwner, maxWaitMs),
    reasoning: capacity(environment, 'VIDEO_MEDIA_DASHSCOPE_REASONING', { max_active: 2, max_active_per_owner: 1, requests_per_minute: 60 }, maxQueued, maxQueuedPerOwner, maxWaitMs),
    asr: capacity(environment, 'VIDEO_MEDIA_DASHSCOPE_ASR', { max_active: 2, max_active_per_owner: 1, requests_per_minute: 30 }, maxQueued, maxQueuedPerOwner, maxWaitMs),
    embedding: capacity(environment, 'VIDEO_MEDIA_DASHSCOPE_EMBEDDING', { max_active: 4, max_active_per_owner: 1, requests_per_minute: 240 }, maxQueued, maxQueuedPerOwner, maxWaitMs),
  }
  const policy: VideoMediaCapacityPolicy = {
    revision: revision(environment),
    account,
    lanes,
  }
  for (const [lane, value] of Object.entries(policy.lanes) as Array<[VideoMediaCapacityLane, VideoMediaAdmissionCapacity & VideoMediaRateCapacity]>) {
    if (value.max_active > policy.account.max_active) throw new Error(`${lane} lane max active must not exceed VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE`)
    if (value.max_active_per_owner > value.max_active) throw new Error(`${lane} lane owner max active must not exceed lane max active`)
  }
  if (policy.account.max_active_per_owner > policy.account.max_active) {
    throw new Error('VIDEO_MEDIA_DASHSCOPE_ACCOUNT_OWNER_MAX_ACTIVE must not exceed VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE')
  }
  return freeze(policy)
}

export function videoMediaObjectVerificationPolicyFromEnvironment(environment: VideoMediaCapacityEnvironment = process.env): VideoMediaObjectVerificationPolicy {
  const policy: VideoMediaObjectVerificationPolicy = {
    max_active: positive(environment, 'VIDEO_MEDIA_OBJECT_VERIFY_MAX_ACTIVE', 2, MAX_ACTIVE),
    max_active_per_owner: positive(environment, 'VIDEO_MEDIA_OBJECT_VERIFY_OWNER_MAX_ACTIVE', 1, MAX_ACTIVE),
    max_queued: positive(environment, 'VIDEO_MEDIA_OBJECT_VERIFY_QUEUE_MAX', 16, MAX_QUEUED),
    max_queued_per_owner: positive(environment, 'VIDEO_MEDIA_OBJECT_VERIFY_OWNER_QUEUE_MAX', 2, MAX_QUEUED),
    max_wait_ms: positive(environment, 'VIDEO_MEDIA_OBJECT_VERIFY_MAX_WAIT_MS', 30_000, MAX_WAIT_MS),
    timeout_ms: positive(environment, 'VIDEO_MEDIA_OBJECT_VERIFY_TIMEOUT_MS', 120_000, MAX_WAIT_MS),
  }
  if (policy.max_active_per_owner > policy.max_active) {
    throw new Error('VIDEO_MEDIA_OBJECT_VERIFY_OWNER_MAX_ACTIVE must not exceed VIDEO_MEDIA_OBJECT_VERIFY_MAX_ACTIVE')
  }
  if (policy.max_queued_per_owner > policy.max_queued) {
    throw new Error('VIDEO_MEDIA_OBJECT_VERIFY_OWNER_QUEUE_MAX must not exceed VIDEO_MEDIA_OBJECT_VERIFY_QUEUE_MAX')
  }
  return Object.freeze(policy)
}

export function videoMediaIdentityAdmissionPolicyFromEnvironment(environment: VideoMediaCapacityEnvironment = process.env): VideoMediaIdentityAdmissionPolicy {
  return Object.freeze({
    max_active: positive(environment, 'VIDEO_MEDIA_IDENTITY_MAX_ACTIVE', 8, MAX_ACTIVE),
    max_queued: positive(environment, 'VIDEO_MEDIA_IDENTITY_QUEUE_MAX', 32, MAX_QUEUED),
    max_wait_ms: positive(environment, 'VIDEO_MEDIA_IDENTITY_MAX_WAIT_MS', 10_000, MAX_WAIT_MS),
  })
}

function capacity(
  environment: VideoMediaCapacityEnvironment,
  prefix: string,
  defaults: Pick<VideoMediaAdmissionCapacity & VideoMediaRateCapacity, 'max_active' | 'max_active_per_owner' | 'requests_per_minute'>,
  maxQueued: number,
  maxQueuedPerOwner: number,
  maxWaitMs: number,
): VideoMediaAdmissionCapacity & VideoMediaRateCapacity {
  return {
    max_active: positive(environment, `${prefix}_MAX_ACTIVE`, defaults.max_active, MAX_ACTIVE),
    max_active_per_owner: positive(environment, `${prefix}_OWNER_MAX_ACTIVE`, defaults.max_active_per_owner, MAX_ACTIVE),
    requests_per_minute: positive(environment, `${prefix}_RPM`, defaults.requests_per_minute, MAX_RPM),
    max_queued: maxQueued,
    max_queued_per_owner: maxQueuedPerOwner,
    max_wait_ms: maxWaitMs,
  }
}

function positive(environment: VideoMediaCapacityEnvironment, name: string, fallback: number, max: number): number {
  const raw = environment[name]
  if (raw === undefined || raw.trim() === '') return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be an integer from 1 to ${max}`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`${name} must be an integer from 1 to ${max}`)
  return parsed
}

function accountBindingComponent(environment: VideoMediaCapacityEnvironment, name: string, fallback: string): string {
  const value = environment[name]?.trim() || fallback
  if (!ACCOUNT_BINDING_COMPONENT.test(value)) {
    throw new Error(`${name} must be 1-128 ASCII letters, digits, dots, underscores, or hyphens`)
  }
  return value
}

function revision(environment: VideoMediaCapacityEnvironment): string {
  const value = environment.VIDEO_MEDIA_CAPACITY_POLICY_REVISION
  if (value === undefined || value.trim() === '') return 'video-media-dashscope-small-v1'
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('VIDEO_MEDIA_CAPACITY_POLICY_REVISION must be 1-128 ASCII letters, digits, dots, underscores, or hyphens')
  return value
}

function freeze(policy: VideoMediaCapacityPolicy): VideoMediaCapacityPolicy {
  Object.freeze(policy.account)
  for (const lane of Object.values(policy.lanes)) Object.freeze(lane)
  Object.freeze(policy.lanes)
  return Object.freeze(policy)
}
