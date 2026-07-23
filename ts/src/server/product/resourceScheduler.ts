import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { lock } from '../../utils/lockfile.js'
import {
  PRODUCT_RESOURCE_KEYS,
  stableProductResourceKeys,
  type ProductResourceByteBudget,
  type ProductResourceClaim,
  type ProductResourceLease,
  type ProductResourceProfile,
  type ProductResourceProfileLimit,
  type ProductResourceReasonCode,
  type ProductResourceReceipt,
  type ProductResourceSnapshot,
} from '../../../shared/product/resourceScheduler.js'
import { DesktopResourceProfiles } from './resourceProfiles.js'

type JobState = 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'outcome_unknown'
type StoredJob = { claim: ProductResourceClaim; resource_keys: ReturnType<typeof stableProductResourceKeys>; sequence: number; enqueued_at: string; state: JobState; lease?: ProductResourceLease }
type DurableState = { version: 1; sequence: number; fencing: number; status: 'ready' | 'draining' | 'maintenance'; last_owner: string | null; jobs: Record<string, StoredJob> }

const resourceKeys = new Set<string>(PRODUCT_RESOURCE_KEYS)
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype'])
const emptyBytes = (): ProductResourceByteBudget => ({ memory: 0, input: 0, temp: 0, output: 0 })
const sumBytes = (into: ProductResourceByteBudget, value: ProductResourceByteBudget) => { for (const key of Object.keys(into) as Array<keyof ProductResourceByteBudget>) into[key] += value[key] }
const priority = (value: ProductResourceClaim['priority']) => ({ interactive: 0, recovery: 1, scheduled: 2, batch: 3, prefetch: 3 })[value]
// Unknown paid/side-effect outcomes keep their exact reservation until a
// fenced reconciler observes the terminal result.  They are never reusable
// merely because the original executor disappeared.
const isActive = (job: StoredJob) => job.state === 'running' || job.state === 'cancelling' || job.state === 'outcome_unknown'
const isQueued = (job: StoredJob) => job.state === 'queued'

function invalidState(): never { throw new Error('SCHEDULER_STATE_INVALID') }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalidState(); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void { if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !(key in value))) invalidState() }
function safeKey(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !dangerousKeys.has(value) }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)) }
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && value >= 0 && value <= maximum }
function bytes(value: unknown): asserts value is ProductResourceByteBudget { const record = object(value); exact(record, ['memory', 'input', 'temp', 'output']); if (!Object.values(record).every(item => count(item, 32 * 1024 * 1024 * 1024))) invalidState() }

function validateClaim(claim: unknown, jobId: string): asserts claim is ProductResourceClaim {
  const record = object(claim); exact(record, ['job_id', 'owner_id', 'idempotency_key', 'scope', 'resources', 'bytes', 'priority', 'cancel_mode', 'resume_policy', 'profile_revision'], ['deadline_at', 'task_run'])
  if (record.job_id !== jobId || !nonEmpty(record.owner_id) || !nonEmpty(record.idempotency_key) || !nonEmpty(record.profile_revision) || record.scope !== 'desktop-host' || !['interactive', 'recovery', 'scheduled', 'batch', 'prefetch'].includes(record.priority as string) || !['cooperative', 'outcome_unknown'].includes(record.cancel_mode as string) || !['idempotent', 'manual', 'never'].includes(record.resume_policy as string) || (record.deadline_at !== undefined && !timestamp(record.deadline_at)) || !Array.isArray(record.resources) || record.resources.length === 0) invalidState()
  bytes(record.bytes)
  const seen = new Set<string>()
  for (const value of record.resources) { const resource = object(value); exact(resource, ['key', 'units']); if (!resourceKeys.has(resource.key as string) || !count(resource.units, 8) || resource.units === 0 || seen.has(resource.key as string)) invalidState(); seen.add(resource.key as string) }
  if (record.task_run !== undefined) { const task = object(record.task_run); exact(task, ['run_id', 'dispatch_generation']); if (!safeKey(task.run_id) || !count(task.dispatch_generation) || task.dispatch_generation === 0) invalidState() }
}

function validateLease(lease: unknown): asserts lease is ProductResourceLease {
  const record = object(lease); exact(record, ['owner_id', 'process_id', 'process_generation', 'fencing_token', 'expires_at'])
  if (!nonEmpty(record.owner_id) || !nonEmpty(record.process_id) || !nonEmpty(record.process_generation) || !count(record.fencing_token) || record.fencing_token === 0 || !timestamp(record.expires_at)) invalidState()
}

function validateState(value: unknown): DurableState {
  const state = object(value); exact(state, ['version', 'sequence', 'fencing', 'status', 'last_owner', 'jobs'])
  if (state.version !== 1 || !count(state.sequence) || !count(state.fencing) || !['ready', 'draining', 'maintenance'].includes(state.status as string) || (state.last_owner !== null && !nonEmpty(state.last_owner))) invalidState()
  const jobs = object(state.jobs)
  for (const [jobId, value] of Object.entries(jobs)) {
    if (!safeKey(jobId)) invalidState()
    const job = object(value); exact(job, ['claim', 'resource_keys', 'sequence', 'enqueued_at', 'state'], ['lease'])
    validateClaim(job.claim, jobId)
    if (!Array.isArray(job.resource_keys) || !count(job.sequence) || job.sequence === 0 || job.sequence > state.sequence || !timestamp(job.enqueued_at) || !['queued', 'running', 'cancelling', 'cancelled', 'completed', 'outcome_unknown'].includes(job.state as string)) invalidState()
    const expected = stableProductResourceKeys((job.claim as ProductResourceClaim).resources)
    if (job.resource_keys.length !== expected.length || job.resource_keys.some((key, index) => key !== expected[index])) invalidState()
    if (job.lease !== undefined) validateLease(job.lease)
    if ((job.state === 'running' || job.state === 'cancelling' || job.state === 'outcome_unknown') !== (job.lease !== undefined)) invalidState()
  }
  return state as DurableState
}

export type ProductResourceSchedulerOptions = {
  statePath: string
  profiles?: DesktopResourceProfiles
  now?: () => Date
  processId?: string
  processGeneration?: string
  leaseMs?: number
  /** Content claims are fail-closed unless Module 03's runtime profile validates. */
  contentSafetyProfile?: { valid(): Promise<boolean> }
}

/**
 * The sole desktop-host scheduler truth.  Each mutation takes an OS lock and
 * atomically replaces the compact metadata-only journal, so a restarted or
 * second server observes the same queue and fencing sequence.
 */
export class ProductResourceScheduler {
  private readonly profiles: DesktopResourceProfiles
  private readonly now: () => Date
  private readonly processId: string
  private readonly processGeneration: string
  private readonly leaseMs: number

  constructor(private readonly options: ProductResourceSchedulerOptions) {
    this.profiles = options.profiles ?? new DesktopResourceProfiles()
    this.now = options.now ?? (() => new Date())
    this.processId = options.processId ?? process.pid.toString()
    this.processGeneration = options.processGeneration ?? randomUUID()
    this.leaseMs = options.leaseMs ?? 30_000
  }

  async submit(claim: ProductResourceClaim): Promise<ProductResourceReceipt> {
    if (claim.resources.some(resource => ['content.inspect', 'content.extract', 'content.thumbnail', 'storage.attachment-temp'].includes(resource.key)) && !(await this.options.contentSafetyProfile?.valid())) {
      return { job_id: claim.job_id, outcome: 'rejected', profile_revision: this.profiles.current().profile.revision, resource_keys: stableProductResourceKeys(claim.resources), reason_code: 'CONTENT_PROFILE_REQUIRED' }
    }
    return this.mutate(state => {
      this.reapExpired(state)
      const profile = this.profiles.current()
      const keys = stableProductResourceKeys(claim.resources)
      const duplicate = Object.values(state.jobs).find(job => job.claim.idempotency_key === claim.idempotency_key)
      if (duplicate) return this.receipt(duplicate, 'duplicate')
      const invalid = this.validateClaim(claim, keys, profile.profile)
      if (invalid) return { job_id: claim.job_id, outcome: 'rejected', profile_revision: profile.profile.revision, resource_keys: keys, reason_code: invalid }
      if (state.status !== 'ready') return { job_id: claim.job_id, outcome: 'rejected', profile_revision: profile.profile.revision, resource_keys: keys, reason_code: state.status === 'draining' ? 'DRAINING' : 'MAINTENANCE' }
      const queuedReason = this.queueReason(state, claim, keys, profile.profile)
      if (queuedReason) return { job_id: claim.job_id, outcome: 'rejected', profile_revision: profile.profile.revision, resource_keys: keys, reason_code: queuedReason }
      if (state.jobs[claim.job_id]) return { job_id: claim.job_id, outcome: 'rejected', profile_revision: profile.profile.revision, resource_keys: keys, reason_code: 'NOT_FOUND' }
      state.jobs[claim.job_id] = { claim: { ...claim, resources: [...claim.resources].sort((a, b) => a.key.localeCompare(b.key)) }, resource_keys: keys, sequence: ++state.sequence, enqueued_at: this.now().toISOString(), state: 'queued' }
      this.dispatch(state, profile.profile)
      return this.receipt(state.jobs[claim.job_id], state.jobs[claim.job_id].state === 'running' ? 'admitted' : 'queued')
    })
  }

  /** Server-private claim builder input; consumers never select a profile revision. */
  profileRevision(): string { return this.profiles.current().profile.revision }

  async heartbeat(jobId: string, fencingToken: number): Promise<ProductResourceReceipt> {
    return this.mutate(state => {
      this.reapExpired(state)
      const job = state.jobs[jobId]
      if (!job) return this.missing(jobId)
      if (!isActive(job) || job.lease?.fencing_token !== fencingToken) return this.stale(job)
      job.lease.expires_at = new Date(this.now().getTime() + this.leaseMs).toISOString()
      return this.receipt(job, 'admitted')
    })
  }

  async complete(jobId: string, fencingToken: number): Promise<ProductResourceReceipt> {
    return this.mutate(state => {
      this.reapExpired(state)
      const job = state.jobs[jobId]
      if (!job) return this.missing(jobId)
      if (!isActive(job) || job.lease?.fencing_token !== fencingToken) return this.stale(job)
      job.state = 'completed'; delete job.lease
      this.dispatch(state, this.profiles.current().profile)
      return this.receipt(job, 'admitted')
    })
  }

  async cancel(jobId: string): Promise<ProductResourceReceipt> {
    return this.mutate(state => {
      const job = state.jobs[jobId]
      if (!job) return this.missing(jobId)
      if (isQueued(job)) { job.state = 'cancelled'; return this.receipt(job, 'rejected', 'CANCELLED') }
      if (isActive(job)) { job.state = job.claim.cancel_mode === 'outcome_unknown' ? 'outcome_unknown' : 'cancelling'; return this.receipt(job, 'admitted') }
      return this.receipt(job, 'rejected', 'CANCELLED')
    })
  }

  async beginDrain(): Promise<ProductResourceSnapshot> {
    return this.mutate(state => { state.status = 'draining'; for (const job of Object.values(state.jobs)) if (isQueued(job)) job.state = 'cancelled'; return this.snapshotOf(state) })
  }

  async resume(): Promise<ProductResourceSnapshot> {
    return this.mutate(state => { state.status = 'ready'; this.reapExpired(state); this.dispatch(state, this.profiles.current().profile); return this.snapshotOf(state) })
  }

  async snapshot(): Promise<ProductResourceSnapshot> { return this.mutate(state => { this.reapExpired(state); return this.snapshotOf(state) }) }

  private validateClaim(claim: ProductResourceClaim, keys: string[], profile: ProductResourceProfile): ProductResourceReasonCode | undefined {
    if (!claim.job_id || !claim.owner_id || !claim.idempotency_key || !claim.profile_revision || claim.scope !== 'desktop-host' || !keys.length || keys.length !== claim.resources.length || claim.resources.some(resource => !Number.isSafeInteger(resource.units) || resource.units < 1) || Object.values(claim.bytes).some(value => !Number.isSafeInteger(value) || value < 0)) return 'PROFILE_REQUIRED'
    if (claim.profile_revision !== profile.revision) return 'PROFILE_REQUIRED'
    return keys.some(key => !profile.limits[key]) ? 'PROFILE_REQUIRED' : undefined
  }

  private queueReason(state: DurableState, claim: ProductResourceClaim, keys: string[], profile: ProductResourceProfile): ProductResourceReasonCode | undefined {
    for (const key of keys) {
      const limit = profile.limits[key]!
      const queued = Object.values(state.jobs).filter(job => isQueued(job) && job.resource_keys.includes(key))
      if (queued.length >= limit.max_queued) return 'QUEUE_LIMIT'
      if (queued.filter(job => job.claim.owner_id === claim.owner_id).length >= limit.max_queued_per_owner) return 'OWNER_QUOTA'
    }
  }

  private dispatch(state: DurableState, profile: ProductResourceProfile): void {
    if (state.status !== 'ready') return
    const candidates = Object.values(state.jobs).filter(isQueued).sort((left, right) => this.compareQueued(left, right, state.last_owner))
    for (const job of candidates) {
      if (this.admissionReason(state, job, profile)) continue
      job.state = 'running'
      job.lease = { owner_id: job.claim.owner_id, process_id: this.processId, process_generation: this.processGeneration, fencing_token: ++state.fencing, expires_at: new Date(this.now().getTime() + this.leaseMs).toISOString() }
      state.last_owner = job.claim.owner_id
    }
  }

  private compareQueued(left: StoredJob, right: StoredJob, lastOwner: string | null): number {
    const age = (job: StoredJob) => Math.min(2, Math.floor((this.now().getTime() - Date.parse(job.enqueued_at)) / 60_000))
    const rank = (job: StoredJob) => Math.max(0, priority(job.claim.priority) - age(job))
    const byPriority = rank(left) - rank(right)
    if (byPriority) return byPriority
    // Rotate trusted owners in a deterministic ring, while retaining FIFO per owner.
    const owner = (job: StoredJob) => job.claim.owner_id === lastOwner ? 1 : 0
    const byOwner = owner(left) - owner(right)
    return byOwner || left.claim.owner_id.localeCompare(right.claim.owner_id) || left.sequence - right.sequence
  }

  private admissionReason(state: DurableState, candidate: StoredJob, profile: ProductResourceProfile): ProductResourceReasonCode | undefined {
    const active = Object.values(state.jobs).filter(isActive)
    for (const key of candidate.resource_keys) {
      const limit = profile.limits[key]!
      const users = active.filter(job => job.resource_keys.includes(key))
      const requested = candidate.claim.resources.find(resource => resource.key === key)!.units
      const units = users.reduce((total, job) => total + (job.claim.resources.find(resource => resource.key === key)?.units ?? 0), 0)
      if (units + requested > limit.max_active) return 'CONCURRENCY_LIMIT'
      const ownerUnits = users.filter(job => job.claim.owner_id === candidate.claim.owner_id).reduce((total, job) => total + (job.claim.resources.find(resource => resource.key === key)?.units ?? 0), 0)
      if (ownerUnits + requested > limit.max_active_per_owner) return 'OWNER_QUOTA'
      const used = emptyBytes(); users.forEach(job => sumBytes(used, job.claim.bytes))
      if ((Object.keys(used) as Array<keyof ProductResourceByteBudget>).some(name => used[name] + candidate.claim.bytes[name] > limit.bytes[name])) return 'BYTES_LIMIT'
    }
  }

  private receipt(job: StoredJob, outcome: ProductResourceReceipt['outcome'], reason_code?: ProductResourceReasonCode): ProductResourceReceipt {
    const profile_revision = this.profiles.current().profile.revision
    return { job_id: job.claim.job_id, outcome, profile_revision, resource_keys: job.resource_keys, ...(job.lease ? { fencing_token: job.lease.fencing_token, lease: { ...job.lease } } : {}), ...(reason_code ? { reason_code } : {}) }
  }
  private missing(job_id: string): ProductResourceReceipt { return { job_id, outcome: 'rejected', profile_revision: this.profiles.current().profile.revision, resource_keys: [], reason_code: 'NOT_FOUND' } }
  private stale(job: StoredJob): ProductResourceReceipt { return { job_id: job.claim.job_id, outcome: 'rejected', profile_revision: this.profiles.current().profile.revision, resource_keys: job.resource_keys, reason_code: 'STALE_FENCING' } }

  private reapExpired(state: DurableState): void {
    const now = this.now().getTime()
    for (const job of Object.values(state.jobs)) {
      // The lease expiry is not a reconciliation result for paid or external
      // side effects.  Keep the bounded reservation until complete() carries
      // the current fencing token after the owner has reconciled it.
      if (job.state === 'outcome_unknown') continue
      if (isActive(job) && (!job.lease || Date.parse(job.lease.expires_at) <= now)) { job.state = job.claim.cancel_mode === 'outcome_unknown' ? 'outcome_unknown' : 'cancelled'; if (job.state !== 'outcome_unknown') delete job.lease }
    }
  }

  private snapshotOf(state: DurableState): ProductResourceSnapshot {
    const jobs = Object.values(state.jobs); const queued = jobs.filter(isQueued); const bytes = emptyBytes(); jobs.filter(isActive).forEach(job => sumBytes(bytes, job.claim.bytes))
    const wait = queued.length ? Math.max(0, this.now().getTime() - Math.min(...queued.map(job => Date.parse(job.enqueued_at)))) : 0
    const profile = this.profiles.current()
    const status = state.status === 'draining' ? 'draining' : state.status === 'maintenance' ? 'maintenance' : profile.status === 'degraded' ? 'degraded' : queued.length ? 'overloaded' : 'ready'
    return { status, profile_revision: profile.profile.revision, active: jobs.filter(isActive).length, queued: queued.length, bytes, oldest_wait_ms: wait, owner_rejects: 0, lease_owner: jobs.find(isActive)?.lease?.owner_id ?? null, ...(profile.status === 'degraded' ? { reason_code: 'PROFILE_DEGRADED' as const } : {}) }
  }

  private async mutate<T>(operation: (state: DurableState) => T, write = true): Promise<T> {
    const guard = `${this.options.statePath}.guard`; await fs.mkdir(path.dirname(guard), { recursive: true }); await fs.open(guard, 'a').then(handle => handle.close())
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try { const state = await this.read(); const result = operation(state); if (write) await this.write(state); return result } finally { await release() }
  }
  private async read(): Promise<DurableState> { try { return validateState(JSON.parse(await fs.readFile(this.options.statePath, 'utf8')) as unknown) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sequence: 0, fencing: 0, status: 'ready', last_owner: null, jobs: Object.create(null) }; throw error } }
  private async write(state: DurableState): Promise<void> { const temporary = `${this.options.statePath}.${process.pid}.${randomUUID()}.tmp`; await fs.mkdir(path.dirname(this.options.statePath), { recursive: true }); await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); await fs.rename(temporary, this.options.statePath) }
}
