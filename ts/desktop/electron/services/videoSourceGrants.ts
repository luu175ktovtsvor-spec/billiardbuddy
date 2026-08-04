import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

export type VideoSourceSelectionGrant = Readonly<{
  selection_id: string
  display_name: string
  size_bytes?: number
}>

type StoredVideoSourceGrant = Readonly<{
  projectId: string
  path: string
  purpose: 'source_import'
  mimeType: string
  expiresAt: number
}>

function assertVideoSourceMime(mimeType: string): void {
  if (!/^video\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw new Error('Video source grant requires a video MIME type')
  }
}

function displayNameForPath(path: string): string {
  const displayName = basename(path).trim()
  if (!displayName || displayName === '.' || displayName === '..' || displayName.includes('\0')) {
    throw new Error('Video source grant requires a file path with a displayable basename')
  }
  return displayName
}

/**
 * Main-process-only authority for native video source selections.
 *
 * The renderer can display a filename and byte size, but it never receives a
 * local path.  Batch consumption is all-or-nothing so a malformed or expired
 * selection cannot partially import files the user did not confirm together.
 */
export class VideoSourceGrants {
  private readonly grants = new Map<string, StoredVideoSourceGrant>()

  constructor(private readonly ttlMs = 5 * 60_000) {}

  issue(
    projectId: string,
    path: string,
    mimeType: string,
    sizeBytes?: number,
    now = Date.now(),
  ): VideoSourceSelectionGrant {
    assertVideoSourceMime(mimeType)
    const displayName = displayNameForPath(path)
    const selection_id = `vsg_${randomBytes(16).toString('hex')}`
    this.grants.set(selection_id, { projectId, path, purpose: 'source_import', mimeType, expiresAt: now + this.ttlMs })
    return {
      selection_id,
      display_name: displayName,
      ...(sizeBytes === undefined ? {} : { size_bytes: sizeBytes }),
    }
  }

  consume(projectId: string, selectionIds: readonly string[], now = Date.now()): readonly string[] | null {
    if (!selectionIds.length || new Set(selectionIds).size !== selectionIds.length) return null
    const selected = selectionIds.map(id => [id, this.grants.get(id)] as const)
    if (selected.some(([, grant]) => !grant
      || grant.projectId !== projectId
      || grant.purpose !== 'source_import'
      || !/^video\/[a-z0-9.+-]+$/i.test(grant.mimeType)
      || grant.expiresAt <= now)) return null
    for (const [id] of selected) this.grants.delete(id)
    return selected.map(([, grant]) => grant!.path)
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
