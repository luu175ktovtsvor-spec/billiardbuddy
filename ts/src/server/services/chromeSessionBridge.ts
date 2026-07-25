import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { lock } from '../../utils/lockfile.js'
import type {
  BrowserCandidateEvidence,
  BrowserCapabilityStatus,
  BrowserPageSnapshot,
  NativeBrowserActionResult,
  NativeBrowserCommand,
  PublicRecruitingAction,
  RecruitingActionKind,
  RecruitingActionState,
} from '../../../shared/product/browserCapability.js'
import { BROWSER_CAPABILITY_PROTOCOL_VERSION, RECRUITING_ACTION_KINDS } from '../../../shared/product/browserCapability.js'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'

type StoredRecruitingAction = PublicRecruitingAction & {
  client_operation_id: string
  canonical_input_hash: string
  command_id?: string
  delivered_at?: string
  scheduler_job_id?: string
  scheduler_fencing_token?: number
}

type StoredState = {
  version: 1
  actions: Record<string, StoredRecruitingAction>
}

type NativeCandidate = BrowserCandidateEvidence & { display_name: string }
type NativePageSnapshot = Omit<BrowserPageSnapshot, 'candidates'> & { candidates: NativeCandidate[] }
type LiveSession = { page: NativePageSnapshot; last_seen_at: string }

export type NativeBrowserSync = {
  protocol_version: 1
  type: 'sync'
  session_id: string
  page?: unknown
  results?: unknown
}

export type NativeBrowserSyncResponse = {
  ok: true
  command?: NativeBrowserCommand
  acknowledged_operation_ids: string[]
}

export type PrepareRecruitingActionInput = {
  session_id: string
  page_revision: string
  candidate_ref: string
  kind: RecruitingActionKind
  message?: string
  client_operation_id: string
}

export type ChromeSessionBridgeOptions = {
  statePath: string
  descriptorPath: string
  scheduler: ProductResourceScheduler
  now?: () => Date
  sessionTtlMs?: number
  dispatchResultTimeoutMs?: number
}

const EMPTY_STATE = (): StoredState => ({ version: 1, actions: Object.create(null) })
const SAFE_ID = /^[a-zA-Z0-9_-]{8,128}$/
const ACTION_KINDS = new Set<string>(RECRUITING_ACTION_KINDS)
const TERMINAL_STATES = new Set<RecruitingActionState>(['succeeded', 'failed', 'outcome_unknown', 'rejected', 'expired'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => key in value)
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function safeString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function safeOptionalString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

function safeBossUrl(value: unknown): value is string {
  if (!safeString(value, 2048)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (url.hostname === 'zhipin.com' || url.hostname.endsWith('.zhipin.com'))
  } catch {
    return false
  }
}

function parseNativePage(value: unknown, sessionId: string, now: Date): NativePageSnapshot | undefined {
  if (!isRecord(value) || !exactKeys(value, ['page_revision', 'url', 'title', 'candidates'], ['captured_at'])) return undefined
  if (!safeString(value.page_revision, 128) || !safeBossUrl(value.url) || typeof value.title !== 'string' || value.title.length > 240 || !Array.isArray(value.candidates) || value.candidates.length > 100) return undefined
  const candidates: NativeCandidate[] = []
  const seen = new Set<string>()
  for (const raw of value.candidates) {
    if (!isRecord(raw) || !exactKeys(raw, ['candidate_ref', 'display_name', 'skills'], ['headline', 'experience_summary'])) return undefined
    if (!safeString(raw.candidate_ref, 128) || !SAFE_ID.test(raw.candidate_ref) || seen.has(raw.candidate_ref) || typeof raw.display_name !== 'string' || raw.display_name.length > 80 || !safeOptionalString(raw.headline, 240) || !safeOptionalString(raw.experience_summary, 1000) || !Array.isArray(raw.skills) || raw.skills.length > 30 || raw.skills.some(skill => typeof skill !== 'string' || skill.length > 80)) return undefined
    seen.add(raw.candidate_ref)
    candidates.push({
      candidate_ref: raw.candidate_ref,
      display_name: raw.display_name || '候选人',
      ...(raw.headline ? { headline: raw.headline } : {}),
      ...(raw.experience_summary ? { experience_summary: raw.experience_summary } : {}),
      skills: [...raw.skills],
    })
  }
  return {
    session_id: sessionId,
    page_revision: value.page_revision,
    url: value.url,
    title: value.title,
    captured_at: safeString(value.captured_at, 64) && Number.isFinite(Date.parse(value.captured_at)) ? value.captured_at : now.toISOString(),
    candidates,
  }
}

function parseResults(value: unknown): NativeBrowserActionResult[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) return undefined
  const results: NativeBrowserActionResult[] = []
  for (const raw of value) {
    if (!isRecord(raw) || !exactKeys(raw, ['operation_id', 'command_id', 'outcome'], ['failure_code'])) return undefined
    if (!safeString(raw.operation_id, 128) || !SAFE_ID.test(raw.operation_id) || !safeString(raw.command_id, 128) || !SAFE_ID.test(raw.command_id) || !['succeeded', 'failed', 'outcome_unknown'].includes(raw.outcome as string) || !safeOptionalString(raw.failure_code, 80)) return undefined
    results.push(raw as NativeBrowserActionResult)
  }
  return results
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function publicAction(action: StoredRecruitingAction): PublicRecruitingAction {
  return {
    id: action.id,
    task_id: action.task_id,
    revision: action.revision,
    session_id: action.session_id,
    page_revision: action.page_revision,
    kind: action.kind,
    candidate_ref: action.candidate_ref,
    target_label: action.target_label,
    ...(action.message ? { message: action.message } : {}),
    state: action.state,
    created_at: action.created_at,
    updated_at: action.updated_at,
    ...(action.failure_code ? { failure_code: action.failure_code } : {}),
  }
}

export class ChromeSessionBridge {
  private readonly now: () => Date
  private readonly sessionTtlMs: number
  private readonly dispatchResultTimeoutMs: number
  private readonly sessions = new Map<string, LiveSession>()
  private nativeToken?: string
  private descriptorReady = false

  constructor(private readonly options: ChromeSessionBridgeOptions) {
    this.now = options.now ?? (() => new Date())
    this.sessionTtlMs = options.sessionTtlMs ?? 20_000
    this.dispatchResultTimeoutMs = options.dispatchResultTimeoutMs ?? 60_000
  }

  async activate(endpoint: string): Promise<void> {
    const url = new URL(endpoint)
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('BROWSER_BRIDGE_NON_LOOPBACK')
    this.nativeToken = randomBytes(32).toString('base64url')
    try {
      await this.atomicWrite(this.options.descriptorPath, {
        version: 1,
        endpoint: new URL('/api/browser/native/sync', url).toString(),
        token: this.nativeToken,
        issued_at: this.now().toISOString(),
        process_id: process.pid,
      })
      this.descriptorReady = true
    } catch {
      this.descriptorReady = false
    }
  }

  async deactivate(): Promise<void> {
    this.nativeToken = undefined
    this.descriptorReady = false
    this.sessions.clear()
    await fs.unlink(this.options.descriptorPath).catch(() => undefined)
  }

  status(): BrowserCapabilityStatus {
    this.reapSessions()
    const lastSeen = [...this.sessions.values()].map(session => session.last_seen_at).sort().at(-1)
    if (!this.nativeToken) return { state: 'not_configured', connected_sessions: 0, reason: 'BRIDGE_NOT_CONFIGURED' }
    if (!this.descriptorReady) return { state: 'degraded', connected_sessions: 0, reason: 'BRIDGE_DESCRIPTOR_FAILED' }
    if (!this.sessions.size) return { state: 'waiting_for_extension', connected_sessions: 0, reason: 'EXTENSION_NOT_CONNECTED' }
    return { state: 'connected', connected_sessions: this.sessions.size, ...(lastSeen ? { last_seen_at: lastSeen } : {}) }
  }

  listPages(): BrowserPageSnapshot[] {
    this.reapSessions()
    return [...this.sessions.values()].map(({ page }) => ({
      session_id: page.session_id,
      page_revision: page.page_revision,
      url: page.url,
      title: page.title,
      captured_at: page.captured_at,
      candidates: page.candidates.map(candidate => ({
        candidate_ref: candidate.candidate_ref,
        ...(candidate.headline ? { headline: candidate.headline } : {}),
        ...(candidate.experience_summary ? { experience_summary: candidate.experience_summary } : {}),
        skills: [...candidate.skills],
      })),
    }))
  }

  async prepareAction(taskId: string, input: PrepareRecruitingActionInput): Promise<PublicRecruitingAction> {
    this.reapSessions()
    if (!SAFE_ID.test(taskId) || !SAFE_ID.test(input.session_id) || !SAFE_ID.test(input.page_revision) || !SAFE_ID.test(input.candidate_ref) || !SAFE_ID.test(input.client_operation_id) || !ACTION_KINDS.has(input.kind)) throw new Error('BROWSER_ACTION_INVALID')
    if (input.kind === 'send_message' && (!input.message || input.message.length > 2000)) throw new Error('BROWSER_ACTION_INVALID')
    if (input.kind !== 'send_message' && input.message !== undefined) throw new Error('BROWSER_ACTION_INVALID')
    const session = this.sessions.get(input.session_id)
    if (!session || session.page.page_revision !== input.page_revision) throw new Error('BROWSER_PAGE_STALE')
    const candidate = session.page.candidates.find(item => item.candidate_ref === input.candidate_ref)
    if (!candidate) throw new Error('BROWSER_CANDIDATE_NOT_FOUND')
    const canonical = canonicalHash({ taskId, ...input })
    return await this.mutate(state => {
      const duplicate = Object.values(state.actions).find(action => action.task_id === taskId && action.client_operation_id === input.client_operation_id)
      if (duplicate) {
        if (duplicate.canonical_input_hash !== canonical) throw new Error('BROWSER_IDEMPOTENCY_CONFLICT')
        return publicAction(duplicate)
      }
      const at = this.now().toISOString()
      const id = `browser_action_${randomUUID().replaceAll('-', '')}`
      const action: StoredRecruitingAction = {
        id,
        task_id: taskId,
        revision: 0,
        session_id: input.session_id,
        page_revision: input.page_revision,
        kind: input.kind,
        candidate_ref: input.candidate_ref,
        target_label: candidate.display_name,
        ...(input.message ? { message: input.message } : {}),
        state: 'awaiting_confirmation',
        client_operation_id: input.client_operation_id,
        canonical_input_hash: canonical,
        created_at: at,
        updated_at: at,
      }
      state.actions[id] = action
      return publicAction(action)
    })
  }

  async listActions(taskId: string): Promise<PublicRecruitingAction[]> {
    if (!SAFE_ID.test(taskId)) return []
    await this.reconcileTimedOutDispatches()
    return await this.mutate(state => Object.values(state.actions)
      .filter(action => action.task_id === taskId)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .map(publicAction), false)
  }

  async getAction(taskId: string, actionId: string): Promise<PublicRecruitingAction | undefined> {
    if (!SAFE_ID.test(taskId) || !SAFE_ID.test(actionId)) return undefined
    await this.reconcileTimedOutDispatches()
    return await this.mutate(state => {
      const action = state.actions[actionId]
      return action?.task_id === taskId ? publicAction(action) : undefined
    }, false)
  }

  async resolveAction(taskId: string, actionId: string, expectedRevision: number, approved: boolean): Promise<PublicRecruitingAction> {
    if (!SAFE_ID.test(taskId) || !SAFE_ID.test(actionId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('BROWSER_ACTION_INVALID')
    const action = await this.mutate(state => {
      const stored = state.actions[actionId]
      if (!stored || stored.task_id !== taskId) throw new Error('BROWSER_ACTION_NOT_FOUND')
      if (stored.revision !== expectedRevision) throw new Error('BROWSER_ACTION_CONFLICT')
      if (stored.state !== 'awaiting_confirmation') throw new Error('BROWSER_ACTION_ALREADY_RESOLVED')
      stored.revision += 1
      stored.updated_at = this.now().toISOString()
      stored.state = approved ? 'approved_waiting' : 'rejected'
      return publicAction(stored)
    })
    if (!approved) return action
    await this.tryDispatch(actionId)
    return (await this.getAction(taskId, actionId))!
  }

  async handleNativeSync(token: string | null, payload: NativeBrowserSync): Promise<NativeBrowserSyncResponse> {
    if (!this.authorized(token) || !isRecord(payload) || !exactKeys(payload as unknown as Record<string, unknown>, ['protocol_version', 'type', 'session_id'], ['page', 'results']) || payload.protocol_version !== BROWSER_CAPABILITY_PROTOCOL_VERSION || payload.type !== 'sync' || !SAFE_ID.test(payload.session_id)) throw new Error('BROWSER_NATIVE_UNAUTHORIZED')
    await this.reconcileTimedOutDispatches()
    const now = this.now()
    if (payload.page !== undefined) {
      const page = parseNativePage(payload.page, payload.session_id, now)
      if (!page) throw new Error('BROWSER_NATIVE_INVALID')
      this.sessions.set(payload.session_id, { page, last_seen_at: now.toISOString() })
    } else {
      const session = this.sessions.get(payload.session_id)
      if (session) session.last_seen_at = now.toISOString()
    }
    const results = parseResults(payload.results)
    if (!results) throw new Error('BROWSER_NATIVE_INVALID')
    const acknowledged: string[] = []
    for (const result of results) {
      if (await this.recordResult(payload.session_id, result)) acknowledged.push(result.operation_id)
    }
    await this.dispatchWaitingForSession(payload.session_id)
    const command = await this.nextCommand(payload.session_id)
    return { ok: true, ...(command ? { command } : {}), acknowledged_operation_ids: acknowledged }
  }

  private async tryDispatch(actionId: string): Promise<void> {
    const action = await this.mutate(state => state.actions[actionId] ? { ...state.actions[actionId] } : undefined, false)
    if (!action || action.state !== 'approved_waiting') return
    const session = this.sessions.get(action.session_id)
    if (!session || session.page.page_revision !== action.page_revision || !session.page.candidates.some(candidate => candidate.candidate_ref === action.candidate_ref)) {
      await this.transition(actionId, 'failed', 'BROWSER_PAGE_STALE')
      return
    }
    const jobId = `browser:${action.id}`
    const receipt = await this.options.scheduler.submit({
      job_id: jobId,
      owner_id: action.task_id,
      idempotency_key: action.id,
      scope: 'desktop-host',
      resources: [{ key: 'browser.session', units: 1 }],
      bytes: { memory: 8 * 1024 * 1024, input: action.message?.length ?? 0, temp: 0, output: 4096 },
      priority: 'interactive',
      deadline_at: new Date(this.now().getTime() + 60_000).toISOString(),
      cancel_mode: 'outcome_unknown',
      resume_policy: 'manual',
      profile_revision: this.options.scheduler.profileRevision(),
    })
    if ((receipt.outcome !== 'admitted' && receipt.outcome !== 'duplicate') || !receipt.fencing_token) {
      if (receipt.outcome === 'queued' || receipt.reason_code === 'CONCURRENCY_LIMIT') return
      await this.transition(actionId, 'failed', `BROWSER_RESOURCE_${receipt.reason_code ?? 'DENIED'}`)
      return
    }
    await this.mutate(state => {
      const stored = state.actions[actionId]
      if (!stored || stored.state !== 'approved_waiting') return
      stored.state = 'dispatching'
      stored.revision += 1
      stored.updated_at = this.now().toISOString()
      stored.command_id = `browser_command_${randomUUID().replaceAll('-', '')}`
      stored.scheduler_job_id = jobId
      stored.scheduler_fencing_token = receipt.fencing_token
    })
  }

  private async dispatchWaitingForSession(sessionId: string): Promise<void> {
    const waiting = await this.mutate(state => Object.values(state.actions)
      .filter(action => action.session_id === sessionId && action.state === 'approved_waiting')
      .map(action => action.id), false)
    for (const actionId of waiting) await this.tryDispatch(actionId)
  }

  private async nextCommand(sessionId: string): Promise<NativeBrowserCommand | undefined> {
    return await this.mutate(state => {
      const action = Object.values(state.actions).find(candidate => candidate.session_id === sessionId && candidate.state === 'dispatching' && candidate.command_id && !candidate.delivered_at)
      if (!action || !action.command_id) return undefined
      action.delivered_at = this.now().toISOString()
      action.updated_at = action.delivered_at
      return {
        command_id: action.command_id,
        operation_id: action.id,
        session_id: action.session_id,
        page_revision: action.page_revision,
        action: action.kind,
        candidate_ref: action.candidate_ref,
        ...(action.message ? { message: action.message } : {}),
      }
    })
  }

  private async recordResult(sessionId: string, result: NativeBrowserActionResult): Promise<boolean> {
    let scheduler: { jobId: string; fencingToken: number } | undefined
    const accepted = await this.mutate(state => {
      const action = state.actions[result.operation_id]
      if (!action || action.session_id !== sessionId || action.command_id !== result.command_id) return false
      if (TERMINAL_STATES.has(action.state) && action.state !== 'outcome_unknown') return action.state === result.outcome
      if (action.state !== 'dispatching' && action.state !== 'outcome_unknown') return false
      if (action.state === 'outcome_unknown' && result.outcome === 'outcome_unknown') return true
      action.state = result.outcome
      action.revision += 1
      action.updated_at = this.now().toISOString()
      if (result.failure_code) action.failure_code = result.failure_code
      else delete action.failure_code
      if (action.scheduler_job_id && action.scheduler_fencing_token) scheduler = { jobId: action.scheduler_job_id, fencingToken: action.scheduler_fencing_token }
      return true
    })
    if (accepted && scheduler) {
      if (result.outcome === 'outcome_unknown') await this.options.scheduler.cancel(scheduler.jobId)
      else await this.options.scheduler.complete(scheduler.jobId, scheduler.fencingToken)
    }
    return accepted
  }

  private async reconcileTimedOutDispatches(): Promise<void> {
    const cutoff = this.now().getTime() - this.dispatchResultTimeoutMs
    const jobIds = await this.mutate(state => {
      const timedOut: string[] = []
      for (const action of Object.values(state.actions)) {
        if (action.state !== 'dispatching' || !action.delivered_at || Date.parse(action.delivered_at) > cutoff) continue
        action.state = 'outcome_unknown'
        action.revision += 1
        action.updated_at = this.now().toISOString()
        action.failure_code = 'BROWSER_RESULT_TIMEOUT'
        if (action.scheduler_job_id) timedOut.push(action.scheduler_job_id)
      }
      return timedOut
    })
    for (const jobId of jobIds) await this.options.scheduler.cancel(jobId)
  }

  private async transition(actionId: string, state: RecruitingActionState, failureCode?: string): Promise<void> {
    await this.mutate(current => {
      const action = current.actions[actionId]
      if (!action || TERMINAL_STATES.has(action.state)) return
      action.state = state
      action.revision += 1
      action.updated_at = this.now().toISOString()
      if (failureCode) action.failure_code = failureCode
    })
  }

  private authorized(token: string | null): boolean {
    if (!this.nativeToken || !token) return false
    const expected = Buffer.from(this.nativeToken)
    const actual = Buffer.from(token)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  private reapSessions(): void {
    const cutoff = this.now().getTime() - this.sessionTtlMs
    for (const [id, session] of this.sessions) if (Date.parse(session.last_seen_at) < cutoff) this.sessions.delete(id)
  }

  private async mutate<T>(operation: (state: StoredState) => T, write = true): Promise<T> {
    const guard = `${this.options.statePath}.guard`
    await fs.mkdir(path.dirname(guard), { recursive: true })
    await fs.open(guard, 'a').then(handle => handle.close())
    const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
    try {
      const state = await this.readState()
      const result = operation(state)
      if (write) await this.atomicWrite(this.options.statePath, state)
      return result
    } finally {
      await release()
    }
  }

  private async readState(): Promise<StoredState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.options.statePath, 'utf8')) as StoredState
      if (parsed?.version !== 1 || !isRecord(parsed.actions)) throw new Error('BROWSER_STATE_INVALID')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE()
      throw error
    }
  }

  private async atomicWrite(target: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await fs.rename(temporary, target)
  }
}

let configuredBridge: ChromeSessionBridge | undefined

export function configureChromeSessionBridge(options: ChromeSessionBridgeOptions): ChromeSessionBridge {
  configuredBridge = new ChromeSessionBridge(options)
  return configuredBridge
}

export function getChromeSessionBridge(): ChromeSessionBridge {
  if (!configuredBridge) throw new Error('BROWSER_BRIDGE_NOT_CONFIGURED')
  return configuredBridge
}
