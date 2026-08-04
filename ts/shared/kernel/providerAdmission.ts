/**
 * In-memory admission gate for provider-bound work. Callers must pass a stable,
 * non-secret owner reference (for example a principal id), never an API key. The
 * gate keeps that reference only while work is active or waiting and never writes it.
 */

export type ProviderAdmissionErrorCode =
  | 'ADMISSION_ABORTED'
  | 'ADMISSION_QUEUE_FULL'
  | 'ADMISSION_QUEUE_TIMEOUT'
  | 'ADMISSION_CLOSED'

export class ProviderAdmissionError extends Error {
  constructor(
    readonly code: ProviderAdmissionErrorCode,
    readonly status: 429 | 499 | 503,
  ) {
    super(code)
    this.name = 'ProviderAdmissionError'
  }
}

/** Stable HTTP-facing error used by the short-lived Gateway rate/concurrency gates. */
export class CapacityQueueError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'CapacityQueueError'
  }
}

type RateLimitWaiter = {
  deadlineAt: number
  resolve: () => void
  reject: (error: CapacityQueueError) => void
  signal?: AbortSignal
  onAbort?: () => void
  timeout?: ReturnType<typeof setTimeout>
}

/**
 * Process-local request-rate gate for one physical provider account. It is
 * independent from HTTP routes and may be shared by Gateway and Relay runtimes.
 * Durable tasks remain owned by their repository; timing out here never decides a
 * task's terminal state.
 */
export class ProviderRateLimiter {
  private readonly capacity: number
  private tokens: number
  private readonly rate: number
  private ts = performance.now()
  private readonly waiters: RateLimitWaiter[] = []
  private wakeTimer?: ReturnType<typeof setTimeout>

  constructor(rpm: number, private readonly queueMax = Infinity) {
    if (!Number.isInteger(rpm) || rpm < 1) throw new Error('rpm must be a positive integer')
    if (queueMax !== Infinity && (!Number.isInteger(queueMax) || queueMax < 0)) {
      throw new Error('rate-limit queueMax must be a non-negative integer or Infinity')
    }
    this.capacity = rpm
    this.tokens = rpm
    this.rate = rpm / 60_000
  }

  async acquire(maxWaitSeconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CapacityQueueError(499, '请求已取消')
    this.refill()
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return
    }
    const maxWaitMs = Math.max(0, maxWaitSeconds) * 1_000
    if (maxWaitMs <= 0 || this.waiters.length >= this.queueMax) {
      throw new CapacityQueueError(429, '当前使用人数较多，请稍后重试')
    }
    return await new Promise<void>((resolve, reject) => {
      const waiter: RateLimitWaiter = {
        deadlineAt: performance.now() + maxWaitMs,
        resolve,
        reject,
        signal,
      }
      const rejectAndRemove = (error: CapacityQueueError) => {
        if (!this.remove(waiter)) return
        this.cleanup(waiter)
        reject(error)
        this.drain()
      }
      waiter.timeout = setTimeout(
        () => rejectAndRemove(new CapacityQueueError(429, '当前使用人数较多，请稍后重试')),
        maxWaitMs,
      )
      waiter.onAbort = () => rejectAndRemove(new CapacityQueueError(499, '请求已取消'))
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
  }

  snapshot(): { available: number; queued: number; rpm: number; queueMax: number } {
    this.refill()
    return { available: Math.floor(this.tokens), queued: this.waiters.length, rpm: this.capacity, queueMax: this.queueMax }
  }

  close(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
    for (const waiter of this.waiters.splice(0)) {
      this.cleanup(waiter)
      waiter.reject(new CapacityQueueError(503, '模型资源准入已停止'))
    }
  }

  private refill(now = performance.now()): void {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.ts) * this.rate)
    this.ts = now
  }

  private drain(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = undefined
    }
    this.refill()
    const now = performance.now()
    while (this.waiters.length > 0 && this.waiters[0]!.deadlineAt <= now) {
      const expired = this.waiters.shift()!
      this.cleanup(expired)
      expired.reject(new CapacityQueueError(429, '当前使用人数较多，请稍后重试'))
    }
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const waiter = this.waiters.shift()!
      this.cleanup(waiter)
      this.tokens -= 1
      waiter.resolve()
    }
    if (this.waiters.length > 0) {
      const tokenWaitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.rate))
      const deadlineWaitMs = Math.max(1, this.waiters[0]!.deadlineAt - performance.now())
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = undefined
        this.drain()
      }, Math.min(tokenWaitMs, deadlineWaitMs))
      ;(this.wakeTimer as unknown as { unref?: () => void }).unref?.()
    }
  }

  private remove(waiter: RateLimitWaiter): boolean {
    const index = this.waiters.indexOf(waiter)
    if (index < 0) return false
    this.waiters.splice(index, 1)
    return true
  }

  private cleanup(waiter: RateLimitWaiter): void {
    if (waiter.timeout) clearTimeout(waiter.timeout)
    if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort)
  }
}

export type ProviderAdmissionConfig = {
  /** Global execution limit for the provider account or execution pool. */
  maxActive: number
  /** Active work allowed for a single owner. */
  maxActivePerOwner: number
  /** Process-memory bound for all waiting work. */
  maxQueued: number
  /** Bound one owner before it can occupy all waiting seats. Defaults to maxQueued. */
  maxQueuedPerOwner?: number
  /** Each waiter is rejected after this bounded window. Zero means no waiting. */
  maxWaitMs: number
}

export type ProviderAdmissionOptions = {
  signal?: AbortSignal
  /** May shorten, but never lengthen, the configured waiting window. */
  maxWaitMs?: number
}

export interface ProviderAdmissionPermit {
  release(): void
}

export type ProviderAdmissionSnapshot = {
  active: number
  queued: number
  activeOwners: number
  queuedOwners: number
  maxActive: number
  maxActivePerOwner: number
  maxQueued: number
  maxQueuedPerOwner: number
  oldestQueueMs: number
  closed: boolean
}

type Pending = {
  owner: string
  queuedAt: number
  resolve: (permit: ProviderAdmissionPermit) => void
  reject: (error: ProviderAdmissionError) => void
  signal?: AbortSignal
  onAbort?: () => void
  timer?: ReturnType<typeof setTimeout>
}

function error(code: ProviderAdmissionErrorCode): ProviderAdmissionError {
  switch (code) {
    case 'ADMISSION_ABORTED': return new ProviderAdmissionError(code, 499)
    case 'ADMISSION_CLOSED': return new ProviderAdmissionError(code, 503)
    case 'ADMISSION_QUEUE_FULL':
    case 'ADMISSION_QUEUE_TIMEOUT': return new ProviderAdmissionError(code, 429)
  }
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

/**
 * A bounded, round-robin gate. It is deliberately independent from HTTP/Gateway
 * concepts, so durable image and video task runners can share the exact same
 * execution semantics.
 */
export class ProviderAdmissionGate {
  private active = 0
  private closed = false
  private lastGrantedOwner: string | undefined
  private readonly activeByOwner = new Map<string, number>()
  private readonly pendingByOwner = new Map<string, Pending[]>()
  private readonly waitingOwners: string[] = []
  private readonly maxQueuedPerOwner: number

  constructor(private readonly config: ProviderAdmissionConfig) {
    positiveInteger('maxActive', config.maxActive)
    positiveInteger('maxActivePerOwner', config.maxActivePerOwner)
    nonNegativeInteger('maxQueued', config.maxQueued)
    nonNegativeInteger('maxWaitMs', config.maxWaitMs)
    this.maxQueuedPerOwner = config.maxQueuedPerOwner ?? config.maxQueued
    nonNegativeInteger('maxQueuedPerOwner', this.maxQueuedPerOwner)
    if (this.maxQueuedPerOwner > config.maxQueued) {
      throw new Error('maxQueuedPerOwner must not exceed maxQueued')
    }
  }

  acquire(owner: string, opts: ProviderAdmissionOptions = {}): Promise<ProviderAdmissionPermit> {
    if (!owner.trim()) throw new Error('owner must be a non-empty stable reference')
    if (this.closed) return Promise.reject(error('ADMISSION_CLOSED'))
    if (opts.signal?.aborted) return Promise.reject(error('ADMISSION_ABORTED'))

    if (this.waitingOwners.length === 0 && this.canStart(owner)) {
      return Promise.resolve(this.grant(owner))
    }

    const maxWaitMs = opts.maxWaitMs === undefined ? this.config.maxWaitMs : Math.min(opts.maxWaitMs, this.config.maxWaitMs)
    if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0) throw new Error('maxWaitMs must be a non-negative finite number')
    if (maxWaitMs === 0) return Promise.reject(error('ADMISSION_QUEUE_FULL'))

    if (this.queuedCount() >= this.config.maxQueued || this.queuedForOwner(owner) >= this.maxQueuedPerOwner) {
      // Do not leave capacity idle behind a full queue containing only temporarily
      // ineligible owners. A newly runnable owner may use a free execution slot, but
      // never bypasses an already runnable waiter.
      this.drain()
      if (!this.hasRunnablePending() && this.canStart(owner)) return Promise.resolve(this.grant(owner))
      return Promise.reject(error('ADMISSION_QUEUE_FULL'))
    }

    return new Promise<ProviderAdmissionPermit>((resolve, reject) => {
      const pending: Pending = { owner, queuedAt: performance.now(), resolve, reject, signal: opts.signal }
      let queue = this.pendingByOwner.get(owner)
      if (!queue) {
        queue = []
        this.pendingByOwner.set(owner, queue)
        this.waitingOwners.push(owner)
      }
      queue.push(pending)

      const rejectAndRemove = (code: ProviderAdmissionErrorCode) => {
        if (!this.removePending(pending)) return
        this.cleanupPending(pending)
        reject(error(code))
        this.drain()
      }
      pending.timer = setTimeout(() => rejectAndRemove('ADMISSION_QUEUE_TIMEOUT'), maxWaitMs)
      pending.onAbort = () => rejectAndRemove('ADMISSION_ABORTED')
      opts.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.drain()
    })
  }

  /** Reject queued work now. Active permits stay valid and release normally. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.pendingByOwner.values()].flat()
    this.pendingByOwner.clear()
    this.waitingOwners.length = 0
    for (const item of pending) {
      this.cleanupPending(item)
      item.reject(error('ADMISSION_CLOSED'))
    }
  }

  snapshot(): ProviderAdmissionSnapshot {
    let oldestQueuedAt = Infinity
    for (const queue of this.pendingByOwner.values()) {
      for (const pending of queue) oldestQueuedAt = Math.min(oldestQueuedAt, pending.queuedAt)
    }
    return {
      active: this.active,
      queued: this.queuedCount(),
      activeOwners: this.activeByOwner.size,
      queuedOwners: this.pendingByOwner.size,
      maxActive: this.config.maxActive,
      maxActivePerOwner: this.config.maxActivePerOwner,
      maxQueued: this.config.maxQueued,
      maxQueuedPerOwner: this.maxQueuedPerOwner,
      oldestQueueMs: oldestQueuedAt === Infinity ? 0 : Math.max(0, Math.trunc(performance.now() - oldestQueuedAt)),
      closed: this.closed,
    }
  }

  private queuedCount(): number {
    let total = 0
    for (const queue of this.pendingByOwner.values()) total += queue.length
    return total
  }

  private queuedForOwner(owner: string): number {
    return this.pendingByOwner.get(owner)?.length ?? 0
  }

  private canStart(owner: string): boolean {
    return !this.closed && this.active < this.config.maxActive && (this.activeByOwner.get(owner) ?? 0) < this.config.maxActivePerOwner
  }

  private hasRunnablePending(): boolean {
    for (const owner of this.waitingOwners) {
      if (this.pendingByOwner.get(owner)?.[0] && this.canStart(owner)) return true
    }
    return false
  }

  private grant(owner: string): ProviderAdmissionPermit {
    this.active += 1
    this.activeByOwner.set(owner, (this.activeByOwner.get(owner) ?? 0) + 1)
    this.lastGrantedOwner = owner
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active -= 1
        const activeForOwner = (this.activeByOwner.get(owner) ?? 1) - 1
        if (activeForOwner === 0) this.activeByOwner.delete(owner)
        else this.activeByOwner.set(owner, activeForOwner)
        this.drain()
      },
    }
  }

  private drain(): void {
    while (!this.closed && this.active < this.config.maxActive && this.waitingOwners.length > 0) {
      this.rotateAfterLastGrantedOwner()
      const candidates = this.waitingOwners.length
      let granted = false
      for (let index = 0; index < candidates; index += 1) {
        const owner = this.waitingOwners.shift()!
        const queue = this.pendingByOwner.get(owner)
        const pending = queue?.[0]
        if (!pending) {
          this.pendingByOwner.delete(owner)
          continue
        }
        if (!this.canStart(owner)) {
          this.waitingOwners.push(owner)
          continue
        }
        queue!.shift()
        if (queue!.length === 0) this.pendingByOwner.delete(owner)
        else this.waitingOwners.push(owner)
        this.cleanupPending(pending)
        pending.resolve(this.grant(owner))
        granted = true
        break
      }
      if (!granted) return
    }
  }

  private rotateAfterLastGrantedOwner(): void {
    if (!this.lastGrantedOwner) return
    const index = this.waitingOwners.indexOf(this.lastGrantedOwner)
    if (index < 0) return
    this.waitingOwners.push(...this.waitingOwners.splice(0, index + 1))
  }

  private removePending(pending: Pending): boolean {
    const queue = this.pendingByOwner.get(pending.owner)
    if (!queue) return false
    const index = queue.indexOf(pending)
    if (index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) {
      this.pendingByOwner.delete(pending.owner)
      const ownerIndex = this.waitingOwners.indexOf(pending.owner)
      if (ownerIndex >= 0) this.waitingOwners.splice(ownerIndex, 1)
    }
    return true
  }

  private cleanupPending(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort)
  }
}
