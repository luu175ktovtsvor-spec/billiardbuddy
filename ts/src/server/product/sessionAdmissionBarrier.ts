/**
 * Process-local admission serialization for a Core session.
 * The generic websocket runtime is the single owner of Core runs, so this is
 * deliberately not durable state: it only prevents a workspace bind decision
 * from interleaving with the moment a new user turn becomes active.
 */
export class SessionAdmissionBarrier {
  private readonly tails = new Map<string, Promise<void>>()

  async withRunStart<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.withSession(sessionId, fn)
  }

  async withWorkspaceMutation<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.withSession(sessionId, fn)
  }

  /** Test-visible queue cardinality; no queue internals are exposed. */
  get pendingSessionCount(): number { return this.tails.size }

  private async withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(sessionId, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      // Only the latest queued tail owns map cleanup. An older operation must
      // never erase a successor that queued while it was executing.
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    }
  }
}

export const sessionAdmissionBarrier = new SessionAdmissionBarrier()
