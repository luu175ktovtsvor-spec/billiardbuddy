/** Shared process-local view of generic Core turns for workspace admission. */
export class ActiveCoreRunRegistry {
  private readonly active = new Map<string, number>()
  markActive(sessionId: string): void { this.active.set(sessionId, (this.active.get(sessionId) ?? 0) + 1) }
  markInactive(sessionId: string): void { const count = this.active.get(sessionId) ?? 0; if (count <= 1) this.active.delete(sessionId); else this.active.set(sessionId, count - 1) }
  hasActive(sessionId: string): boolean { return (this.active.get(sessionId) ?? 0) > 0 }
}
export const activeCoreRunRegistry = new ActiveCoreRunRegistry()
