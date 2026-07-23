/**
 * The public, process-neutral scheduler contract.  Consumers describe work;
 * only the desktop-host implementation decides admission and fencing.
 */
export const PRODUCT_RESOURCE_KEYS = [
  'agent.worker', 'agent.turn', 'schedule.dispatch',
  'filesystem.write.workspace', 'filesystem.write.external',
  'browser.session', 'browser.batch',
  'media.ffprobe', 'media.ffmpeg.encode', 'media.local-io',
  'content.inspect', 'content.extract', 'content.thumbnail', 'storage.attachment-temp',
  'gateway.ingress-bytes', 'gateway.mimo.vision', 'gateway.funasr', 'gateway.usage-budget',
  'relay.image.openai', 'relay.image.seedream', 'relay.input-bytes', 'relay.blob-disk',
  'storage.migration', 'app.update',
] as const

export type ProductResourceKey = (typeof PRODUCT_RESOURCE_KEYS)[number]
export type ProductResourceScope = 'desktop-host' | 'gateway-account' | 'relay-account'
export type ProductResourcePriority = 'interactive' | 'recovery' | 'scheduled' | 'batch' | 'prefetch'
export type ProductResourceByteBudget = { memory: number; input: number; temp: number; output: number }
export type ProductResourceReasonCode =
  | 'CONCURRENCY_LIMIT' | 'QUEUE_LIMIT' | 'BYTES_LIMIT' | 'OWNER_QUOTA'
  | 'PROFILE_REQUIRED' | 'PROFILE_DEGRADED' | 'MAINTENANCE' | 'DRAINING'
  | 'UPSTREAM_UNAVAILABLE' | 'STALE_FENCING' | 'NOT_FOUND' | 'CANCELLED'

export type ProductResourceClaim = {
  job_id: string
  owner_id: string
  idempotency_key: string
  scope: ProductResourceScope
  resources: ReadonlyArray<{ key: ProductResourceKey; units: number }>
  bytes: ProductResourceByteBudget
  priority: ProductResourcePriority
  deadline_at?: string
  cancel_mode: 'cooperative' | 'outcome_unknown'
  resume_policy: 'idempotent' | 'manual' | 'never'
  profile_revision: string
  /** Existing durable task identity, if this claim dispatches a ProductTask run. */
  task_run?: { run_id: string; dispatch_generation: number }
}

export type ProductResourceLease = {
  owner_id: string
  process_id: string
  process_generation: string
  fencing_token: number
  expires_at: string
}

export type ProductResourceReceipt = {
  job_id: string
  outcome: 'admitted' | 'queued' | 'rejected' | 'duplicate'
  profile_revision: string
  resource_keys: ProductResourceKey[]
  fencing_token?: number
  lease?: ProductResourceLease
  reason_code?: ProductResourceReasonCode
}

export type ProductResourceProfileLimit = {
  max_active: number
  max_queued: number
  max_active_per_owner: number
  max_queued_per_owner: number
  bytes: ProductResourceByteBudget
}

/** Deliberately coarse benchmark evidence; no serial number, hostname, or path. */
export type ProductResourceHardwareIdentity = {
  machine_class: string
  logical_cpu_count: number
  memory_bytes: number
}

export type ProductResourceBenchmarkEvidence = {
  hardware: ProductResourceHardwareIdentity
  platform: string
  toolchain: string
  profile_revision: string
  expires_at: string
}

export type ProductResourceProfile = {
  scope: ProductResourceScope
  revision: string
  expires_at: string
  platform: string
  toolchain: string
  hardware: ProductResourceHardwareIdentity
  limits: Partial<Record<ProductResourceKey, ProductResourceProfileLimit>>
}

export type ProductResourceSnapshot = {
  status: 'ready' | 'degraded' | 'overloaded' | 'draining' | 'maintenance'
  profile_revision: string
  active: number
  queued: number
  bytes: ProductResourceByteBudget
  oldest_wait_ms: number
  owner_rejects: number
  lease_owner: string | null
  reason_code?: ProductResourceReasonCode
}

export function stableProductResourceKeys(resources: ProductResourceClaim['resources']): ProductResourceKey[] {
  return [...new Set(resources.map(resource => resource.key))].sort() as ProductResourceKey[]
}
