/**
 * Process-local serialization for mutations that must not interleave for the
 * same ProductTask. Durable dispatch authority remains the source of truth;
 * this lock only keeps a workspace commit atomic within the current process.
 */
export class SessionAdmissionBarrier {
  private readonly tails = new Map<string, Promise<void>>()

  async withRunStart<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.withTask(taskId, fn)
  }

  async withWorkspaceMutation<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.withTask(taskId, fn)
  }

  /** Test-visible queue cardinality; no queue internals are exposed. */
  get pendingSessionCount(): number { return this.tails.size }

  private async withTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(taskId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(taskId, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      // Only the latest queued tail owns map cleanup. An older operation must
      // never erase a successor that queued while it was executing.
      if (this.tails.get(taskId) === tail) this.tails.delete(taskId)
    }
  }
}

export const sessionAdmissionBarrier = new SessionAdmissionBarrier()
