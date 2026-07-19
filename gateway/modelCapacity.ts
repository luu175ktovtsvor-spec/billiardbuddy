export class CapacityQueueError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'CapacityQueueError'
  }
}

export interface CapacityPermit {
  release(): void
}

export interface CapacitySnapshot {
  active: number
  queued: number
  maxConcurrent: number
  maxConcurrentPerUser: number
  maxConcurrentPerToken: number
  /** Maximum number of waiters accepted by this provider pool. `Infinity` is only
   * used by direct unit-test construction; gateway production pools set a finite value. */
  queueMax: number
  /** Age of the oldest waiting request, so health checks can distinguish a busy
   * but draining pool from a stuck/slow upstream. */
  oldestQueueMs: number
}

export interface AcquireOptions {
  maxWaitMs: number
  signal?: AbortSignal
  /** Token this identity belongs to. Bounds ALL of one token's clients together (defends
   *  against a single token forging many X-QF-Client-IDs). Defaults to the user id. */
  tokenId?: string
}

type Pending = {
  user: string
  tokenId: string
  queuedAt: number
  resolve: (permit: CapacityPermit) => void
  reject: (error: CapacityQueueError) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * One capacity pool with round-robin admission across users. A user may queue several
 * requests by default, but deployments can cap that user's total active + waiting work
 * with `maxInflightPerUser` so an early multi-window burst cannot occupy every waiting
 * slot before later installations arrive.
 *
 * Three tiers gate every grant:
 *  - `maxConcurrent`        — global pool ceiling (protects the upstream). Never exceeded.
 *  - `maxConcurrentPerToken`— all clients under one token combined. This is the defense
 *    against a single token forging many `X-QF-Client-ID`s to monopolize the pool: even
 *    with unlimited fake client ids, a token can hold at most this many in-flight.
 *  - `maxConcurrentPerUser` — a single fair-scheduling identity (token#client, i.e. one
 *    install). Gives honest multi-install usage its per-install fair share.
 *  - `maxInflightPerUser` — optional active + queued cap for one scheduling identity.
 *    This is deliberately separate from the active-only per-user limit: it protects a
 *    bounded waiting queue from a single installation's sequential follow-up windows.
 */
export class FairCapacityScheduler {
  private active = 0
  private readonly activeByUser = new Map<string, number>()
  private readonly activeByToken = new Map<string, number>()
  private readonly pendingByUser = new Map<string, Pending[]>()
  private readonly waitingUsers: string[] = []
  private readonly maxConcurrentPerToken: number

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxConcurrentPerUser: number,
    maxConcurrentPerToken?: number,
    private readonly queueMax: number = Infinity,
    private readonly maxInflightPerUser: number = Infinity,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1')
    if (!Number.isInteger(maxConcurrentPerUser) || maxConcurrentPerUser < 1) {
      throw new Error('maxConcurrentPerUser must be >= 1')
    }
    // Default: the pool ceiling (no extra restriction beyond the global cap). Deployments
    // that issue per-user tokens can set this below the global cap to reserve headroom
    // across tokens; for the shared beta token it defaults to the global cap.
    const perToken = maxConcurrentPerToken ?? maxConcurrent
    if (!Number.isInteger(perToken) || perToken < 1) throw new Error('maxConcurrentPerToken must be >= 1')
    this.maxConcurrentPerToken = perToken
    if (queueMax !== Infinity && (!Number.isInteger(queueMax) || queueMax < 0)) {
      throw new Error('queueMax must be a non-negative integer or Infinity')
    }
    if (maxInflightPerUser !== Infinity && (!Number.isInteger(maxInflightPerUser) || maxInflightPerUser < 1)) {
      throw new Error('maxInflightPerUser must be a positive integer or Infinity')
    }
  }

  acquire(user: string, opts: AcquireOptions): Promise<CapacityPermit> {
    const tokenId = opts.tokenId ?? user
    if (opts.signal?.aborted) {
      return Promise.reject(new CapacityQueueError(499, '请求已取消'))
    }

    // Count both active and queued work. Checking this before the queue-full fallback is
    // essential: a repeat request from an early installation must not bypass the global
    // queue simply because its own active-only limit currently leaves a slot elsewhere.
    if (this.inflightForUser(user) >= this.maxInflightPerUser) {
      return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，请稍后重试'))
    }

    if (this.waitingUsers.length === 0 && this.canStart(user, tokenId)) {
      return Promise.resolve(this.grant(user, tokenId))
    }

    if (opts.maxWaitMs <= 0) {
      return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，请稍后重试'))
    }

    // A finite queue is as important as the active concurrency ceiling: each queued
    // request retains its parsed body and response promise. Refuse overflow before it
    // can turn a short burst into unbounded gateway memory/latency.
    if (this.queuedCount() >= this.queueMax) {
      // A small per-installation cap can make an early desktop enqueue several
      // follow-up windows while the global pool is still mostly idle.  The usual
      // queue-first rule must not then turn those temporarily ineligible waiters
      // into head-of-line blocking for a later desktop that could use an empty
      // slot.  Drain first; if no already-queued identity can start, letting this
      // newly arrived eligible identity through preserves every runnable waiter's
      // priority while keeping the global pool utilized.
      this.drain()
      if (!this.hasRunnablePending() && this.canStart(user, tokenId)) {
        return Promise.resolve(this.grant(user, tokenId))
      }
      return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，排队已满，请稍后重试'))
    }

    return new Promise<CapacityPermit>((resolve, reject) => {
      const pending: Pending = { user, tokenId, queuedAt: performance.now(), resolve, reject, signal: opts.signal }
      let queue = this.pendingByUser.get(user)
      if (!queue) {
        queue = []
        this.pendingByUser.set(user, queue)
        this.waitingUsers.push(user)
      }
      queue.push(pending)

      const removeAndReject = (error: CapacityQueueError) => {
        if (!this.removePending(pending)) return
        this.cleanupPending(pending)
        reject(error)
        this.drain()
      }
      pending.timer = setTimeout(
        () => removeAndReject(new CapacityQueueError(429, '当前使用人数较多，排队等待超时，请稍后重试')),
        opts.maxWaitMs,
      )
      pending.onAbort = () => removeAndReject(new CapacityQueueError(499, '请求已取消'))
      opts.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.drain()
    })
  }

  snapshot(): CapacitySnapshot {
    let oldestQueuedAt = Infinity
    for (const queue of this.pendingByUser.values()) {
      for (const pending of queue) oldestQueuedAt = Math.min(oldestQueuedAt, pending.queuedAt)
    }
    const queued = this.queuedCount()
    return {
      active: this.active,
      queued,
      maxConcurrent: this.maxConcurrent,
      maxConcurrentPerUser: this.maxConcurrentPerUser,
      maxConcurrentPerToken: this.maxConcurrentPerToken,
      queueMax: this.queueMax,
      oldestQueueMs: oldestQueuedAt === Infinity ? 0 : Math.max(0, Math.trunc(performance.now() - oldestQueuedAt)),
    }
  }

  private queuedCount(): number {
    let queued = 0
    for (const queue of this.pendingByUser.values()) queued += queue.length
    return queued
  }

  /** Active + pending work for one fair-scheduling identity. A queued request keeps
   * this count while it is granted, so draining the queue never accidentally consumes a
   * second allowance. */
  private inflightForUser(user: string): number {
    return (this.activeByUser.get(user) ?? 0) + (this.pendingByUser.get(user)?.length ?? 0)
  }

  private canStart(user: string, tokenId: string): boolean {
    return this.active < this.maxConcurrent
      && (this.activeByUser.get(user) ?? 0) < this.maxConcurrentPerUser
      && (this.activeByToken.get(tokenId) ?? 0) < this.maxConcurrentPerToken
  }

  /** Whether an already queued request can take a permit immediately. Used only
   * when the bounded queue is full, so a temporarily blocked owner cannot leave
   * globally idle capacity stranded while also ensuring an eligible waiter is never
   * bypassed by a later arrival. */
  private hasRunnablePending(): boolean {
    for (const user of this.waitingUsers) {
      const pending = this.pendingByUser.get(user)?.[0]
      if (pending && this.canStart(user, pending.tokenId)) return true
    }
    return false
  }

  private grant(user: string, tokenId: string): CapacityPermit {
    this.active += 1
    this.activeByUser.set(user, (this.activeByUser.get(user) ?? 0) + 1)
    this.activeByToken.set(tokenId, (this.activeByToken.get(tokenId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        const nextUser = Math.max(0, (this.activeByUser.get(user) ?? 1) - 1)
        if (nextUser === 0) this.activeByUser.delete(user)
        else this.activeByUser.set(user, nextUser)
        const nextToken = Math.max(0, (this.activeByToken.get(tokenId) ?? 1) - 1)
        if (nextToken === 0) this.activeByToken.delete(tokenId)
        else this.activeByToken.set(tokenId, nextToken)
        this.drain()
      },
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waitingUsers.length > 0) {
      const candidates = this.waitingUsers.length
      let granted = false
      for (let i = 0; i < candidates; i++) {
        const user = this.waitingUsers.shift()!
        const queue = this.pendingByUser.get(user)
        if (!queue || queue.length === 0) {
          this.pendingByUser.delete(user)
          continue
        }
        // All pendings for one user share the same tokenId (user = token#client).
        if (!this.canStart(user, queue[0].tokenId)) {
          this.waitingUsers.push(user)
          continue
        }

        const pending = queue.shift()!
        if (queue.length > 0) this.waitingUsers.push(user)
        else this.pendingByUser.delete(user)
        this.cleanupPending(pending)
        pending.resolve(this.grant(user, pending.tokenId))
        granted = true
        break
      }
      if (!granted) break
    }
  }

  private removePending(pending: Pending): boolean {
    const queue = this.pendingByUser.get(pending.user)
    if (!queue) return false
    const index = queue.indexOf(pending)
    if (index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) {
      this.pendingByUser.delete(pending.user)
      const userIndex = this.waitingUsers.indexOf(pending.user)
      if (userIndex >= 0) this.waitingUsers.splice(userIndex, 1)
    }
    return true
  }

  private cleanupPending(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort)
  }
}
