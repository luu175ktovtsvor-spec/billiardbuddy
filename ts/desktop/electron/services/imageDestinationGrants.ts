import { randomBytes } from 'node:crypto'

/** Main-process-only, one-shot authority for a native save-dialog result. */
export class ImageDestinationGrants {
  private readonly grants = new Map<string, {
    path: string
    expiresAt: number
    senderId: number
    projectId: string
    versionId: string
  }>()

  issue(
    path: string,
    subject: { senderId: number; projectId: string; versionId: string },
    now = Date.now(),
  ): { destination_grant_id: string; expires_at: string } {
    const destination_grant_id = `dgr_${randomBytes(16).toString('hex')}`
    const expiresAt = now + 5 * 60_000
    this.grants.set(destination_grant_id, { path, expiresAt, ...subject })
    return { destination_grant_id, expires_at: new Date(expiresAt).toISOString() }
  }

  consume(
    destinationGrantId: string,
    subject: { senderId: number; projectId: string; versionId: string },
    now = Date.now(),
  ): string | null {
    const grant = this.grants.get(destinationGrantId)
    if (!grant || grant.expiresAt < now) {
      this.grants.delete(destinationGrantId)
      return null
    }
    // A renderer IPC request is untrusted. Any attempt to consume a grant is
    // terminal so a mismatched sender/project/version cannot probe the grant
    // and then leave it usable for a later retry.
    this.grants.delete(destinationGrantId)
    if (
      grant.senderId !== subject.senderId
      || grant.projectId !== subject.projectId
      || grant.versionId !== subject.versionId
    ) return null
    return grant.path
  }

  revokeAll(): void { this.grants.clear() }
}
