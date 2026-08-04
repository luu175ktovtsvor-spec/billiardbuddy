import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

export type VideoExportDestinationGrant = Readonly<{
  destination_grant_id: string
  display_name: string
}>

type StoredVideoDestinationGrant = Readonly<{
  projectId: string
  variantId: string
  path: string
  purpose: 'delivery_export'
  mimeType: string
  expiresAt: number
}>

function assertVideoDestinationMime(mimeType: string): void {
  if (mimeType !== 'video/mp4' && mimeType !== 'video/quicktime') {
    throw new Error('Video destination grant requires an MP4 or QuickTime MIME type')
  }
}

function displayNameForPath(path: string): string {
  const displayName = basename(path).trim()
  if (!displayName || displayName === '.' || displayName === '..' || displayName.includes('\0')) {
    throw new Error('Video destination grant requires a file path with a displayable basename')
  }
  return displayName
}

/**
 * Main-process-only authority for a native video export destination.  The
 * grant binds the save-dialog choice to the exact project and delivery
 * variant; it expires and is consumed before the Sidecar receives a path.
 */
export class VideoDestinationGrants {
  private readonly grants = new Map<string, StoredVideoDestinationGrant>()

  constructor(private readonly ttlMs = 5 * 60_000) {}

  issue(
    projectId: string,
    variantId: string,
    path: string,
    mimeType: string,
    now = Date.now(),
  ): VideoExportDestinationGrant {
    assertVideoDestinationMime(mimeType)
    const displayName = displayNameForPath(path)
    const destination_grant_id = `vdg_${randomBytes(16).toString('hex')}`
    this.grants.set(destination_grant_id, { projectId, variantId, path, purpose: 'delivery_export', mimeType, expiresAt: now + this.ttlMs })
    return { destination_grant_id, display_name: displayName }
  }

  consume(projectId: string, variantId: string, expectedMimeType: string, destinationGrantId: string, now = Date.now()): string | null {
    const grant = this.grants.get(destinationGrantId)
    this.grants.delete(destinationGrantId)
    if (!grant
      || grant.projectId !== projectId
      || grant.variantId !== variantId
      || grant.purpose !== 'delivery_export'
      || grant.mimeType !== expectedMimeType
      || grant.expiresAt <= now) return null
    return grant.path
  }

  revokeProject(projectId: string): void {
    for (const [id, grant] of this.grants) {
      if (grant.projectId === projectId) this.grants.delete(id)
    }
  }

  revokeAll(): void {
    this.grants.clear()
  }
}
