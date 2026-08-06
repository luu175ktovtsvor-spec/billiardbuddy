import type { VideoReviewNote, VideoStudioProject } from '../../../../../shared/contracts/media.js'

/**
 * Review feedback is stored as an immutable note plus append-only resolution
 * events. This projection is deliberately deterministic so SQLite recovery,
 * API reads and the desktop snapshot cannot disagree about a note's state.
 */
export function materializeVideoReviewNotes(project: VideoStudioProject): VideoReviewNote[] {
  const latest = new Map<string, VideoStudioProject['review_resolutions'][number]>()
  for (const resolution of project.review_resolutions) {
    const current = latest.get(resolution.review_note_id)
    if (!current || resolution.event_sequence > current.event_sequence) latest.set(resolution.review_note_id, resolution)
  }
  return project.review_notes.map(note => {
    const resolution = latest.get(note.id)
    if (!resolution) return note
    return {
      ...note,
      status: resolution.state,
      ...(resolution.resolution_proposal_id ? { resolution_proposal_id: resolution.resolution_proposal_id } : {}),
      ...(resolution.resolved_by_timeline_version_id ? { resolved_by_timeline_version_id: resolution.resolved_by_timeline_version_id } : {}),
      ...(resolution.resolved_by_variant_version_id ? { resolved_by_variant_version_id: resolution.resolved_by_variant_version_id } : {}),
      resolved_at: resolution.created_at,
    }
  })
}

/** One monotonically ordered local review stream covers notes, resolutions and approvals. */
export function nextVideoReviewEventSequence(project: VideoStudioProject): number {
  return Math.max(
    0,
    ...project.review_notes.map(note => note.event_sequence),
    ...project.review_resolutions.map(resolution => resolution.event_sequence),
    ...project.approval_decisions.map(decision => decision.event_sequence),
  ) + 1
}
