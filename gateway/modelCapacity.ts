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
}

type Pending = {
  user: string
  resolve: (permit: CapacityPermit) => void
  reject: (error: CapacityQueueError) => void
  timer?: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * One capacity pool with round-robin admission across users. A user may queue
 * several requests, but each scheduling pass grants at most one before moving
 * to the next user.
 */
export class FairCapacityScheduler {
  private active = 0
  private readonly activeByUser = new Map<string, number>()
  private readonly pendingByUser = new Map<string, Pending[]>()
  private readonly waitingUsers: string[] = []

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxConcurrentPerUser: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1')
    if (!Number.isInteger(maxConcurrentPerUser) || maxConcurrentPerUser < 1) {
      throw new Error('maxConcurrentPerUser must be >= 1')
    }
  }

  acquire(user: string, opts: { maxWaitMs: number; signal?: AbortSignal }): Promise<CapacityPermit> {
    if (opts.signal?.aborted) {
      return Promise.reject(new CapacityQueueError(499, '请求已取消'))
    }

    if (this.waitingUsers.length === 0 && this.canStart(user)) {
      return Promise.resolve(this.grant(user))
    }

    if (opts.maxWaitMs <= 0) {
      return Promise.reject(new CapacityQueueError(429, '当前使用人数较多，请稍后重试'))
    }

    return new Promise<CapacityPermit>((resolve, reject) => {
      const pending: Pending = { user, resolve, reject, signal: opts.signal }
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
    let queued = 0
    for (const queue of this.pendingByUser.values()) queued += queue.length
    return {
      active: this.active,
      queued,
      maxConcurrent: this.maxConcurrent,
      maxConcurrentPerUser: this.maxConcurrentPerUser,
    }
  }

  private canStart(user: string): boolean {
    return this.active < this.maxConcurrent
      && (this.activeByUser.get(user) ?? 0) < this.maxConcurrentPerUser
  }

  private grant(user: string): CapacityPermit {
    this.active += 1
    this.activeByUser.set(user, (this.activeByUser.get(user) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        const next = Math.max(0, (this.activeByUser.get(user) ?? 1) - 1)
        if (next === 0) this.activeByUser.delete(user)
        else this.activeByUser.set(user, next)
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
        if (!this.canStart(user)) {
          this.waitingUsers.push(user)
          continue
        }

        const pending = queue.shift()!
        if (queue.length > 0) this.waitingUsers.push(user)
        else this.pendingByUser.delete(user)
        this.cleanupPending(pending)
        pending.resolve(this.grant(user))
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
