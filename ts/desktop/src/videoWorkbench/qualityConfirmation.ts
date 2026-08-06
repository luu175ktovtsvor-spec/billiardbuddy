import type { PublicMediaTask, VideoQualityCheck } from '../../../shared/contracts/media.js'
import type { VideoWorkbenchSnapshot } from './contracts.js'

export type VideoPendingPostRenderQualityConfirmation = Readonly<{
  operation_id: string
  report_id: string
  output_content_hash: string
  accepted_check_ids: readonly string[]
  checks: readonly Pick<VideoQualityCheck, 'id' | 'code' | 'message' | 'severity'>[]
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function outputHash(value: unknown): string | undefined {
  const candidate = text(value)
  return candidate && /^sha256:[a-f0-9]{64}$/.test(candidate) ? candidate : undefined
}

/**
 * Only a committing render operation that explicitly waits for acknowledgement
 * can be confirmed.  The exact warning ids come from the stored report rather
 * than from a caller-provided list, so a stale Renderer cannot acknowledge a
 * different output after a refresh.
 */
export function pendingPostRenderQualityConfirmation(
  snapshot: VideoWorkbenchSnapshot,
  operation: PublicMediaTask,
): VideoPendingPostRenderQualityConfirmation | undefined {
  if (
    operation.project_id !== snapshot.project.id
    || operation.kind !== 'video.render'
    || operation.status !== 'committing'
    || !isRecord(operation.result)
    || operation.result.awaiting_quality_confirmation !== true
  ) return undefined

  const reportId = text(operation.result.post_render_report_id)
  const contentHash = outputHash(operation.result.output_content_hash)
  if (!reportId || !contentHash) return undefined
  const report = snapshot.quality_reports.find(candidate => candidate.id === reportId)
  if (!report || report.kind !== 'post_render' || report.state !== 'needs_user_decision') return undefined
  const checks = report.checks
    .filter(check => check.state === 'needs_user_decision')
    .map(check => ({ id: check.id, code: check.code, message: check.message, severity: check.severity }))
    .sort((left, right) => left.id.localeCompare(right.id))
  if (!checks.length) return undefined
  return {
    operation_id: operation.id,
    report_id: report.id,
    output_content_hash: contentHash,
    accepted_check_ids: checks.map(check => check.id),
    checks,
  }
}

export function pendingPostRenderQualityConfirmations(
  snapshot: VideoWorkbenchSnapshot,
): readonly VideoPendingPostRenderQualityConfirmation[] {
  return snapshot.operations
    .flatMap(operation => {
      const pending = pendingPostRenderQualityConfirmation(snapshot, operation)
      return pending ? [pending] : []
    })
}
