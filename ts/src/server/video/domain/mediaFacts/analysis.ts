import { createHash } from 'node:crypto'
import {
  compareRationalTime,
  endOfRange,
  parseInt64,
  rationalTime,
  sourceTimeRange,
  type SourceTimeRange,
} from './time.js'
import type { CameraShot, ContentSegment, EvidenceWindow, TimedTranscript, VideoFactSource } from './model.js'

type Identifiers = {
  next: (prefix: 'segment' | 'window') => string
}

export type EvidenceWindowBudget = {
  maxWindows: number
  maxVisualRequests: number
  maxFrames: number
  maxProxySeconds: number
  maxInputTokens: number
  /** Source-tick budget. Omit to use the source-timebase-aware default. */
  maxCoveredTicks?: bigint
  /** The current visual gateway contract accepts at most this many images. */
  maxFramesPerVisualRequest: number
}

export const DEFAULT_EVIDENCE_WINDOW_MAX_COVERAGE_SECONDS = 600

export const DEFAULT_EVIDENCE_WINDOW_BUDGET: EvidenceWindowBudget = {
  maxWindows: 24,
  maxVisualRequests: 12,
  maxFrames: 72,
  maxProxySeconds: 120,
  maxInputTokens: 48_000,
  maxFramesPerVisualRequest: 8,
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
      source_fingerprint: input.source.fingerprint!,
      range: sourceTimeRange(rationalTime(cursor, rate), rationalTime(next - cursor, rate)),
      camera_shot_ids: [],
      segmentation_source: 'fixed_interval_fallback',
      created_at: input.createdAt,
    })
    cursor = next
  }
  return segments
}

/** A scene detector creates real Camera Shots; their ranges become semantic Content Segments. */
export function contentSegmentsFromCameraShots(input: {
  source: VideoFactSource
  shots: CameraShot[]
  ids?: Identifiers
  createdAt: string
}): ContentSegment[] {
  assertReadySource(input.source)
  const ids = input.ids ?? defaultIdentifiers(input.source)
  return input.shots
    .filter(shot => shot.project_id === input.source.project_id
      && shot.source_id === input.source.id
      && shot.source_fingerprint === input.source.fingerprint)
    .sort((left, right) => compareRationalTime(left.range.start, right.range.start))
    .map(shot => ({
      id: ids.next('segment'),
      project_id: input.source.project_id,
      source_id: input.source.id,
      source_fingerprint: input.source.fingerprint!,
      range: shot.range,
      camera_shot_ids: [shot.id],
      segmentation_source: 'motion_change' as const,
      created_at: input.createdAt,
    }))
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
  generation?: number
  ids?: Identifiers
}): { windows: EvidenceWindow[]; uncovered: EvidenceWindow['coverage']['uncovered']; coverage: EvidenceWindow['coverage'] } {
  assertReadySource(input.source)
  const maxCoveredTicks = input.budget.maxCoveredTicks
    ?? BigInt(DEFAULT_EVIDENCE_WINDOW_MAX_COVERAGE_SECONDS)
      * BigInt(input.source.primary_video_stream.start_time.tick_rate.num)
      / BigInt(input.source.primary_video_stream.start_time.tick_rate.den)
  if (
    !Number.isSafeInteger(input.budget.maxWindows) || input.budget.maxWindows < 1
    || !Number.isSafeInteger(input.budget.maxVisualRequests) || input.budget.maxVisualRequests < 1
    || !Number.isSafeInteger(input.budget.maxFrames) || input.budget.maxFrames < 1
    || !Number.isSafeInteger(input.budget.maxProxySeconds) || input.budget.maxProxySeconds < 0
    || !Number.isSafeInteger(input.budget.maxInputTokens) || input.budget.maxInputTokens < 1
    || !Number.isSafeInteger(input.budget.maxFramesPerVisualRequest) || input.budget.maxFramesPerVisualRequest < 1
    || maxCoveredTicks < 0n
  ) throw new Error('Evidence Window 请求预算无效')
  const ids = input.ids ?? defaultIdentifiers(input.source)
  const candidates = input.segments.filter(segment => segment.source_id === input.source.id && segment.source_fingerprint === input.source.fingerprint)
  const drafts: Array<Omit<EvidenceWindow, 'coverage'>> = []
  const uncovered: EvidenceWindow['coverage']['uncovered'] = []
  let covered = 0n
  let frames = 0
  let proxySeconds = 0
  let proxyRequests = 0
  let estimatedInputTokens = 0
  for (const segment of candidates) {
    const duration = parseInt64(segment.range.duration.ticks)
    const transcriptSegmentIds = transcriptIdsWithin(input.transcript, segment.range)
    const short = duration * BigInt(segment.range.duration.tick_rate.den) <= BigInt(segment.range.duration.tick_rate.num) * 8n
    const strategy: EvidenceWindow['sample_strategy'] = transcriptSegmentIds.length > 0 && !short
      ? 'transcript_signal'
      : short && input.proxyDerivativeId
        ? 'short_proxy'
        : short
          ? 'representative_frame'
          : 'start_middle_end'
    const candidateFrames = strategy === 'representative_frame' ? 1 : strategy === 'short_proxy' ? 0 : 3
    const candidateProxySeconds = strategy === 'short_proxy'
      ? Math.max(1, Math.ceil(Number(duration * BigInt(segment.range.duration.tick_rate.den)) / Number(BigInt(segment.range.duration.tick_rate.num))))
      : 0
    const candidateTokens = candidateFrames * 550 + candidateProxySeconds * 900
    const nextVisualRequests = Math.ceil((frames + candidateFrames) / input.budget.maxFramesPerVisualRequest)
      + proxyRequests + (candidateProxySeconds > 0 ? 1 : 0)
    const reason = drafts.length >= input.budget.maxWindows
      ? 'max_windows'
      : covered + duration > maxCoveredTicks
        ? 'max_covered_ticks'
        : frames + candidateFrames > input.budget.maxFrames
          ? 'max_frames'
          : proxySeconds + candidateProxySeconds > input.budget.maxProxySeconds
            ? 'max_proxy_seconds'
            : estimatedInputTokens + candidateTokens > input.budget.maxInputTokens
              ? 'max_input_tokens'
              : nextVisualRequests > input.budget.maxVisualRequests
                ? 'max_visual_requests'
                : null
    if (reason) {
      uncovered.push({ range: segment.range, reason })
      continue
    }
    drafts.push({
      id: ids.next('window'),
      project_id: input.source.project_id,
      source_id: input.source.id,
      source_fingerprint: input.source.fingerprint,
      ...(segment.camera_shot_ids.length === 1 ? { camera_shot_id: segment.camera_shot_ids[0] } : {}),
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
    frames += candidateFrames
    proxySeconds += candidateProxySeconds
    proxyRequests += candidateProxySeconds > 0 ? 1 : 0
    estimatedInputTokens += candidateTokens
  }
  const coverage: EvidenceWindow['coverage'] = {
    generation: input.generation ?? 1,
    request_budget: {
      max_windows: input.budget.maxWindows,
      max_visual_requests: input.budget.maxVisualRequests,
      max_frames: input.budget.maxFrames,
      max_proxy_seconds: input.budget.maxProxySeconds,
      max_input_tokens: input.budget.maxInputTokens,
      max_covered_ticks: maxCoveredTicks.toString(),
    },
    request_usage: {
      windows: drafts.length,
      visual_requests: Math.ceil(frames / input.budget.maxFramesPerVisualRequest) + proxyRequests,
      frames,
      proxy_seconds: proxySeconds,
      estimated_input_tokens: estimatedInputTokens,
      covered_ticks: covered.toString(),
    },
    uncovered,
  }
  return { windows: drafts.map(window => ({ ...window, coverage })), uncovered, coverage }
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
