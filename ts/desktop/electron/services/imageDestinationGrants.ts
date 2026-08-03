import { randomBytes } from 'node:crypto'

/** Main-process-only, one-shot authority for a native save-dialog result. */
export class ImageDestinationGrants {
  private readonly grants = new Map<string, { path: string; expiresAt: number }>()

  issue(path: string, now = Date.now()): { destination_grant_id: string; expires_at: string } {
    const destination_grant_id = `dgr_${randomBytes(16).toString('hex')}`
    const expiresAt = now + 5 * 60_000
    this.grants.set(destination_grant_id, { path, expiresAt })
    return { destination_grant_id, expires_at: new Date(expiresAt).toISOString() }
  }

  consume(destinationGrantId: string, now = Date.now()): string | null {
    const grant = this.grants.get(destinationGrantId)
    this.grants.delete(destinationGrantId)
    return grant && grant.expiresAt >= now ? grant.path : null
  }

  revokeAll(): void { this.grants.clear() }
}
