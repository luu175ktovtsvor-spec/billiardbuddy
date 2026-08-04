import { CapacityQueueError } from '../ts/shared/kernel/providerAdmission.js'

export { CapacityQueueError, ProviderRateLimiter } from '../ts/shared/kernel/providerAdmission.js'

export interface CapacityPermit {
  release(): void
}

export interface CapacitySnapshot {
  active: number
  queued: number
  maxConcurrent: number
  maxConcurrentPerUser: number
  maxConcurrentPerToken: number
  maxInflightPerUser: number
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
  /** Verified principal this installation belongs to. Bounds all installations of
   *  one principal together. Defaults to the verified installation owner. */
  tokenId?: string
}

export type MimoLane = 'media' | 'vision'

export type MimoReservationConfig = {
  /** Account-wide physical ceiling. It must exactly equal the two lane reservations. */
  maxConcurrent: number
  mediaConcurrent: number
  visionConcurrent: number
  /** All MiMo paths for an installation share this active-call cap. */
  maxConcurrentPerUser: number
  /** All MiMo paths for a token share this active-call cap. */
  maxConcurrentPerToken: number
  /** All MiMo paths for an installation share this active + queued cap. */
  maxInflightPerUser: number
  mediaQueueMax: number
  visionQueueMax: number
  /** Vision has its own stricter per-installation caps in addition to the shared ones. */
  visionMaxConcurrentPerUser: number
  visionMaxInflightPerUser: number
}

type MimoPending = {
  lane: MimoLane
  user: string
  tokenId: string
  queuedAt: number
  resolve: (permit: CapacityPermit) => void
  reject: (error: CapacityQueueError) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

type MimoLaneLimits = Record<MimoLane, number>

/**
 * One atomic scheduler for an account that reserves physical capacity for two request
 * classes. A grant checks the account, lane, token, installation and queue limits in
 * one operation. This is deliberately not composed from separate media/vision gates:
 * independently acquiring two queues can leave a request holding one physical slot
 * while it waits for another, which defeats the visual reservation and can deadlock.
 */
export class MimoReservationScheduler {
  private active = 0
  private readonly activeByLane: Record<MimoLane, number> = { media: 0, vision: 0 }
  private readonly activeByUser = new Map<string, number>()
  private readonly activeVisionByUser = new Map<string, number>()
  private readonly activeByToken = new Map<string, number>()
  private readonly pendingByUser = new Map<string, MimoPending[]>()
  private readonly waitingUsers: string[] = []
  private readonly queuedByLane: Record<MimoLane, number> = { media: 0, vision: 0 }
  private readonly laneLimits: MimoLaneLimits
  private readonly laneQueueMax: MimoLaneLimits

  constructor(private readonly config: MimoReservationConfig) {
    this.laneLimits = { media: config.mediaConcurrent, vision: config.visionConcurrent }
    this.laneQueueMax = { media: config.mediaQueueMax, vision: config.visionQueueMax }
    for (const [name, value] of Object.entries({
      maxConcurrent: config.maxConcurrent,
      mediaConcurrent: config.mediaConcurrent,
      visionConcurrent: config.visionConcurrent,
      maxConcurrentPerUser: config.maxConcurrentPerUser,
      maxConcurrentPerToken: config.maxConcurrentPerToken,
      maxInflightPerUser: config.maxInflightPerUser,
      visionMaxConcurrentPerUser: config.visionMaxConcurrentPerUser,
      visionMaxInflightPerUser: config.visionMaxInflightPerUser,
    })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
    }
    for (const [name, value] of Object.entries(this.laneQueueMax)) {
      if (!Number.isInteger(value) || value < 0) throw new Error(`${name} queue max must be a non-negative integer`)
    }
    if (config.mediaConcurrent + config.visionConcurrent !== config.maxConcurrent) {
      throw new Error('MiMo media and vision reservations must exactly equal the account capacity')
    }
  }

  /** Adapter for media reasoning MiMo chat, whose generic handler expects FairCapacityScheduler's surface. */
  forLane(lane: MimoLane): { acquire(user: string, opts: AcquireOptions): Promise<CapacityPermit>; snapshot(): CapacitySnapshot } {
    return {
      acquire: (user, opts) => this.acquire(lane, user, opts),
      snapshot: () => this.laneSnapshot(lane),
    }
  }

  acquire(lane: MimoLane, user: string, opts: AcquireOptions): Promise<CapacityPermit> {
    const tokenId = opts.tokenId ?? user
    if (opts.signal?.aborted) return Promise.reject(new CapacityQueueError(499, '请求已取消'))
    if (this.inflightForUser(user) >= this.config.maxInflightPerUser ||
      (lane === 'vision' && this.inflightVisionForUser(user) >= this.config.visionMaxInflightPerUser)) {
      return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，请稍后重试'))
    }

    if (this.waitingUsers.length === 0 && this.canStart(lane, user, tokenId)) {
      return Promise.resolve(this.grant(lane, user, tokenId))
    }
    if (opts.maxWaitMs <= 0) return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，请稍后重试'))

    if (this.queuedByLane[lane] >= this.laneQueueMax[lane]) {
      this.drain()
      if (!this.hasRunnablePending() && this.canStart(lane, user, tokenId)) {
        return Promise.resolve(this.grant(lane, user, tokenId))
      }
      // Preserve the existing one-token burst behavior until another token actually
      // arrives. Once a fresh, runnable token does arrive, do not let a token that is
      // already at its active ceiling occupy every waiting seat: otherwise a release
      // from a different token can leave a physical lane slot idle behind only blocked
      // waiters. The displaced waiter receives the same explicit 429 as a full queue.
      if (this.queuedByLane[lane] >= this.laneQueueMax[lane] && !this.makeRoomForFreshRunnableToken(lane, tokenId)) {
        return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，排队已满，请稍后重试'))
      }
    }

    return new Promise<CapacityPermit>((resolve, reject) => {
      const pending: MimoPending = { lane, user, tokenId, queuedAt: performance.now(), resolve, reject, signal: opts.signal }
      let queue = this.pendingByUser.get(user)
      if (!queue) {
        queue = []
        this.pendingByUser.set(user, queue)
        this.waitingUsers.push(user)
      }
      queue.push(pending)
      this.queuedByLane[lane] += 1

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
    return this.makeSnapshot(undefined)
  }

  laneSnapshot(lane: MimoLane): CapacitySnapshot {
    return this.makeSnapshot(lane)
  }

  private makeSnapshot(lane: MimoLane | undefined): CapacitySnapshot {
    const queueMax = lane === undefined ? this.laneQueueMax.media + this.laneQueueMax.vision : this.laneQueueMax[lane]
    const active = lane === undefined ? this.active : this.activeByLane[lane]
    const queued = lane === undefined ? this.queuedByLane.media + this.queuedByLane.vision : this.queuedByLane[lane]
    return {
      active,
      queued,
      maxConcurrent: lane === undefined ? this.config.maxConcurrent : this.laneLimits[lane],
      maxConcurrentPerUser: lane === 'vision'
        ? Math.min(this.config.maxConcurrentPerUser, this.config.visionMaxConcurrentPerUser)
        : this.config.maxConcurrentPerUser,
      maxConcurrentPerToken: this.config.maxConcurrentPerToken,
      maxInflightPerUser: lane === 'vision'
        ? Math.min(this.config.maxInflightPerUser, this.config.visionMaxInflightPerUser)
        : this.config.maxInflightPerUser,
      queueMax,
      oldestQueueMs: this.oldestQueueMs(lane),
    }
  }

  private oldestQueueMs(lane: MimoLane | undefined): number {
    let oldest = Infinity
    for (const queue of this.pendingByUser.values()) {
      for (const pending of queue) {
        if (lane === undefined || pending.lane === lane) oldest = Math.min(oldest, pending.queuedAt)
      }
    }
    return oldest === Infinity ? 0 : Math.max(0, Math.trunc(performance.now() - oldest))
  }

  private inflightForUser(user: string): number {
    return (this.activeByUser.get(user) ?? 0) + (this.pendingByUser.get(user)?.length ?? 0)
  }

  private inflightVisionForUser(user: string): number {
    return (this.activeVisionByUser.get(user) ?? 0) + (this.pendingByUser.get(user)?.filter(pending => pending.lane === 'vision').length ?? 0)
  }

  private canStart(lane: MimoLane, user: string, tokenId: string): boolean {
    const perUser = lane === 'vision'
      ? Math.min(this.config.maxConcurrentPerUser, this.config.visionMaxConcurrentPerUser)
      : this.config.maxConcurrentPerUser
    const laneUserActive = lane === 'vision' ? this.activeVisionByUser.get(user) ?? 0 : this.activeByUser.get(user) ?? 0
    return this.active < this.config.maxConcurrent &&
      this.activeByLane[lane] < this.laneLimits[lane] &&
      (this.activeByUser.get(user) ?? 0) < this.config.maxConcurrentPerUser &&
      laneUserActive < perUser &&
      (this.activeByToken.get(tokenId) ?? 0) < this.config.maxConcurrentPerToken
  }

  private hasRunnablePending(): boolean {
    for (const user of this.waitingUsers) {
      const queue = this.pendingByUser.get(user)
      if (queue?.some(pending => this.canStart(pending.lane, user, pending.tokenId))) return true
    }
    return false
  }

  /**
   * A full lane queue should not turn a token-active cap into an idle physical slot.
   * A new token gets one waiting seat only by displacing a repeat waiter, or a waiter
   * whose token is already at its active ceiling. This is intentionally demand-driven:
   * a single shared product token can still use every short burst seat until another
   * authenticated token needs fair access.
   */
  private makeRoomForFreshRunnableToken(lane: MimoLane, tokenId: string): boolean {
    if ((this.activeByToken.get(tokenId) ?? 0) >= this.config.maxConcurrentPerToken) return false

    const queuedByToken = new Map<string, number>()
    for (const queue of this.pendingByUser.values()) {
      for (const pending of queue) {
        if (pending.lane !== lane) continue
        queuedByToken.set(pending.tokenId, (queuedByToken.get(pending.tokenId) ?? 0) + 1)
      }
    }
    // A token that already has a queued request must not evict another token just to
    // accumulate more waiters; the normal bounded queue remains its back-pressure.
    if ((queuedByToken.get(tokenId) ?? 0) > 0) return false

    let donor: string | undefined
    let donorScore = 0
    for (const [candidateToken, count] of queuedByToken) {
      const tokenAtActiveCap = (this.activeByToken.get(candidateToken) ?? 0) >= this.config.maxConcurrentPerToken
      // Prefer the token with repeat reservations. With a one-entry queue, a blocked
      // token-cap waiter is also safe to displace: it cannot use a slot released by a
      // different token, while the incoming token can.
      const score = count > 1 ? 2 + count : tokenAtActiveCap ? 1 : 0
      if (score > donorScore) {
        donor = candidateToken
        donorScore = score
      }
    }
    if (!donor) return false

    // Drop the newest eligible waiter so an older request from that token retains its
    // place. `removePending` updates lane counters and waiting-user bookkeeping.
    let displaced: MimoPending | undefined
    for (const queue of this.pendingByUser.values()) {
      for (let index = queue.length - 1; index >= 0; index--) {
        const pending = queue[index]!
        if (pending.lane === lane && pending.tokenId === donor) {
          displaced = pending
          break
        }
      }
      if (displaced) break
    }
    if (!displaced || !this.removePending(displaced)) return false
    this.cleanupPending(displaced)
    displaced.reject(new CapacityQueueError(429, '当前使用人数较多，排队已满，请稍后重试'))
    return true
  }

  private grant(lane: MimoLane, user: string, tokenId: string): CapacityPermit {
    this.active += 1
    this.activeByLane[lane] += 1
    this.activeByUser.set(user, (this.activeByUser.get(user) ?? 0) + 1)
    if (lane === 'vision') this.activeVisionByUser.set(user, (this.activeVisionByUser.get(user) ?? 0) + 1)
    this.activeByToken.set(tokenId, (this.activeByToken.get(tokenId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.activeByLane[lane] = Math.max(0, this.activeByLane[lane] - 1)
        const nextUser = Math.max(0, (this.activeByUser.get(user) ?? 1) - 1)
        if (nextUser === 0) this.activeByUser.delete(user)
        else this.activeByUser.set(user, nextUser)
        if (lane === 'vision') {
          const nextVision = Math.max(0, (this.activeVisionByUser.get(user) ?? 1) - 1)
          if (nextVision === 0) this.activeVisionByUser.delete(user)
          else this.activeVisionByUser.set(user, nextVision)
        }
        const nextToken = Math.max(0, (this.activeByToken.get(tokenId) ?? 1) - 1)
        if (nextToken === 0) this.activeByToken.delete(tokenId)
        else this.activeByToken.set(tokenId, nextToken)
        this.drain()
      },
    }
  }

  private drain(): void {
    while (this.active < this.config.maxConcurrent && this.waitingUsers.length > 0) {
      const candidates = this.waitingUsers.length
      let granted = false
      for (let i = 0; i < candidates; i++) {
        const user = this.waitingUsers.shift()!
        const queue = this.pendingByUser.get(user)
        if (!queue || queue.length === 0) {
          this.pendingByUser.delete(user)
          continue
        }
        const pendingIndex = queue.findIndex(pending => this.canStart(pending.lane, user, pending.tokenId))
        if (pendingIndex < 0) {
          this.waitingUsers.push(user)
          continue
        }
        const [pending] = queue.splice(pendingIndex, 1)
        if (!pending) continue
        this.queuedByLane[pending.lane] = Math.max(0, this.queuedByLane[pending.lane] - 1)
        if (queue.length > 0) this.waitingUsers.push(user)
        else this.pendingByUser.delete(user)
        this.cleanupPending(pending)
        pending.resolve(this.grant(pending.lane, user, pending.tokenId))
        granted = true
        break
      }
      if (!granted) return
    }
  }

  private removePending(pending: MimoPending): boolean {
    const queue = this.pendingByUser.get(pending.user)
    if (!queue) return false
    const index = queue.indexOf(pending)
    if (index < 0) return false
    queue.splice(index, 1)
    this.queuedByLane[pending.lane] = Math.max(0, this.queuedByLane[pending.lane] - 1)
    if (queue.length === 0) {
      this.pendingByUser.delete(pending.user)
      const userIndex = this.waitingUsers.indexOf(pending.user)
      if (userIndex >= 0) this.waitingUsers.splice(userIndex, 1)
    }
    return true
  }

  private cleanupPending(pending: MimoPending): void {
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort)
  }
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
 *  - `maxConcurrentPerToken`— all verified installations under one principal combined.
 *  - `maxConcurrentPerUser` — one verified installation owner. Gives each installation
 *    its fair share without accepting a caller-supplied identity header.
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
      maxInflightPerUser: this.maxInflightPerUser,
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
