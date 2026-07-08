export type BridgeWorkerRefreshCause = 'proactive_refresh' | 'auth_401_recovery' | 'manual_refresh'

export interface BridgeWorkerRefreshOutcome<T> {
  value: T
  expiresInSeconds: number
}

export type BridgeWorkerRefreshResult<T> =
  | { ok: true; cause: BridgeWorkerRefreshCause; value: T }
  | { ok: false; cause: BridgeWorkerRefreshCause; skipped: true; reason: 'cancelled' | 'in_flight' | 'stale' }
  | { ok: false; cause: BridgeWorkerRefreshCause; skipped: false; error: string }

export interface BridgeWorkerRefreshStatus {
  enabled: boolean
  sessionId: string
  inFlight: boolean
  nextRefreshAt: string | null
  nextRefreshInMs: number | null
  consecutiveFailures: number
  lastRefreshAt: string | null
  lastError: string | null
  lastCause: BridgeWorkerRefreshCause | null
}

export interface BridgeWorkerRefreshSchedulerOptions<T> {
  sessionId: string
  onRefresh: (cause: BridgeWorkerRefreshCause) => Promise<BridgeWorkerRefreshOutcome<T>>
  refreshBufferMs?: number
  minDelayMs?: number
  retryDelayMs?: number
  maxConsecutiveFailures?: number
  now?: () => number
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown
  clearTimeoutFn?: (timer: unknown) => void
}

const DEFAULT_REFRESH_BUFFER_MS = 5 * 60 * 1000
const DEFAULT_MIN_DELAY_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 60_000
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function maybeUnref(timer: unknown): void {
  const candidate = timer as { unref?: () => void } | null | undefined
  if (typeof candidate?.unref === 'function') candidate.unref()
}

export class BridgeWorkerRefreshScheduler<T = unknown> {
  private readonly sessionId: string
  private readonly onRefresh: (cause: BridgeWorkerRefreshCause) => Promise<BridgeWorkerRefreshOutcome<T>>
  private readonly refreshBufferMs: number
  private readonly minDelayMs: number
  private readonly retryDelayMs: number
  private readonly maxConsecutiveFailures: number
  private readonly now: () => number
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimeoutFn: (timer: unknown) => void
  private timer: unknown | null = null
  private generation = 0
  private cancelled = false
  private inFlight = false
  private nextRefreshAtMs: number | null = null
  private consecutiveFailures = 0
  private lastRefreshAtMs: number | null = null
  private lastError: string | null = null
  private lastCause: BridgeWorkerRefreshCause | null = null

  constructor(options: BridgeWorkerRefreshSchedulerOptions<T>) {
    this.sessionId = options.sessionId
    this.onRefresh = options.onRefresh
    this.refreshBufferMs = positiveFinite(options.refreshBufferMs, DEFAULT_REFRESH_BUFFER_MS)
    this.minDelayMs = positiveFinite(options.minDelayMs, DEFAULT_MIN_DELAY_MS)
    this.retryDelayMs = positiveFinite(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS)
    this.maxConsecutiveFailures = Math.max(1, Math.floor(positiveFinite(options.maxConsecutiveFailures, DEFAULT_MAX_CONSECUTIVE_FAILURES)))
    this.now = options.now ?? Date.now
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimeoutFn = options.clearTimeoutFn ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  scheduleFromExpiresIn(expiresInSeconds: number): void {
    if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return
    this.cancelled = false
    this.clearTimer()
    const generation = this.nextGeneration()
    const delayMs = Math.max(expiresInSeconds * 1000 - this.refreshBufferMs, this.minDelayMs)
    this.scheduleTimer(delayMs, generation)
  }

  async refreshNow(cause: BridgeWorkerRefreshCause): Promise<BridgeWorkerRefreshResult<T>> {
    if (this.cancelled) return { ok: false, cause, skipped: true, reason: 'cancelled' }
    if (this.inFlight) return { ok: false, cause, skipped: true, reason: 'in_flight' }
    this.clearTimer()
    return await this.runRefresh(cause, this.nextGeneration())
  }

  cancel(): void {
    this.cancelled = true
    this.nextGeneration()
    this.clearTimer()
  }

  getStatus(now = this.now()): BridgeWorkerRefreshStatus {
    return {
      enabled: !this.cancelled,
      sessionId: this.sessionId,
      inFlight: this.inFlight,
      nextRefreshAt: this.nextRefreshAtMs === null ? null : new Date(this.nextRefreshAtMs).toISOString(),
      nextRefreshInMs: this.nextRefreshAtMs === null ? null : Math.max(0, this.nextRefreshAtMs - now),
      consecutiveFailures: this.consecutiveFailures,
      lastRefreshAt: this.lastRefreshAtMs === null ? null : new Date(this.lastRefreshAtMs).toISOString(),
      lastError: this.lastError,
      lastCause: this.lastCause,
    }
  }

  private nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer)
      this.timer = null
    }
    this.nextRefreshAtMs = null
  }

  private scheduleTimer(delayMs: number, generation: number): void {
    this.nextRefreshAtMs = this.now() + delayMs
    const timer = this.setTimeoutFn(() => {
      if (this.timer === timer) {
        this.timer = null
        this.nextRefreshAtMs = null
      }
      void this.runRefresh('proactive_refresh', generation)
    }, delayMs)
    maybeUnref(timer)
    this.timer = timer
  }

  private scheduleRetry(generation: number): void {
    if (this.cancelled || this.consecutiveFailures >= this.maxConsecutiveFailures) return
    this.scheduleTimer(this.retryDelayMs, generation)
  }

  private async runRefresh(cause: BridgeWorkerRefreshCause, generation: number): Promise<BridgeWorkerRefreshResult<T>> {
    if (this.cancelled) return { ok: false, cause, skipped: true, reason: 'cancelled' }
    if (this.generation !== generation) return { ok: false, cause, skipped: true, reason: 'stale' }
    if (this.inFlight) return { ok: false, cause, skipped: true, reason: 'in_flight' }
    this.inFlight = true
    this.lastCause = cause
    try {
      const refreshed = await this.onRefresh(cause)
      if (this.cancelled) return { ok: false, cause, skipped: true, reason: 'cancelled' }
      if (this.generation !== generation) return { ok: false, cause, skipped: true, reason: 'stale' }
      this.consecutiveFailures = 0
      this.lastError = null
      this.lastRefreshAtMs = this.now()
      this.scheduleFromExpiresIn(refreshed.expiresInSeconds)
      return { ok: true, cause, value: refreshed.value }
    } catch (error) {
      if (this.cancelled) return { ok: false, cause, skipped: true, reason: 'cancelled' }
      if (this.generation !== generation) return { ok: false, cause, skipped: true, reason: 'stale' }
      this.consecutiveFailures += 1
      this.lastError = errorMessage(error)
      this.scheduleRetry(generation)
      return { ok: false, cause, skipped: false, error: this.lastError }
    } finally {
      this.inFlight = false
    }
  }
}
