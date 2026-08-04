import { createHash, randomUUID } from 'node:crypto'
import {
  videoAudioFinishingPlanSchema,
  videoCaptionDocumentRevisionSchema,
  videoCaptionDocumentSchema,
  videoCaptionStyleSchema,
  videoCompositionPlanSchema,
  videoQualityReportSchema,
  type DeliveryVariant,
  type DeliveryVariantVersion,
  type EditorialTimelineVersion,
  type VideoAudioFinishingPlan,
  type VideoCaptionCue,
  type VideoCaptionDocument,
  type VideoCaptionDocumentRevision,
  type VideoCaptionStyle,
  type VideoCompositionPlan,
  type VideoExecutionPlan,
  type VideoExportProfileRevision,
  type VideoQualityCheck,
  type VideoQualityReport,
  type VideoStudioProject,
} from '../../../../../shared/contracts/media.js'
import {
  addRationalTime,
  compareRationalTime,
  endOfRange,
  parseInt64,
  rationalTime,
  rescaleRationalTime,
  sourceTimeRange,
  type RationalTime,
  type SourceTimeRange,
} from '../mediaFacts/time.js'
import {
  factBasisHash,
  type TimedTranscript,
  type TranscriptRevision,
  type VideoFactEvidence,
} from '../mediaFacts/model.js'
import { materializeTranscriptRevision } from '../mediaFacts/transcript.js'

type CaptionDraftInput = {
  language: string
  style: Omit<VideoCaptionStyle, 'id' | 'created_at'>
}

type CaptionRevisionInput = {
  language?: string
  style_id?: string
  cues: Array<Omit<VideoCaptionCue, 'id'>>
}

export type CaptionDeliveryIssue = {
  code: 'caption_font' | 'caption_safe_area' | 'caption_glyph'
  message: string
}

/**
 * These families are part of the Relay image, not a best-effort libass
 * fallback. Adding a brand font requires installing it in the Relay image and
 * extending this allow-list in the same change.
 */
const SUPPORTED_CAPTION_FONT_FAMILIES = new Set([
  'Noto Sans CJK SC',
])

export type AudioMeasurement = {
  item_id: string
  audio_stream_index: number
  integrated_lufs?: number
  true_peak_db?: number
  silence_ratio?: number
  silence_ranges?: SourceTimeRange[]
  source_id: string
  source_range: SourceTimeRange
  receipt_id: string
}

/** Immutable Transcript anchors made available to the local audio planner.
 * A plan can describe a possible semantic cut, but never turns unanchored
 * silence or guessed speech into an automatic edit. */
export type AudioTranscriptAnchor = {
  transcript_id: string
  source_id: string
  source_range: SourceTimeRange
  transcript_anchor_ids: string[]
  text: string
}

type VolumeKeyframe = {
  at: RationalTime
  value: number
  interpolation: 'linear'
}

type PostRenderOutputInspection = NonNullable<VideoQualityReport['output_verification']> & {
  /** Present only after the full-output FFmpeg quality scans have completed. */
  black_duration_ms?: number
  black_ratio?: number
  silence_duration_ms?: number
  silence_ratio?: number
}

export class FinishingDeliveryValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'VIDEO_FINISHING_INVALID'
      | 'VIDEO_FINISHING_STALE'
      | 'VIDEO_FINISHING_UNAVAILABLE'
      | 'VIDEO_QUALITY_BLOCKED',
  ) {
    super(message)
    this.name = 'FinishingDeliveryValidationError'
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function timeRangeEndsAfter(left: { start: RationalTime; duration: RationalTime }, right: { start: RationalTime; duration: RationalTime }): boolean {
  return compareRationalTime(endOfRange(left), endOfRange(right)) > 0
}

function rangeContains(outer: { start: RationalTime; duration: RationalTime }, inner: { start: RationalTime; duration: RationalTime }): boolean {
  return compareRationalTime(inner.start, outer.start) >= 0 && !timeRangeEndsAfter(inner, outer)
}

function rangesIntersect(left: { start: RationalTime; duration: RationalTime }, right: { start: RationalTime; duration: RationalTime }): boolean {
  return compareRationalTime(left.start, endOfRange(right)) < 0 && compareRationalTime(right.start, endOfRange(left)) < 0
}

/**
 * Return the parts of `target` not covered by the evidence windows.  A
 * transform override has no range guard in the execution plan: its first/last
 * keyframe is held for the rest of the timeline item.  We therefore require
 * continuous source coverage before proposing one, instead of allowing a
 * sparse detection to quietly reframe an uncovered tail.
 */
function uncoveredSourceRanges(
  target: { start: RationalTime; duration: RationalTime },
  coverage: Array<{ start: RationalTime; duration: RationalTime }>,
): SourceTimeRange[] {
  const rate = target.start.tick_rate
  const targetStart = rescaleRationalTime(target.start, rate, 'nearest')
  const targetEnd = rescaleRationalTime(endOfRange(target), rate, 'nearest')
  const ranges = coverage.flatMap(range => {
    if (!rangesIntersect(target, range)) return []
    const start = rescaleRationalTime(laterTime(target.start, range.start), rate, 'nearest')
    const end = rescaleRationalTime(earlierTime(endOfRange(target), endOfRange(range)), rate, 'nearest')
    return compareRationalTime(start, end) < 0 ? [{ start, end }] : []
  }).sort((left, right) => compareRationalTime(left.start, right.start))
  const uncovered: SourceTimeRange[] = []
  let cursor = targetStart
  for (const range of ranges) {
    if (compareRationalTime(range.start, cursor) > 0) {
      uncovered.push(sourceTimeRange(cursor, rationalTime(
        parseInt64(range.start.ticks) - parseInt64(cursor.ticks),
        rate,
      )))
    }
    if (compareRationalTime(range.end, cursor) > 0) cursor = range.end
  }
  if (compareRationalTime(cursor, targetEnd) < 0) {
    uncovered.push(sourceTimeRange(cursor, rationalTime(
      parseInt64(targetEnd.ticks) - parseInt64(cursor.ticks),
      rate,
    )))
  }
  return uncovered
}

function laterTime(left: RationalTime, right: RationalTime): RationalTime {
  return compareRationalTime(left, right) >= 0 ? clone(left) : clone(right)
}

function earlierTime(left: RationalTime, right: RationalTime): RationalTime {
  return compareRationalTime(left, right) <= 0 ? clone(left) : clone(right)
}

function addMilliseconds(value: RationalTime, milliseconds: number): RationalTime {
  const delta = rescaleRationalTime(rationalTime(String(milliseconds), { num: 1_000, den: 1 }), value.tick_rate, 'nearest')
  return addRationalTime(value, delta, 'nearest')
}

function clampTime(value: RationalTime, range: { start: RationalTime; duration: RationalTime }): RationalTime {
  return earlierTime(laterTime(value, range.start), endOfRange(range))
}

function rangeMilliseconds(range: { duration: RationalTime }): number {
  const milliseconds = parseInt64(rescaleRationalTime(range.duration, { num: 1_000, den: 1 }, 'nearest').ticks)
  return milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(milliseconds)
}

function stableVolumeKeyframes(keyframes: VolumeKeyframe[]): VolumeKeyframe[] {
  const byAt = new Map<string, VolumeKeyframe>()
  for (const keyframe of keyframes) {
    const key = `${keyframe.at.tick_rate.num}/${keyframe.at.tick_rate.den}:${keyframe.at.ticks}`
    const current = byAt.get(key)
    // At a shared boundary, speech still wins over a neighbouring release so
    // adjacent/overlapping Transcript anchors cannot create an audible jump.
    if (!current || keyframe.value < current.value) {
      byAt.set(key, { at: clone(keyframe.at), value: keyframe.value, interpolation: 'linear' })
    }
  }
  return [...byAt.values()].sort((left, right) => compareRationalTime(left.at, right.at))
}

function looksLikeFiller(text: string): boolean {
  return /(?:^|[\s,，。！？!])(?:嗯+|呃+|额+|啊+|那个|就是|然后|uh+|um+)(?=$|[\s,，。！？!])/iu.test(text.trim())
}

function timelineRangeForSourceRange(
  sourceRange: SourceTimeRange,
  item: EditorialTimelineVersion['items'][number],
): VideoCaptionCue['timeline_range'] | null {
  if (item.binding.kind !== 'source' || !rangeContains(item.binding.source_range, sourceRange)) return null
  const timelineRate = item.timeline_range.start.tick_rate
  const itemSourceStart = rescaleRationalTime(item.binding.source_range.start, timelineRate, 'nearest')
  const sourceStart = rescaleRationalTime(sourceRange.start, timelineRate, 'nearest')
  const sourceDuration = rescaleRationalTime(sourceRange.duration, timelineRate, 'nearest')
  const speed = item.speed ?? { num: 1, den: 1 }
  const offset = (parseInt64(sourceStart.ticks) - parseInt64(itemSourceStart.ticks)) * BigInt(speed.den) / BigInt(speed.num)
  const duration = parseInt64(sourceDuration.ticks) * BigInt(speed.den) / BigInt(speed.num)
  if (duration <= 0n) return null
  return {
    start: addRationalTime(item.timeline_range.start, rationalTime(offset, timelineRate), 'nearest'),
    duration: rationalTime(duration, timelineRate),
  }
}

function projectDuration(timeline: EditorialTimelineVersion): RationalTime | null {
  const primaryTrackIds = new Set(timeline.tracks.filter(track => track.kind === 'primary_video' && !track.muted).map(track => track.id))
  const videoItems = timeline.items.filter(item => item.kind === 'video' && primaryTrackIds.has(item.track_id))
  if (!videoItems.length) return null
  return videoItems.reduce((latest, item) => compareRationalTime(endOfRange(item.timeline_range), latest) > 0 ? endOfRange(item.timeline_range) : latest, rationalTime('0', timeline.tick_rate))
}

function qualityState(checks: VideoQualityCheck[]): VideoQualityReport['state'] {
  if (checks.some(check => check.state === 'blocked')) return 'blocked'
  if (checks.some(check => check.state === 'needs_user_decision')) return 'needs_user_decision'
  return 'passed'
}

function expectedAudibleAudio(
  project: VideoStudioProject,
  version: DeliveryVariantVersion,
  timeline: EditorialTimelineVersion,
  profile: VideoExportProfileRevision,
  executionPlanId: string,
  outputExecutionPlanId: string | undefined,
): { valid: boolean; expected: boolean } {
  const plan = project.execution_plans.find(candidate => candidate.id === executionPlanId)
  if (!plan
    || outputExecutionPlanId !== executionPlanId
    || plan.editorial_timeline_version_id !== timeline.id
    || plan.delivery_variant_version_id !== version.id
    || plan.encoder.id !== profile.id
    || plan.encoder.content_hash !== profile.content_hash
    || plan.audio_pipeline.policy !== profile.audio_policy) {
    return { valid: false, expected: false }
  }
  const audioTrackIds = new Set(plan.maps.filter(map => map.output === 'audio').map(map => map.track_id))
  const selectedTrackKinds = plan.audio_pipeline.policy === 'source_only'
    ? new Set<VideoExecutionPlan['timeline_items'][number]['track_kind']>(['source_audio'])
    : plan.audio_pipeline.policy === 'music_only'
      ? new Set<VideoExecutionPlan['timeline_items'][number]['track_kind']>(['music'])
      : new Set<VideoExecutionPlan['timeline_items'][number]['track_kind']>(['source_audio', 'music'])
  return {
    valid: true,
    // Timeline items and maps are emitted only from unmuted tracks. The
    // renderer then applies the frozen audio policy, so this is the exact
    // definition of whether audible program material was requested.
    expected: plan.timeline_items.some(item => item.kind === 'audio'
      && selectedTrackKinds.has(item.track_kind)
      && audioTrackIds.has(item.track_id)),
  }
}

function qualityCheck(
  code: string,
  state: VideoQualityCheck['state'],
  severity: VideoQualityCheck['severity'],
  message: string,
  extra: Pick<VideoQualityCheck, 'item_id' | 'range'> = {},
): VideoQualityCheck {
  return { id: id('quality_check'), code, state, severity, message, ...extra }
}

function sourceAspect(project: VideoStudioProject, sourceId: string): number | null {
  const source = project.sources.find(candidate => candidate.id === sourceId)
  if (!source || source.width <= 0 || source.height <= 0) return null
  const rotation = ((source.rotation % 360) + 360) % 360
  return rotation === 90 || rotation === 270
    ? source.height / source.width
    : source.width / source.height
}

function sourceTimeWithin(range: { start: RationalTime; duration: RationalTime }, at: RationalTime): boolean {
  return compareRationalTime(at, range.start) >= 0
    && compareRationalTime(at, addRationalTime(range.start, range.duration, 'nearest')) <= 0
}

function timelineTimeForSourceTime(
  sourceTime: RationalTime,
  item: EditorialTimelineVersion['items'][number],
): RationalTime | null {
  if (item.binding.kind !== 'source' || !sourceTimeWithin(item.binding.source_range, sourceTime)) return null
  const rate = item.timeline_range.start.tick_rate
  const sourceAtRate = rescaleRationalTime(sourceTime, rate, 'nearest')
  const itemSourceStart = rescaleRationalTime(item.binding.source_range.start, rate, 'nearest')
  const speed = item.speed ?? { num: 1, den: 1 }
  const sourceOffset = parseInt64(sourceAtRate.ticks) - parseInt64(itemSourceStart.ticks)
  const timelineOffset = sourceOffset * BigInt(speed.den) / BigInt(speed.num)
  const projected = addRationalTime(item.timeline_range.start, rationalTime(timelineOffset, rate), 'nearest')
  return compareRationalTime(projected, endOfRange(item.timeline_range)) <= 0 ? projected : null
}

function transformForSubjectBox(
  box: readonly [number, number, number, number],
  needsReframe: boolean,
): { x: number; y: number; scale: number; rotation: number; opacity: number } | null {
  const [left, top, right, bottom] = box
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null
  // Keep a modest edge margin.  The actual crop has the target aspect ratio;
  // the keyframe only decides its safe focal point and never fabricates a
  // rotation or opacity effect that the compiler cannot faithfully render.
  const centerX = Math.max(-0.84, Math.min(0.84, ((left + right) / 2 - 0.5) * 2))
  const centerY = Math.max(-0.84, Math.min(0.84, ((top + bottom) / 2 - 0.5) * 2))
  return { x: centerX, y: centerY, scale: needsReframe ? 1.06 : 1, rotation: 0, opacity: 1 }
}

function defaultCaptionStyle(input: CaptionDraftInput['style'], now: string): VideoCaptionStyle {
  return videoCaptionStyleSchema.parse({ id: id('caption_style'), ...input, created_at: now })
}

function normalizedFontFamily(fontFamily: string): string {
  return fontFamily.trim().replace(/\s+/g, ' ')
}

function hasUnsupportedCaptionGlyph(text: string, fontFamily: string): boolean {
  const supported = fontFamily === 'Noto Sans CJK SC'
    ? /^[\p{Script=Han}\p{Script=Latin}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}]$/u
    : /^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}]$/u
  return [...text].some(character => character !== '\n'
    && character !== '\t'
    && (/\p{C}/u.test(character) || /\p{Extended_Pictographic}/u.test(character) || !supported.test(character)))
}

/**
 * Keep presentation validation deterministic. The renderer repeats this
 * check before it writes a sidecar or asks FFmpeg to burn captions in, so an
 * old or hand-crafted ExecutionPlan cannot bypass preflight.
 */
export function inspectCaptionDelivery(
  style: VideoCaptionStyle,
  cues: readonly VideoCaptionCue[],
  target: { width: number; height: number },
): CaptionDeliveryIssue[] {
  const issues: CaptionDeliveryIssue[] = []
  const fontFamily = normalizedFontFamily(style.font_family)
  if (!SUPPORTED_CAPTION_FONT_FAMILIES.has(fontFamily)) {
    issues.push({
      code: 'caption_font',
      message: `字幕字体“${fontFamily}”不在 Video Relay 已安装的受控字体清单中。`,
    })
  }
  const lineHeight = style.font_size * 1.35 + style.outline_width * 2
  const sideMargin = target.width * (1 - style.max_width) / 2
  const minimumBottomSafeArea = Math.max(0.04, lineHeight / target.height * 0.25)
  if (style.font_size < 12
    || style.font_size > target.height * 0.25
    || style.max_width > 0.95
    || style.max_width < 0.25
    || target.width * style.max_width < style.font_size * 2 + style.outline_width * 4
    || sideMargin < Math.max(16, style.outline_width * 2)
    || style.bottom_safe_area < minimumBottomSafeArea
    || style.bottom_safe_area + lineHeight / target.height > 0.9) {
    issues.push({
      code: 'caption_safe_area',
      message: '字幕字号、最大宽度或底部安全区不能在当前输出画幅内形成可读且不越界的布局。',
    })
  }
  if (SUPPORTED_CAPTION_FONT_FAMILIES.has(fontFamily) && cues.some(cue => hasUnsupportedCaptionGlyph(cue.text, fontFamily))) {
    issues.push({
      code: 'caption_glyph',
      message: '字幕文本包含当前 Relay 受控字体未覆盖或不可接受的字形。',
    })
  }
  return issues
}

function sameAnchor(
  left: VideoCaptionCue['source_anchor'],
  right: VideoCaptionCue['source_anchor'],
): boolean {
  const sorted = (values: readonly string[]) => [...values].sort()
  return left.transcript_id === right.transcript_id
    && JSON.stringify(sorted(left.segment_ids)) === JSON.stringify(sorted(right.segment_ids))
    && JSON.stringify(sorted(left.word_ids)) === JSON.stringify(sorted(right.word_ids))
}

type ResolvedCaptionAnchor = {
  anchor: VideoCaptionCue['source_anchor']
  source_range: SourceTimeRange
  alignment_confidence: number
  alignment_state: VideoCaptionCue['alignment_state']
}

function assertUniqueAndConsecutive(indices: number[], label: string): void {
  if (!indices.length || indices.some(index => index < 0) || new Set(indices).size !== indices.length) {
    throw new FinishingDeliveryValidationError(`字幕 Cue 的${label}不能重复或为空`, 'VIDEO_FINISHING_INVALID')
  }
  const sorted = [...indices].sort((left, right) => left - right)
  if (sorted.some((value, index) => index > 0 && value !== sorted[index - 1]! + 1)) {
    throw new FinishingDeliveryValidationError(`字幕 Cue 的${label}必须在原始转写中连续，不能跨越未锚定内容`, 'VIDEO_FINISHING_INVALID')
  }
}

function sourceRangeFromAnchor(
  transcript: TimedTranscript,
  requested: VideoCaptionCue['source_anchor'],
): ResolvedCaptionAnchor {
  if (requested.transcript_id !== transcript.id) {
    throw new FinishingDeliveryValidationError('字幕 Cue 引用了不属于当前转写的时间锚点', 'VIDEO_FINISHING_INVALID')
  }
  const segments = transcript.segments
  const segmentIndexById = new Map(segments.map((segment, index) => [segment.id, index]))
  const segmentIndices = requested.segment_ids.map(segmentId => segmentIndexById.get(segmentId) ?? -1)
  assertUniqueAndConsecutive(segmentIndices, '片段锚点')
  const orderedSegmentIndices = [...segmentIndices].sort((left, right) => left - right)
  const orderedSegments = orderedSegmentIndices.map(index => segments[index]!)
  const words = segments.flatMap((segment, segmentIndex) => segment.words.map((word, wordIndex) => ({ word, segmentIndex, wordIndex })))
  const wordIndexById = new Map(words.map((entry, index) => [entry.word.id, index]))
  if (requested.word_ids.length) {
    const wordIndices = requested.word_ids.map(wordId => wordIndexById.get(wordId) ?? -1)
    assertUniqueAndConsecutive(wordIndices, '词锚点')
    const orderedWords = [...wordIndices].sort((left, right) => left - right).map(index => words[index]!)
    const selectedSegmentIndices = new Set(orderedSegmentIndices)
    if (orderedWords.some(entry => !selectedSegmentIndices.has(entry.segmentIndex))) {
      throw new FinishingDeliveryValidationError('字幕 Cue 的词锚点必须属于声明的转写片段', 'VIDEO_FINISHING_INVALID')
    }
    const wordSegmentIndices = [...new Set(orderedWords.map(entry => entry.segmentIndex))]
    if (wordSegmentIndices.length !== orderedSegmentIndices.length
      || wordSegmentIndices.some((value, index) => value !== orderedSegmentIndices[index])) {
      throw new FinishingDeliveryValidationError('字幕 Cue 的片段锚点必须与其词锚点精确对应', 'VIDEO_FINISHING_INVALID')
    }
    const first = orderedWords[0]!.word
    const last = orderedWords.at(-1)!.word
    const rate = first.start.tick_rate
    const end = addRationalTime(last.start, last.duration, 'nearest')
    const endAtRate = rescaleRationalTime(end, rate, 'nearest')
    const startAtRate = rescaleRationalTime(first.start, rate, 'nearest')
    const duration = parseInt64(endAtRate.ticks) - parseInt64(startAtRate.ticks)
    if (duration <= 0n) throw new FinishingDeliveryValidationError('字幕 Cue 的词锚点没有有效时长', 'VIDEO_FINISHING_INVALID')
    return {
      anchor: {
        transcript_id: transcript.id,
        segment_ids: orderedSegments.map(segment => segment.id),
        word_ids: orderedWords.map(entry => entry.word.id),
      },
      source_range: { start: startAtRate, duration: rationalTime(duration, rate) } as SourceTimeRange,
      alignment_confidence: 0.95,
      alignment_state: 'ready',
    }
  }
  const first = orderedSegments[0]!
  const last = orderedSegments.at(-1)!
  const rate = first.start.tick_rate
  const end = rescaleRationalTime(addRationalTime(last.start, last.duration, 'nearest'), rate, 'nearest')
  const start = rescaleRationalTime(first.start, rate, 'nearest')
  const duration = parseInt64(end.ticks) - parseInt64(start.ticks)
  if (duration <= 0n) throw new FinishingDeliveryValidationError('字幕 Cue 的片段锚点没有有效时长', 'VIDEO_FINISHING_INVALID')
  return {
    anchor: {
      transcript_id: transcript.id,
      segment_ids: orderedSegments.map(segment => segment.id),
      word_ids: [],
    },
    source_range: { start, duration: rationalTime(duration, rate) } as SourceTimeRange,
    alignment_confidence: 0.72,
    alignment_state: 'needs_calibration',
  }
}

function primaryVideoItemsForSource(
  timeline: EditorialTimelineVersion,
  sourceId: string,
): EditorialTimelineVersion['items'] {
  const primaryTrackIds = new Set(timeline.tracks.filter(track => track.kind === 'primary_video' && !track.muted).map(track => track.id))
  return timeline.items.filter(item => item.kind === 'video'
    && primaryTrackIds.has(item.track_id)
    && item.binding.kind === 'source'
    && item.binding.source_id === sourceId)
}

function timelineRangesForSourceRange(
  timeline: EditorialTimelineVersion,
  sourceId: string,
  sourceRange: SourceTimeRange,
): VideoCaptionCue['timeline_range'][] {
  return primaryVideoItemsForSource(timeline, sourceId)
    .flatMap(item => {
      const range = timelineRangeForSourceRange(sourceRange, item)
      return range ? [range] : []
    })
    .sort((left, right) => compareRationalTime(left.start, right.start))
}

function equalTimelineRange(
  left: VideoCaptionCue['timeline_range'],
  right: VideoCaptionCue['timeline_range'],
): boolean {
  const start = rescaleRationalTime(right.start, left.start.tick_rate, 'nearest')
  const duration = rescaleRationalTime(right.duration, left.duration.tick_rate, 'nearest')
  return left.start.ticks === start.ticks && left.duration.ticks === duration.ticks
}

export function assertCaptionCuesFitTimeline(cues: readonly VideoCaptionCue[], timeline: EditorialTimelineVersion): void {
  const duration = projectDuration(timeline)
  if (!duration) throw new FinishingDeliveryValidationError('编辑时间线没有可锚定字幕的主视频轨', 'VIDEO_FINISHING_UNAVAILABLE')
  const origin = rationalTime('0', timeline.tick_rate)
  const ordered = [...cues].sort((left, right) => compareRationalTime(left.timeline_range.start, right.timeline_range.start))
  for (const cue of ordered) {
    if (compareRationalTime(cue.timeline_range.start, origin) < 0
      || compareRationalTime(cue.timeline_range.duration, origin) <= 0
      || timeRangeEndsAfter(cue.timeline_range, { start: origin, duration })) {
      throw new FinishingDeliveryValidationError('字幕 Cue 超出编辑时间线范围', 'VIDEO_FINISHING_INVALID')
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (rangesIntersect(ordered[index - 1]!.timeline_range, ordered[index]!.timeline_range)) {
      throw new FinishingDeliveryValidationError('字幕 Cue 不能在同一交付时间线上重叠', 'VIDEO_FINISHING_INVALID')
    }
  }
}

/**
 * The finishing layer only creates immutable facts and proposed CommandSets.
 * It never changes a Timeline or Variant head itself; EditorialApplication is
 * still the single writer for variant versions.
 */
export class FinishingDeliveryApplication {
  constructor(private readonly now: () => Date) {}

  private iso(): string {
    return this.now().toISOString()
  }

  createCaptionDraft(
    project: VideoStudioProject,
    timeline: EditorialTimelineVersion,
    transcript: TimedTranscript,
    activeRevision: TranscriptRevision | undefined,
    input: CaptionDraftInput,
  ): { style: VideoCaptionStyle; document: VideoCaptionDocument; revision: VideoCaptionDocumentRevision } {
    if (transcript.project_id !== project.id) throw new FinishingDeliveryValidationError('转写不属于当前视频项目', 'VIDEO_FINISHING_INVALID')
    const now = this.iso()
    const style = defaultCaptionStyle(input.style, now)
    const documentId = id('caption_document')
    const revisionId = id('caption_revision')
    const projection = materializeTranscriptRevision(transcript, activeRevision)
    const cues: VideoCaptionCue[] = []
    for (const segment of projection.segments) {
      if (!segment.text.trim()) continue
      const anchor = sourceRangeFromAnchor(transcript, {
        transcript_id: transcript.id,
        segment_ids: segment.anchor_segment_ids,
        word_ids: segment.word_ids,
      })
      for (const timelineRange of timelineRangesForSourceRange(timeline, transcript.source_id, anchor.source_range)) {
        cues.push({
          id: id('caption_cue'),
          source_anchor: anchor.anchor,
          timeline_range: timelineRange,
          text: segment.text.trim(),
          alignment_confidence: anchor.alignment_confidence,
          alignment_state: anchor.alignment_state,
        })
      }
    }
    if (!cues.length) throw new FinishingDeliveryValidationError('当前转写没有可锚定到编辑时间线的字幕片段', 'VIDEO_FINISHING_UNAVAILABLE')
    assertCaptionCuesFitTimeline(cues, timeline)
    const basis = hash({ timeline: timeline.id, transcript: transcript.id, revision: activeRevision?.id ?? null, cues })
    const document = videoCaptionDocumentSchema.parse({ id: documentId, project_id: project.id, current_revision_id: revisionId, created_at: now })
    const revision = videoCaptionDocumentRevisionSchema.parse({
      id: revisionId,
      document_id: documentId,
      project_id: project.id,
      editorial_timeline_version_id: timeline.id,
      transcript_id: transcript.id,
      ...(activeRevision ? { transcript_revision_id: activeRevision.id } : {}),
      language: input.language,
      style_id: style.id,
      cues,
      basis_hash: basis,
      created_at: now,
    })
    return { style, document, revision }
  }

  createCaptionRevision(
    project: VideoStudioProject,
    document: VideoCaptionDocument,
    parent: VideoCaptionDocumentRevision,
    timeline: EditorialTimelineVersion,
    transcript: TimedTranscript,
    input: CaptionRevisionInput,
  ): VideoCaptionDocumentRevision {
    if (document.project_id !== project.id || parent.project_id !== project.id || parent.document_id !== document.id) {
      throw new FinishingDeliveryValidationError('字幕文档不属于当前视频项目', 'VIDEO_FINISHING_INVALID')
    }
    if (parent.editorial_timeline_version_id !== timeline.id) {
      throw new FinishingDeliveryValidationError('字幕修订必须基于相同的编辑时间线版本', 'VIDEO_FINISHING_STALE')
    }
    const styleId = input.style_id ?? parent.style_id
    if (!project.caption_styles.some(style => style.id === styleId)) {
      throw new FinishingDeliveryValidationError('字幕样式不存在', 'VIDEO_FINISHING_INVALID')
    }
    const parentCues = new Map(parent.cues.map(cue => [cue.id, cue]))
    const cues = input.cues.map(cue => {
      const sourceCue = cue.translation_of_cue_id ? parentCues.get(cue.translation_of_cue_id) : undefined
      if (cue.translation_of_cue_id && !sourceCue) {
        throw new FinishingDeliveryValidationError('翻译字幕必须引用同一文档中的父 Cue', 'VIDEO_FINISHING_INVALID')
      }
      if (sourceCue && !sameAnchor(cue.source_anchor, sourceCue.source_anchor)) {
        throw new FinishingDeliveryValidationError('翻译字幕必须保留父 Cue 的原始时间锚点', 'VIDEO_FINISHING_INVALID')
      }
      const anchor = sourceRangeFromAnchor(transcript, sourceCue?.source_anchor ?? cue.source_anchor)
      const projectedRanges = timelineRangesForSourceRange(timeline, transcript.source_id, anchor.source_range)
      const timelineRange = sourceCue
        ? projectedRanges.filter(range => equalTimelineRange(range, sourceCue.timeline_range))
        : projectedRanges
      if (timelineRange.length !== 1) {
        throw new FinishingDeliveryValidationError(sourceCue
          ? '翻译字幕的父 Cue 已不能唯一投影到当前编辑时间线'
          : '字幕 Cue 的时间锚点不能唯一投影到当前编辑时间线', 'VIDEO_FINISHING_UNAVAILABLE')
      }
      return {
        id: id('caption_cue'),
        source_anchor: anchor.anchor,
        timeline_range: timelineRange[0]!,
        text: cue.text.trim(),
        ...(cue.translation_of_cue_id ? { translation_of_cue_id: cue.translation_of_cue_id } : {}),
        alignment_confidence: anchor.alignment_confidence,
        alignment_state: anchor.alignment_state,
      }
    })
    assertCaptionCuesFitTimeline(cues, timeline)
    return videoCaptionDocumentRevisionSchema.parse({
      id: id('caption_revision'),
      document_id: document.id,
      project_id: project.id,
      parent_revision_id: parent.id,
      editorial_timeline_version_id: timeline.id,
      transcript_id: transcript.id,
      ...(parent.transcript_revision_id ? { transcript_revision_id: parent.transcript_revision_id } : {}),
      language: input.language ?? parent.language,
      style_id: styleId,
      cues,
      basis_hash: hash({ parent: parent.id, timeline: timeline.id, transcript: transcript.id, cues }),
      created_at: this.iso(),
    })
  }

  createCompositionPlan(
    project: VideoStudioProject,
    variant: DeliveryVariant,
    version: DeliveryVariantVersion,
    timeline: EditorialTimelineVersion,
    profile: VideoExportProfileRevision,
    evidence: VideoFactEvidence[],
  ): VideoCompositionPlan {
    if (variant.project_id !== project.id || version.variant_id !== variant.id || version.editorial_timeline_version_id !== timeline.id || version.export_profile_revision_id !== profile.id) {
      throw new FinishingDeliveryValidationError('构图计划的版本基准已变化', 'VIDEO_FINISHING_STALE')
    }
    const planId = id('composition_plan')
    const commands: VideoCompositionPlan['proposed_commands'] = [{ kind: 'set_composition_plan', composition_plan_id: planId }]
    const subjectEvidenceIds: string[] = []
    const unresolved: VideoCompositionPlan['unresolved_ranges'] = []
    for (const item of timeline.items.filter(candidate => candidate.kind === 'video' && candidate.binding.kind === 'source')) {
      const binding = item.binding
      if (binding.kind !== 'source') continue
      const track = timeline.tracks.find(candidate => candidate.id === item.track_id)
      if (!track) {
        unresolved.push({ item_id: item.id, range: clone(item.timeline_range), reason: '构图目标轨道不存在，已保留原构图。' })
        continue
      }
      if (item.locked || track.locked) {
        unresolved.push({
          item_id: item.id,
          range: clone(item.timeline_range),
          reason: item.locked ? '构图目标条目已锁定，已保留原构图。' : '构图目标轨道已锁定，已保留原构图。',
        })
        continue
      }
      const sourceAspectRatio = sourceAspect(project, binding.source_id)
      const targetAspectRatio = profile.width / profile.height
      const needsReframe = sourceAspectRatio !== null && Math.abs(sourceAspectRatio - targetAspectRatio) > 0.01
      const candidates: Array<{
        evidence_id: string
        at: RationalTime
        confidence: number
        box: [number, number, number, number]
      }> = []
      const coverage: SourceTimeRange[] = []
      const reportedUnresolved: Array<{ range: SourceTimeRange; reason: string }> = []
      for (const fact of evidence) {
        if (fact.source_id !== binding.source_id
          || fact.source_fingerprint !== binding.source_fingerprint
          || !rangesIntersect(fact.range, binding.source_range)) continue
        if (fact.kind === 'subject_track') {
          coverage.push(fact.range)
          for (const point of fact.payload.points) {
            if (!sourceTimeWithin(binding.source_range, point.at) || point.confidence < 0.65) continue
            candidates.push({
              evidence_id: fact.id,
              at: point.at,
              confidence: point.confidence,
              box: [point.box.x, point.box.y, point.box.x + point.box.width, point.box.y + point.box.height],
            })
          }
          for (const gap of fact.payload.unresolved_ranges) {
            if (!rangesIntersect(gap.range, binding.source_range)) continue
            reportedUnresolved.push({
              range: sourceTimeRange(gap.range.start, gap.range.duration),
              reason: `主体轨迹未解决：${gap.reason}`,
            })
          }
          continue
        }
        if (fact.kind !== 'object'
          || !fact.payload.subject_id
          || !fact.payload.normalized_box
          || (fact.confidence ?? 0) < 0.65) continue
        coverage.push(fact.range)
        const [left, top, right, bottom] = fact.payload.normalized_box
        const middle = addRationalTime(fact.range.start, rationalTime(parseInt64(fact.range.duration.ticks) / 2n, fact.range.duration.tick_rate), 'nearest')
        if (sourceTimeWithin(binding.source_range, middle)) {
          candidates.push({ evidence_id: fact.id, at: middle, confidence: fact.confidence ?? 0, box: [left, top, right, bottom] })
        }
      }
      // Keep the highest-confidence fact at a shared PTS.  This prevents a
      // batch with duplicate detector output from adding synthetic motion.
      const ordered = candidates
        .sort((left, right) => compareRationalTime(left.at, right.at) || right.confidence - left.confidence)
        .filter((candidate, index, list) => index === 0
          || compareRationalTime(candidate.at, list[index - 1]!.at) !== 0)
      if (!ordered.length) {
        unresolved.push({ item_id: item.id, range: clone(item.timeline_range), reason: '缺少可信主体证据，已保留原构图。' })
        continue
      }
      const uncovered = uncoveredSourceRanges(
        sourceTimeRange(binding.source_range.start, binding.source_range.duration),
        coverage,
      )
      if (reportedUnresolved.length || uncovered.length) {
        for (const gap of reportedUnresolved) {
          const projected = timelineRangeForSourceRange(gap.range, item)
          unresolved.push({
            item_id: item.id,
            range: projected ?? clone(item.timeline_range),
            reason: gap.reason,
          })
        }
        for (const gap of uncovered) {
          const projected = timelineRangeForSourceRange(gap, item)
          unresolved.push({
            item_id: item.id,
            range: projected ?? clone(item.timeline_range),
            reason: '主体事实覆盖不足，已保留原构图。',
          })
        }
        // ExecutionPlan transforms are item-wide.  Do not let their endpoint
        // hold values leak into the explicit unresolved ranges above.
        continue
      }
      const keyframes = ordered.flatMap(candidate => {
        const at = timelineTimeForSourceTime(candidate.at, item)
        const value = transformForSubjectBox(candidate.box, needsReframe)
        return at && value ? [{ at, value, interpolation: 'linear' as const }] : []
      })
      if (!keyframes.length) {
        unresolved.push({ item_id: item.id, range: clone(item.timeline_range), reason: '主体证据不能投影到当前时间线，已保留原构图。' })
        continue
      }
      subjectEvidenceIds.push(...ordered.map(candidate => candidate.evidence_id))
      commands.push({ kind: 'set_transform_keyframes', item_id: item.id, keyframes })
    }
    return videoCompositionPlanSchema.parse({
      id: planId,
      project_id: project.id,
      editorial_timeline_version_id: timeline.id,
      export_profile_revision_id: profile.id,
      export_profile_hash: profile.content_hash,
      facts_basis_hash: factBasisHash({ timeline: timeline.id, evidence: [...new Set(subjectEvidenceIds)].sort() }),
      subject_evidence_ids: [...new Set(subjectEvidenceIds)],
      proposed_commands: commands,
      unresolved_ranges: unresolved,
      created_at: this.iso(),
    })
  }

  createAudioFinishingPlan(
    project: VideoStudioProject,
    variant: DeliveryVariant,
    version: DeliveryVariantVersion,
    timeline: EditorialTimelineVersion,
    measurements: AudioMeasurement[],
    transcriptAnchors: AudioTranscriptAnchor[] = [],
  ): VideoAudioFinishingPlan {
    if (variant.project_id !== project.id || version.variant_id !== variant.id || version.editorial_timeline_version_id !== timeline.id) {
      throw new FinishingDeliveryValidationError('音频完成计划的版本基准已变化', 'VIDEO_FINISHING_STALE')
    }
    const profile = project.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)
    if (!profile || version.export_profile_hash !== profile.content_hash) {
      throw new FinishingDeliveryValidationError('音频完成计划的导出规格已变化', 'VIDEO_FINISHING_STALE')
    }
    if (profile.audio_policy === 'music_only') {
      throw new FinishingDeliveryValidationError('当前导出规格不包含源声音轨，不能生成会被忽略的音频完成计划', 'VIDEO_FINISHING_UNAVAILABLE')
    }
    const planId = id('audio_plan')
    const commands: VideoAudioFinishingPlan['proposed_commands'] = [{ kind: 'set_audio_finishing_plan', audio_finishing_plan_id: planId }]
    const tracksById = new Map(timeline.tracks.map(track => [track.id, track]))
    const audioTargetLocked = (item: EditorialTimelineVersion['items'][number]): boolean => {
      const track = tracksById.get(item.track_id)
      return item.locked || !track || track.locked
    }
    for (const measurement of measurements) {
      const item = timeline.items.find(candidate => candidate.id === measurement.item_id)
      if (!item || item.kind !== 'audio' || audioTargetLocked(item)) continue
      // afftdn is intentionally capped at a modest value.  A plan is an
      // opt-in delivery projection, so this never alters an original source.
      commands.push({ kind: 'set_audio_denoise', item_id: item.id, noise_reduction_db: 6 })
      const loudness = measurement.integrated_lufs
      const peak = measurement.true_peak_db
      if (loudness === undefined && peak === undefined) continue
      let gain = 1
      if (loudness !== undefined) gain = Math.min(4, Math.max(0.1, 10 ** ((-16 - loudness) / 20)))
      if (peak !== undefined && peak + 20 * Math.log10(gain) > -1) gain = 10 ** ((-1 - peak) / 20)
      commands.push({
        kind: 'set_volume_keyframes',
        item_id: item.id,
        keyframes: [{ at: clone(item.timeline_range.start), value: gain, interpolation: 'linear' }],
      })
    }

    const semanticCutSuggestions: Array<{
      source_id: string
      range: SourceTimeRange
      kind: 'silence' | 'filler'
      transcript_anchor_ids: string[]
    }> = []
    const semanticCutNotRecommended: Array<{
      source_id: string
      range: SourceTimeRange
      kind: 'silence' | 'filler'
      reason: string
    }> = []
    const addSuggestion = (value: typeof semanticCutSuggestions[number]) => {
      const anchorIds = [...new Set(value.transcript_anchor_ids)].sort()
      if (!anchorIds.length) return
      const duplicate = semanticCutSuggestions.some(candidate => candidate.source_id === value.source_id
        && candidate.kind === value.kind
        && compareRationalTime(candidate.range.start, value.range.start) === 0
        && compareRationalTime(candidate.range.duration, value.range.duration) === 0)
      if (!duplicate) semanticCutSuggestions.push({ ...value, range: clone(value.range), transcript_anchor_ids: anchorIds })
    }
    const addNotRecommended = (value: typeof semanticCutNotRecommended[number]) => {
      const duplicate = semanticCutNotRecommended.some(candidate => candidate.source_id === value.source_id
        && candidate.kind === value.kind
        && compareRationalTime(candidate.range.start, value.range.start) === 0
        && compareRationalTime(candidate.range.duration, value.range.duration) === 0)
      if (!duplicate) semanticCutNotRecommended.push({ ...value, range: clone(value.range) })
    }
    for (const measurement of measurements) {
      const anchors = transcriptAnchors.filter(anchor => anchor.source_id === measurement.source_id
        && anchor.transcript_anchor_ids.length > 0)
      const quietRanges = (measurement.silence_ranges ?? []).filter(range => rangeMilliseconds(range) >= 500)
      for (const quietRange of quietRanges) {
        const matching = anchors.filter(anchor => rangesIntersect(anchor.source_range, quietRange))
        if (!matching.length) {
          addNotRecommended({
            source_id: measurement.source_id,
            range: quietRange,
            kind: 'silence',
            reason: '检测到静音，但没有重叠的不可变 Transcript 锚点，未建议语义剪辑。',
          })
          continue
        }
        addSuggestion({
          source_id: measurement.source_id,
          range: quietRange,
          kind: 'silence',
          transcript_anchor_ids: matching.flatMap(anchor => anchor.transcript_anchor_ids),
        })
      }
      if (!anchors.length && (quietRanges.length || (measurement.silence_ratio ?? 0) >= 0.2)) {
        addNotRecommended({
          source_id: measurement.source_id,
          range: measurement.source_range,
          kind: 'filler',
          reason: '没有可用的不可变 Transcript 锚点，未提供口头禅剪辑建议。',
        })
      }
      for (const anchor of anchors) {
        if (!looksLikeFiller(anchor.text)) continue
        addSuggestion({
          source_id: anchor.source_id,
          range: anchor.source_range,
          kind: 'filler',
          transcript_anchor_ids: anchor.transcript_anchor_ids,
        })
      }
    }

    const trackKinds = new Map(timeline.tracks.map(track => [track.id, track.kind]))
    const speechAnchors = transcriptAnchors.flatMap(anchor => timeline.items.flatMap(item => {
      if (item.kind !== 'audio' || trackKinds.get(item.track_id) !== 'source_audio' || item.binding.kind !== 'source'
        || item.binding.source_id !== anchor.source_id || audioTargetLocked(item)) return []
      const timelineRange = timelineRangeForSourceRange(anchor.source_range, item)
      return timelineRange ? [{ ...anchor, timeline_range: timelineRange }] : []
    }))
    const ducking: Array<{
      music_item_id: string
      speech_transcript_anchor_ids: string[]
      duck_gain: number
      attack_ms: number
      release_ms: number
    }> = []
    for (const musicItem of profile.audio_policy === 'music_with_source' ? timeline.items : []) {
      if (musicItem.kind !== 'audio' || trackKinds.get(musicItem.track_id) !== 'music' || audioTargetLocked(musicItem)) continue
      const overlappingSpeech = speechAnchors.filter(anchor => rangesIntersect(anchor.timeline_range, musicItem.timeline_range))
      if (!overlappingSpeech.length) continue
      const duckGain = 0.35
      const attackMs = 120
      const releaseMs = 180
      const keyframes: VolumeKeyframe[] = [{ at: clone(musicItem.timeline_range.start), value: 1, interpolation: 'linear' }]
      for (const anchor of overlappingSpeech) {
        const speechStart = laterTime(anchor.timeline_range.start, musicItem.timeline_range.start)
        const speechEnd = earlierTime(endOfRange(anchor.timeline_range), endOfRange(musicItem.timeline_range))
        if (compareRationalTime(speechEnd, speechStart) <= 0) continue
        keyframes.push(
          { at: clampTime(addMilliseconds(speechStart, -attackMs), musicItem.timeline_range), value: 1, interpolation: 'linear' },
          { at: speechStart, value: duckGain, interpolation: 'linear' },
          { at: speechEnd, value: duckGain, interpolation: 'linear' },
          { at: clampTime(addMilliseconds(speechEnd, releaseMs), musicItem.timeline_range), value: 1, interpolation: 'linear' },
        )
      }
      const frozenKeyframes = stableVolumeKeyframes(keyframes)
      if (frozenKeyframes.length < 2 || !frozenKeyframes.some(keyframe => keyframe.value < 1)) continue
      commands.push({ kind: 'set_volume_keyframes', item_id: musicItem.id, keyframes: frozenKeyframes })
      ducking.push({
        music_item_id: musicItem.id,
        speech_transcript_anchor_ids: [...new Set(overlappingSpeech.flatMap(anchor => anchor.transcript_anchor_ids))].sort(),
        duck_gain: duckGain,
        attack_ms: attackMs,
        release_ms: releaseMs,
      })
    }

    return videoAudioFinishingPlanSchema.parse({
      id: planId,
      project_id: project.id,
      editorial_timeline_version_id: timeline.id,
      analysis_receipt_ids: [...new Set(measurements.map(item => item.receipt_id))],
      measured_loudness: measurements.map(item => ({
        item_id: item.item_id,
        audio_stream_index: item.audio_stream_index,
        ...(item.integrated_lufs === undefined ? {} : { integrated_lufs: item.integrated_lufs }),
        ...(item.true_peak_db === undefined ? {} : { true_peak_db: item.true_peak_db }),
        ...(item.silence_ratio === undefined ? {} : { silence_ratio: item.silence_ratio }),
        silence_ranges: item.silence_ranges ?? [],
      })),
      proposed_commands: commands,
      semantic_cut_suggestions: semanticCutSuggestions,
      semantic_cut_not_recommended: semanticCutNotRecommended,
      ducking,
      facts_basis_hash: factBasisHash({ timeline: timeline.id, measurements, transcriptAnchors }),
      created_at: this.iso(),
    })
  }

  createPreflightReport(input: {
    project: VideoStudioProject
    version: DeliveryVariantVersion
    timeline: EditorialTimelineVersion
    profile: VideoExportProfileRevision
    executionPlanId?: string
  }): VideoQualityReport {
    const { project, version, timeline, profile } = input
    const checks: VideoQualityCheck[] = []
    const videoItems = timeline.items.filter(item => item.kind === 'video')
    checks.push(videoItems.length
      ? qualityCheck('timeline_nonempty', 'passed', 'info', '编辑时间线含有可交付的视频条目。')
      : qualityCheck('timeline_nonempty', 'blocked', 'error', '编辑时间线没有可交付的视频条目。'))
    for (const item of timeline.items) {
      const binding = item.binding
      if (binding.kind !== 'source') continue
      const source = project.sources.find(candidate => candidate.id === binding.source_id)
      if (!source || source.missing || source.content_changed || source.fingerprint !== binding.source_fingerprint) {
        checks.push(qualityCheck('source_integrity', 'blocked', 'error', '时间线引用的素材不可用或已变化。', { item_id: item.id, range: item.timeline_range }))
      }
    }
    if (profile.caption_mode !== 'none') {
      const revision = version.caption_revision_id ? project.caption_document_revisions.find(candidate => candidate.id === version.caption_revision_id) : undefined
      const style = revision ? project.caption_styles.find(candidate => candidate.id === revision.style_id) : undefined
      if (!revision || !style || revision.editorial_timeline_version_id !== timeline.id) {
        checks.push(qualityCheck('caption_ready', 'blocked', 'error', '当前交付规格要求字幕，但没有与此编辑版本匹配的字幕修订。'))
      } else {
        for (const issue of inspectCaptionDelivery(style, revision.cues, { width: profile.width, height: profile.height })) {
          checks.push(qualityCheck(issue.code, 'blocked', 'error', issue.message))
        }
        try {
          assertCaptionCuesFitTimeline(revision.cues, timeline)
        } catch (error) {
          const message = error instanceof Error ? error.message : '字幕 Cue 时间范围无效。'
          checks.push(qualityCheck('caption_timing', 'blocked', 'error', message))
        }
        if (!revision.cues.length || revision.cues.some(cue => cue.alignment_state !== 'ready')) {
          checks.push(qualityCheck('caption_alignment', 'needs_user_decision', 'warning', '字幕缺少 Cue 或仍需校准，不能标记为直接交付。'))
        } else {
          checks.push(qualityCheck('caption_alignment', 'passed', 'info', '字幕 Cue 已由服务端重投影到转写时间码。'))
        }
      }
    }
    if (version.composition_plan_id) {
      const plan = project.composition_plans.find(candidate => candidate.id === version.composition_plan_id)
      if (!plan || plan.editorial_timeline_version_id !== timeline.id || plan.export_profile_hash !== profile.content_hash) {
        checks.push(qualityCheck('composition_basis', 'blocked', 'error', '构图计划不再匹配当前交付规格。'))
      } else if (plan.unresolved_ranges.length) {
        checks.push(qualityCheck('composition_unresolved', 'needs_user_decision', 'warning', '部分画幅缺少可信主体证据，已保留原构图。'))
      } else {
        checks.push(qualityCheck('composition_basis', 'passed', 'info', '构图计划具有可信主体证据。'))
      }
    }
    if (version.audio_finishing_plan_id) {
      const plan = project.audio_finishing_plans.find(candidate => candidate.id === version.audio_finishing_plan_id)
      if (!plan || plan.editorial_timeline_version_id !== timeline.id) {
        checks.push(qualityCheck('audio_finishing_basis', 'blocked', 'error', '音频完成计划不再匹配当前编辑版本。'))
      } else if (!plan.measured_loudness.length) {
        checks.push(qualityCheck('audio_measurement', 'needs_user_decision', 'warning', '尚未获得可用的响度或峰值测量。'))
      } else {
        checks.push(qualityCheck('audio_measurement', 'passed', 'info', '音频响度、峰值或静音测量已纳入完成计划。'))
      }
    }
    if (!checks.some(check => check.code === 'source_integrity')) {
      checks.push(qualityCheck('source_integrity', 'passed', 'info', '当前时间线引用的素材完整指纹有效。'))
    }
    const basis = hash({ timeline: timeline.id, variant: version.id, profile: profile.content_hash, facts: timeline.facts_basis_hash })
    return videoQualityReportSchema.parse({
      id: id('quality_report'),
      project_id: project.id,
      kind: 'preflight',
      state: qualityState(checks),
      editorial_timeline_version_id: timeline.id,
      delivery_variant_version_id: version.id,
      export_profile_revision_id: profile.id,
      ...(input.executionPlanId ? { execution_plan_id: input.executionPlanId } : {}),
      facts_basis_hash: timeline.facts_basis_hash,
      variant_basis_hash: basis,
      checks,
      created_at: this.iso(),
    })
  }

  createPostRenderReport(input: {
    project: VideoStudioProject
    version: DeliveryVariantVersion
    timeline: EditorialTimelineVersion
    profile: VideoExportProfileRevision
    executionPlanId: string
    output: PostRenderOutputInspection
  }): VideoQualityReport {
    const { project, version, timeline, profile, output } = input
    const checks: VideoQualityCheck[] = []
    const maxDurationDelta = Math.max(100, Math.ceil(2_000 * profile.frame_rate.den / profile.frame_rate.num))
    const hasVerifiedReceipt = output.byte_size > 0
      && /^sha256:[a-f0-9]{64}$/.test(output.content_hash)
      && output.decoded === true
      && output.packet_timestamps_monotonic === true
      && Number.isInteger(output.expected_duration_ms)
      && (output.expected_duration_ms ?? 0) > 0
    checks.push(hasVerifiedReceipt
      ? qualityCheck('output_verification_receipt', 'passed', 'info', '导出字节哈希、全量解码和包时间戳收据均已持久化。')
      : qualityCheck('output_verification_receipt', 'blocked', 'error', '导出缺少完整的字节、解码或包时间戳校验收据。'))
    checks.push(output.video_stream_count === 1 && output.audio_stream_count === 1
      ? qualityCheck('output_stream_layout', 'passed', 'info', '导出只包含一条视频流和一条音频流。')
      : qualityCheck('output_stream_layout', 'blocked', 'error', '导出流布局不符合冻结 ExecutionPlan 的单视频单音频约束。'))
    checks.push(output.decoded
      ? qualityCheck('decode_scan', 'passed', 'info', '导出文件已通过全量解码扫描。')
      : qualityCheck('decode_scan', 'blocked', 'error', '导出文件未通过全量解码扫描。'))
    checks.push(output.packet_timestamps_monotonic
      ? qualityCheck('packet_timestamps', 'passed', 'info', '导出包时间戳单调。')
      : qualityCheck('packet_timestamps', 'blocked', 'error', '导出包时间戳不单调。'))
    checks.push((output.duration_delta_ms ?? Number.MAX_SAFE_INTEGER) <= maxDurationDelta
      ? qualityCheck('duration_tolerance', 'passed', 'info', '导出时长满足允许误差。')
      : qualityCheck('duration_tolerance', 'blocked', 'error', '导出时长超出允许误差。'))
    checks.push(output.audio_video_duration_delta_ms !== undefined && output.audio_video_duration_delta_ms <= maxDurationDelta
      ? qualityCheck('av_duration_tolerance', 'passed', 'info', '导出音视频时长满足允许误差。')
      : qualityCheck('av_duration_tolerance', 'blocked', 'error', '导出缺少独立音视频时长证据或二者时长不一致。'))
    const profileMatches = output.width === profile.width && output.height === profile.height
      && output.fps !== undefined
      && Math.abs(output.fps - profile.frame_rate.num / profile.frame_rate.den) <= 0.01
      && output.container === profile.encoding.container
      && output.video_codec === profile.encoding.video.codec
      && (profile.encoding.video.codec !== 'prores_422'
        || output.prores_profile === profile.encoding.video.quality.profile)
      && output.audio_codec === profile.encoding.audio.codec
      && output.pixel_format === profile.encoding.output_color.pixel_format
      && output.color_range === profile.encoding.output_color.range
    checks.push(profileMatches
      ? qualityCheck('profile_integrity', 'passed', 'info', '导出编码、画幅和颜色规格与冻结 Profile 一致。')
      : qualityCheck('profile_integrity', 'blocked', 'error', '导出文件与冻结的编码或画幅规格不一致。'))
    const blackDuration = output.black_duration_ms
    const blackRatio = output.black_ratio
    if (!Number.isFinite(blackDuration) || blackDuration! < 0 || !Number.isFinite(blackRatio) || blackRatio! < 0 || blackRatio! > 1) {
      checks.push(qualityCheck('black_frame_scan', 'blocked', 'error', '导出缺少可复核的全量黑场扫描结果。'))
    } else if (blackDuration! >= 1_000 || blackRatio! >= 0.05) {
      checks.push(qualityCheck(
        'black_frame_scan',
        'needs_user_decision',
        'warning',
        `导出检测到 ${blackDuration}ms 黑场（${(blackRatio! * 100).toFixed(1)}%），需确认是否为有意留黑。`,
      ))
    } else {
      checks.push(qualityCheck('black_frame_scan', 'passed', 'info', '全量黑场扫描未发现需要人工确认的留黑。'))
    }
    const plannedAudio = expectedAudibleAudio(
      project,
      version,
      timeline,
      profile,
      input.executionPlanId,
      output.execution_plan_id,
    )
    const silenceDuration = output.silence_duration_ms
    const silenceRatio = output.silence_ratio
    if (!plannedAudio.valid) {
      checks.push(qualityCheck('silence_scan', 'blocked', 'error', '无法验证后渲染静音扫描对应的冻结 ExecutionPlan。'))
    } else if (!plannedAudio.expected) {
      checks.push(qualityCheck('silence_scan', 'passed', 'info', '冻结 ExecutionPlan 的音频策略未选择任何未静音音频条目，输出静音为预期容器兼容音轨。'))
    } else if (!Number.isFinite(silenceDuration) || silenceDuration! < 0 || !Number.isFinite(silenceRatio) || silenceRatio! < 0 || silenceRatio! > 1) {
      checks.push(qualityCheck('silence_scan', 'blocked', 'error', '导出缺少可复核的全量静音扫描结果。'))
    } else if (silenceDuration! >= 3_000 || silenceRatio! >= 0.35) {
      checks.push(qualityCheck(
        'silence_scan',
        'needs_user_decision',
        'warning',
        `导出检测到 ${silenceDuration}ms 静音（${(silenceRatio! * 100).toFixed(1)}%），需确认是否为有意留白或音频缺失。`,
      ))
    } else {
      checks.push(qualityCheck('silence_scan', 'passed', 'info', '全量静音扫描未发现需要人工确认的长静音。'))
    }
    const basis = hash({ timeline: timeline.id, variant: version.id, profile: profile.content_hash, output: output.content_hash })
    return videoQualityReportSchema.parse({
      id: id('quality_report'),
      project_id: project.id,
      kind: 'post_render',
      state: qualityState(checks),
      editorial_timeline_version_id: timeline.id,
      delivery_variant_version_id: version.id,
      export_profile_revision_id: profile.id,
      execution_plan_id: input.executionPlanId,
      facts_basis_hash: timeline.facts_basis_hash,
      variant_basis_hash: basis,
      checks,
      output_verification: output,
      created_at: this.iso(),
    })
  }
}
