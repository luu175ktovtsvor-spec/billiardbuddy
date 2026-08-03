import { createHash } from 'node:crypto'
import {
  compareRationalTime,
  endOfRange,
  parseInt64,
  rationalTime,
  sourceTimeRange,
  type SourceTimeRange,
} from './time.js'
import type { ContentSegment, EvidenceWindow, TimedTranscript, VideoFactSource } from './model.js'

type Identifiers = {
  next: (prefix: 'segment' | 'window') => string
}

export type EvidenceWindowBudget = {
  maxWindows: number
  maxCoveredTicks: bigint
}

function assertReadySource(source: VideoFactSource): asserts source is VideoFactSource & { fingerprint: `sha256:${string}` } {
  if (source.fingerprint_state !== 'ready' || !source.fingerprint) throw new Error('完整素材指纹尚未就绪')
}

function stableIdentifier(prefix: 'segment' | 'window', seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

function defaultIdentifiers(source: VideoFactSource): Identifiers {
  let sequence = 0
  return { next: prefix => stableIdentifier(prefix, `${source.id}:${prefix}:${sequence++}`) }
}

/**
 * Fixed intervals are semantic fallback units only. They never invent a
 * CameraShot boundary, which must originate from a cut detector or a user.
 */
export function fixedIntervalContentSegments(input: {
  source: VideoFactSource
  intervalSeconds?: number
  ids?: Identifiers
  createdAt: string
}): ContentSegment[] {
  assertReadySource(input.source)
  const intervalSeconds = input.intervalSeconds ?? 30
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0) throw new Error('固定分段间隔无效')
  const ids = input.ids ?? defaultIdentifiers(input.source)
  const rate = input.source.presentation_duration.tick_rate
  const start = input.source.primary_video_stream.start_time
  const duration = input.source.presentation_duration
  const end = endOfRange(sourceTimeRange(start, duration))
  const step = BigInt(intervalSeconds) * BigInt(rate.num) / BigInt(rate.den)
  if (step <= 0n) throw new Error('固定分段间隔无法表示为素材时间')
  const segments: ContentSegment[] = []
  let cursor = parseInt64(start.ticks)
  const endTicks = parseInt64(end.ticks)
  while (cursor < endTicks) {
    const next = cursor + step > endTicks ? endTicks : cursor + step
    segments.push({
      id: ids.next('segment'),
      project_id: input.source.project_id,
      source_id: input.source.id,
      source_fingerprint: input.source.fingerprint,
      range: sourceTimeRange(rationalTime(cursor, rate), rationalTime(next - cursor, rate)),
      camera_shot_ids: [],
      segmentation_source: 'fixed_interval_fallback',
      created_at: input.createdAt,
    })
    cursor = next
  }
  return segments
}

function transcriptIdsWithin(transcript: TimedTranscript | undefined, range: SourceTimeRange): string[] {
  if (!transcript) return []
  return transcript.segments
    .filter(segment => compareRationalTime(segment.start, endOfRange(range)) < 0 && compareRationalTime(range.start, endOfRange({ start: segment.start, duration: segment.duration })) < 0)
    .map(segment => segment.id)
}

/**
 * Evidence windows are the only visual-model input unit. The range is kept
 * whole and the strategy describes sampling, so a long shot is never reduced
 * to one unlabelled centre frame.
 */
export function planEvidenceWindows(input: {
  source: VideoFactSource
  segments: ContentSegment[]
  transcript?: TimedTranscript
  keyframeDerivativeIds?: string[]
  proxyDerivativeId?: string
  analysisDepth: EvidenceWindow['analysis_depth']
  samplingReceiptId: string
  createdAt: string
  budget: EvidenceWindowBudget
  ids?: Identifiers
}): { windows: EvidenceWindow[]; uncovered: SourceTimeRange[] } {
  assertReadySource(input.source)
  const ids = input.ids ?? defaultIdentifiers(input.source)
  const candidates = input.segments.filter(segment => segment.source_id === input.source.id && segment.source_fingerprint === input.source.fingerprint)
  const windows: EvidenceWindow[] = []
  const uncovered: SourceTimeRange[] = []
  let covered = 0n
  for (const segment of candidates) {
    const duration = parseInt64(segment.range.duration.ticks)
    if (windows.length >= input.budget.maxWindows || covered + duration > input.budget.maxCoveredTicks) {
      uncovered.push(segment.range)
      continue
    }
    const transcriptSegmentIds = transcriptIdsWithin(input.transcript, segment.range)
    const short = duration * BigInt(segment.range.duration.tick_rate.den) <= BigInt(segment.range.duration.tick_rate.num) * 8n
    const strategy: EvidenceWindow['sample_strategy'] = transcriptSegmentIds.length > 0 && !short
      ? 'transcript_signal'
      : short && input.proxyDerivativeId
        ? 'short_proxy'
        : short
          ? 'representative_frame'
          : 'start_middle_end'
    windows.push({
      id: ids.next('window'),
      project_id: input.source.project_id,
      source_id: input.source.id,
      source_fingerprint: input.source.fingerprint,
      content_segment_id: segment.id,
      range: segment.range,
      sample_strategy: strategy,
      keyframe_derivative_ids: input.keyframeDerivativeIds ?? [],
      ...(strategy === 'short_proxy' ? { proxy_derivative_id: input.proxyDerivativeId } : {}),
      transcript_segment_ids: transcriptSegmentIds,
      evidence_ids: [],
      analysis_depth: input.analysisDepth,
      sampling_receipt_id: input.samplingReceiptId,
      created_at: input.createdAt,
    })
    covered += duration
  }
  return { windows, uncovered }
}

/** Safe construction helper for one existing source range; no milliseconds are accepted. */
export function sourceRangeForSegment(range: SourceTimeRange, source: VideoFactSource): SourceTimeRange {
  assertReadySource(source)
  const presentation = sourceTimeRange(source.primary_video_stream.start_time, source.presentation_duration)
  if (
    compareRationalTime(range.start, presentation.start) < 0
    || compareRationalTime(endOfRange(range), endOfRange(presentation)) > 0
  ) {
    throw new Error('事实范围超出原始素材 PTS')
  }
  return range
}
