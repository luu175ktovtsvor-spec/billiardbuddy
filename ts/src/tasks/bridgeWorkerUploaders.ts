export class BridgeRetryableUploadError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}

type BridgeSerialBatchUploaderConfig<T> = {
  maxBatchSize: number
  maxBatchBytes?: number
  maxQueueSize: number
  send: (batch: T[]) => Promise<void>
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
  maxConsecutiveFailures?: number
  onBatchDropped?: (batchSize: number, failures: number) => void
}

export class BridgeSerialBatchUploader<T> {
  private pending: T[] = []
  private pendingAtClose = 0
  private draining = false
  private closed = false
  private backpressureResolvers: Array<() => void> = []
  private sleepResolve: (() => void) | null = null
  private flushResolvers: Array<() => void> = []
  private droppedBatches = 0

  constructor(private readonly config: BridgeSerialBatchUploaderConfig<T>) {}

  get droppedBatchCount(): number {
    return this.droppedBatches
  }

  get pendingCount(): number {
    return this.closed ? this.pendingAtClose : this.pending.length
  }

  async enqueue(events: T | T[]): Promise<void> {
    if (this.closed) return
    const items = Array.isArray(events) ? events : [events]
    if (items.length === 0) return
    while (this.pending.length + items.length > this.config.maxQueueSize && !this.closed) {
      await new Promise<void>(resolve => {
        this.backpressureResolvers.push(resolve)
      })
    }
    if (this.closed) return
    this.pending.push(...items)
    void this.drain()
  }

  flush(): Promise<void> {
    if (this.pending.length === 0 && !this.draining) return Promise.resolve()
    void this.drain()
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pendingAtClose = this.pending.length
    this.pending = []
    this.sleepResolve?.()
    this.sleepResolve = null
    for (const resolve of this.backpressureResolvers) resolve()
    this.backpressureResolvers = []
    for (const resolve of this.flushResolvers) resolve()
    this.flushResolvers = []
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    let failures = 0
    try {
      while (this.pending.length > 0 && !this.closed) {
        const batch = this.takeBatch()
        if (batch.length === 0) continue
        try {
          await this.config.send(batch)
          failures = 0
        } catch (err) {
          failures++
          if (this.config.maxConsecutiveFailures !== undefined && failures >= this.config.maxConsecutiveFailures) {
            this.droppedBatches++
            this.config.onBatchDropped?.(batch.length, failures)
            failures = 0
            this.releaseBackpressure()
            continue
          }
          this.pending = batch.concat(this.pending)
          const retryAfterMs = err instanceof BridgeRetryableUploadError ? err.retryAfterMs : undefined
          await this.sleep(this.retryDelay(failures, retryAfterMs))
          continue
        }
        this.releaseBackpressure()
      }
    } finally {
      this.draining = false
      if (this.pending.length === 0) {
        for (const resolve of this.flushResolvers) resolve()
        this.flushResolvers = []
      }
    }
  }

  private takeBatch(): T[] {
    const { maxBatchSize, maxBatchBytes } = this.config
    if (maxBatchBytes === undefined) return this.pending.splice(0, maxBatchSize)
    let bytes = 0
    let count = 0
    while (count < this.pending.length && count < maxBatchSize) {
      let itemBytes: number
      try {
        itemBytes = Buffer.byteLength(JSON.stringify(this.pending[count]))
      } catch {
        this.pending.splice(count, 1)
        continue
      }
      if (count > 0 && bytes + itemBytes > maxBatchBytes) break
      bytes += itemBytes
      count++
    }
    return this.pending.splice(0, count)
  }

  private retryDelay(failures: number, retryAfterMs?: number): number {
    const jitter = Math.random() * this.config.jitterMs
    if (retryAfterMs !== undefined) {
      const clamped = Math.max(this.config.baseDelayMs, Math.min(retryAfterMs, this.config.maxDelayMs))
      return clamped + jitter
    }
    return Math.min(this.config.baseDelayMs * 2 ** (failures - 1), this.config.maxDelayMs) + jitter
  }

  private releaseBackpressure(): void {
    const resolvers = this.backpressureResolvers
    this.backpressureResolvers = []
    for (const resolve of resolvers) resolve()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.sleepResolve = resolve
      setTimeout(() => {
        this.sleepResolve = null
        resolve()
      }, ms)
    })
  }
}

type BridgeWorkerStateUploaderConfig = {
  send: (body: Record<string, unknown>) => Promise<boolean>
  baseDelayMs: number
  maxDelayMs: number
  jitterMs: number
}

export class BridgeWorkerStateUploader {
  private inflight: Promise<void> | null = null
  private pending: Record<string, unknown> | null = null
  private closed = false
  private flushResolvers: Array<() => void> = []

  constructor(private readonly config: BridgeWorkerStateUploaderConfig) {}

  enqueue(patch: Record<string, unknown>): void {
    if (this.closed) return
    this.pending = this.pending ? coalescePatches(this.pending, patch) : patch
    void this.drain()
  }

  flush(): Promise<void> {
    if (!this.pending && !this.inflight) return Promise.resolve()
    void this.drain()
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  close(): void {
    this.closed = true
    this.pending = null
    for (const resolve of this.flushResolvers) resolve()
    this.flushResolvers = []
  }

  private async drain(): Promise<void> {
    if (this.inflight || this.closed || !this.pending) return
    const payload = this.pending
    this.pending = null
    this.inflight = this.sendWithRetry(payload).then(() => {
      this.inflight = null
      if (this.pending && !this.closed) void this.drain()
      if (!this.pending) {
        for (const resolve of this.flushResolvers) resolve()
        this.flushResolvers = []
      }
    })
  }

  private async sendWithRetry(payload: Record<string, unknown>): Promise<void> {
    let current = payload
    let failures = 0
    while (!this.closed) {
      const ok = await this.config.send(current)
      if (ok) return
      failures++
      await sleep(this.retryDelay(failures))
      if (this.pending && !this.closed) {
        current = coalescePatches(current, this.pending)
        this.pending = null
      }
    }
  }

  private retryDelay(failures: number): number {
    return Math.min(this.config.baseDelayMs * 2 ** (failures - 1), this.config.maxDelayMs) + Math.random() * this.config.jitterMs
  }
}

function coalescePatches(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (
      (key === 'external_metadata' || key === 'internal_metadata') &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      typeof value === 'object' &&
      value !== null
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      }
    } else {
      merged[key] = value
    }
  }
  return merged
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
