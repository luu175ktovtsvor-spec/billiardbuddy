import {
  compareRationalTime,
  endOfRange,
  rationalTime,
  rescaleRationalTime,
  sourceTimeRange,
  timeToMilliseconds,
  type RationalTime,
  type SourceTimeRange,
} from '../mediaFacts/time.js'

export const SUBJECT_TRACKER_VERSION = 'local-anchor-smoother-v1' as const

export type SubjectAnchor = {
  evidence_id: string
  range: SourceTimeRange
  confidence: number
  box: readonly [number, number, number, number]
}

export type SubjectTrackResult = {
  analyzer_version: typeof SUBJECT_TRACKER_VERSION
  anchor_evidence_ids: string[]
  points: Array<{
    at: RationalTime
    box: { x: number; y: number; width: number; height: number }
    confidence: number
    source: 'visual_anchor' | 'local_track'
  }>
  unresolved_ranges: Array<{
    range: SourceTimeRange
    reason: 'occluded' | 'left_frame' | 'ambiguous' | 'low_confidence'
  }>
  confidence: number
}

const MIN_CONFIDENCE = 0.65
const MAX_INTERPOLATION_GAP_MS = 500
const LEAVE_FRAME_GAP_MS = 2_000

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function boxFromTuple(tuple: readonly [number, number, number, number]): { x: number; y: number; width: number; height: number } | null {
  const [left, top, right, bottom] = tuple
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null
  const x = clamp(left)
  const y = clamp(top)
  const width = clamp(right) - x
  const height = clamp(bottom) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

function intersects(left: SourceTimeRange, right: SourceTimeRange): boolean {
  return compareRationalTime(left.start, endOfRange(right)) < 0 && compareRationalTime(right.start, endOfRange(left)) < 0
}

function contains(range: SourceTimeRange, at: RationalTime): boolean {
  return compareRationalTime(at, range.start) >= 0 && compareRationalTime(at, endOfRange(range)) <= 0
}

function durationBetween(start: RationalTime, end: RationalTime): number {
  return Math.max(0, timeToMilliseconds(end) - timeToMilliseconds(start))
}

function rangeBetween(start: RationalTime, end: RationalTime): SourceTimeRange | null {
  const duration = durationBetween(start, end)
  if (duration <= 0) return null
  const rate = start.tick_rate
  const endAtRate = rescaleRationalTime(end, rate, 'nearest')
  return sourceTimeRange(start, rationalTime(BigInt(endAtRate.ticks) - BigInt(start.ticks), rate))
}

function midpoint(left: RationalTime, right: RationalTime): RationalTime {
  const converted = rescaleRationalTime(right, left.tick_rate, 'nearest')
  return rationalTime((BigInt(left.ticks) + BigInt(converted.ticks)) / 2n, left.tick_rate)
}

function interpolateBox(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: clamp((left.x + right.x) / 2),
    y: clamp((left.y + right.y) / 2),
    width: clamp((left.width + right.width) / 2),
    height: clamp((left.height + right.height) / 2),
  }
}

/**
 * A conservative local smoother, deliberately not a VLM interpolation. It
 * creates a local midpoint only between nearby trusted anchors. Long gaps are
 * carried forward as unresolved ranges so composition keeps the source frame.
 */
export function trackSubject(
  sourceRange: SourceTimeRange,
  anchors: SubjectAnchor[],
): SubjectTrackResult {
  const unresolved: SubjectTrackResult['unresolved_ranges'] = []
  const usable = anchors.flatMap(anchor => {
    if (!intersects(sourceRange, anchor.range)) return []
    const box = boxFromTuple(anchor.box)
    if (!box || anchor.confidence < MIN_CONFIDENCE) return []
    const at = compareRationalTime(anchor.range.start, sourceRange.start) < 0 ? sourceRange.start : anchor.range.start
    return [{ ...anchor, at, box }]
  }).sort((left, right) => compareRationalTime(left.at, right.at))

  // Multiple visual facts may describe the same instant.  Keep exactly one
  // strongest anchor so an evidence batch cannot create a fictitious motion
  // segment at a zero-length timestamp.
  const unique: typeof usable = []
  for (const anchor of usable) {
    const prior = unique.at(-1)
    if (!prior || compareRationalTime(prior.at, anchor.at) !== 0) {
      unique.push(anchor)
    } else if (anchor.confidence > prior.confidence) {
      unique[unique.length - 1] = anchor
    }
  }
  if (!unique.length) {
    return {
      analyzer_version: SUBJECT_TRACKER_VERSION,
      anchor_evidence_ids: [],
      points: [],
      unresolved_ranges: [{ range: sourceRange, reason: 'low_confidence' }],
      confidence: 0,
    }
  }

  const points: SubjectTrackResult['points'] = unique.map(anchor => ({
    at: anchor.at,
    box: anchor.box,
    confidence: anchor.confidence,
    source: 'visual_anchor',
  }))
  for (let index = 1; index < unique.length; index += 1) {
    const previous = unique[index - 1]!
    const next = unique[index]!
    const gap = durationBetween(previous.at, next.at)
    if (gap <= MAX_INTERPOLATION_GAP_MS && gap > 40) {
      points.push({
        at: midpoint(previous.at, next.at),
        box: interpolateBox(previous.box, next.box),
        confidence: Math.min(previous.confidence, next.confidence) * 0.9,
        source: 'local_track',
      })
    } else if (gap > MAX_INTERPOLATION_GAP_MS) {
      const range = rangeBetween(previous.at, next.at)
      if (range) unresolved.push({ range, reason: gap > LEAVE_FRAME_GAP_MS ? 'left_frame' : 'low_confidence' })
    }
  }
  const first = unique[0]!
  const last = unique.at(-1)!
  if (durationBetween(sourceRange.start, first.at) > MAX_INTERPOLATION_GAP_MS) {
    const range = rangeBetween(sourceRange.start, first.at)
    if (range) unresolved.push({ range, reason: 'low_confidence' })
  }
  const sourceEnd = endOfRange(sourceRange)
  if (durationBetween(last.at, sourceEnd) > MAX_INTERPOLATION_GAP_MS) {
    const range = rangeBetween(last.at, sourceEnd)
    if (range) unresolved.push({ range, reason: 'left_frame' })
  }
  const sortedPoints = points
    .filter(point => contains(sourceRange, point.at))
    .sort((left, right) => compareRationalTime(left.at, right.at))
  return {
    analyzer_version: SUBJECT_TRACKER_VERSION,
    anchor_evidence_ids: [...new Set(unique.map(anchor => anchor.evidence_id))],
    points: sortedPoints,
    unresolved_ranges: unresolved,
    confidence: sortedPoints.reduce((sum, point) => sum + point.confidence, 0) / sortedPoints.length,
  }
}
