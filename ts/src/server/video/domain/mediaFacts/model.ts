import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { mediaAssetSchema, mediaIdSchema, mediaIsoDateSchema } from '../../../../../shared/contracts/media.js'
import {
  type FrameRate,
  type MediaTimeBase,
  type SourceTimeRange,
  compareRationalTime,
  endOfRange,
  frameRate,
  mediaTimeBase,
  rationalTime,
  sourceTimeRangeSchema,
  tickRateForTimeBase,
} from './time.js'

const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const nonNegativeSafeInteger = z.number().int().nonnegative().safe()
const positiveSafeInteger = z.number().int().positive().safe()
const timeBaseSchema: z.ZodType<MediaTimeBase> = z.object({ num: positiveSafeInteger, den: positiveSafeInteger })
  .transform(value => mediaTimeBase(value.num, value.den))
const frameRateSchema: z.ZodType<FrameRate> = z.object({ num: positiveSafeInteger, den: positiveSafeInteger })
  .transform(value => frameRate(value.num, value.den))

const streamTimingSchema = z.object({
  stream_index: nonNegativeSafeInteger,
  time_base: timeBaseSchema,
  start_time: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) })
    .transform(value => rationalTime(value.ticks, value.tick_rate)),
  duration: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) })
    .transform(value => rationalTime(value.ticks, value.tick_rate)).optional(),
}).superRefine((value, context) => {
  const expected = tickRateForTimeBase(value.time_base)
  if (value.start_time.tick_rate.num !== expected.num || value.start_time.tick_rate.den !== expected.den) {
    context.addIssue({ code: 'custom', path: ['start_time', 'tick_rate'], message: 'stream timestamp rate must be inverse of time_base' })
  }
  if (value.duration && (value.duration.tick_rate.num !== expected.num || value.duration.tick_rate.den !== expected.den)) {
    context.addIssue({ code: 'custom', path: ['duration', 'tick_rate'], message: 'stream timestamp rate must be inverse of time_base' })
  }
})

export const videoStreamInfoSchema = streamTimingSchema.extend({
  codec: z.string().min(1).max(160),
  width: positiveSafeInteger,
  height: positiveSafeInteger,
  rotation: z.number().int().min(-360).max(360),
  average_frame_rate: frameRateSchema.optional(),
  nominal_frame_rate: frameRateSchema.optional(),
  variable_frame_rate: z.boolean(),
})

export const audioTrackInfoSchema = streamTimingSchema.extend({
  codec: z.string().min(1).max(160),
  sample_rate: positiveSafeInteger,
  channels: positiveSafeInteger,
  channel_layout: z.string().min(1).max(160).optional(),
  language: z.string().min(1).max(32).optional(),
  title: z.string().min(1).max(500).optional(),
  disposition_default: z.boolean(),
})

export const videoFastIdentitySchema = z.object({
  byte_size: nonNegativeSafeInteger,
  mtime_ms: z.number().finite().nonnegative(),
  file_id: z.string().min(1).max(200).optional(),
  head_tail_hash: hashSchema,
})

export const videoFactSourceSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(500),
  fast_identity: videoFastIdentitySchema,
  fingerprint: hashSchema.optional(),
  fingerprint_state: z.enum(['pending', 'ready', 'failed']),
  primary_video_stream: videoStreamInfoSchema,
  presentation_duration: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) })
    .transform(value => rationalTime(value.ticks, value.tick_rate)),
  audio_tracks: z.array(audioTrackInfoSchema).max(32),
  state: z.enum(['probing', 'ready', 'missing', 'changed', 'unsupported']),
  created_at: mediaIsoDateSchema,
  updated_at: mediaIsoDateSchema,
}).superRefine((value, context) => {
  if (value.fingerprint_state === 'ready' && !value.fingerprint) {
    context.addIssue({ code: 'custom', path: ['fingerprint'], message: 'ready source fingerprint is required' })
  }
  if (value.fingerprint_state !== 'ready' && value.fingerprint) {
    context.addIssue({ code: 'custom', path: ['fingerprint'], message: 'only ready sources may expose a full fingerprint' })
  }
  const rate = value.primary_video_stream.start_time.tick_rate
  if (value.presentation_duration.tick_rate.num !== rate.num || value.presentation_duration.tick_rate.den !== rate.den) {
    context.addIssue({ code: 'custom', path: ['presentation_duration', 'tick_rate'], message: 'presentation duration must use primary video PTS rate' })
  }
  if (BigInt(value.presentation_duration.ticks) <= 0n) {
    context.addIssue({ code: 'custom', path: ['presentation_duration'], message: 'presentation duration must be positive' })
  }
})

export const videoDerivativeKindSchema = z.enum(['proxy', 'thumbnail', 'waveform', 'audio_extract', 'scene_map', 'keyframe'])
export const videoDerivativeSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  source_id: mediaIdSchema,
  source_fingerprint: hashSchema,
  kind: videoDerivativeKindSchema,
  source_range: sourceTimeRangeSchema.optional(),
  asset: mediaAssetSchema,
  content_hash: hashSchema,
  byte_size: nonNegativeSafeInteger,
  generator_name: z.string().min(1).max(160),
  generator_version: z.string().min(1).max(160),
  parameters_hash: hashSchema,
  created_by_operation_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
  state: z.enum(['ready', 'stale', 'missing']),
})

export const transcriptWordSchema = z.object({
  id: mediaIdSchema,
  start: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) }).transform(value => rationalTime(value.ticks, value.tick_rate)),
  duration: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) }).transform(value => rationalTime(value.ticks, value.tick_rate)),
  text: z.string().min(1).max(1000),
  confidence: z.number().min(0).max(1).optional(),
})

export const transcriptSegmentSchema = z.object({
  id: mediaIdSchema,
  source_id: mediaIdSchema,
  start: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) }).transform(value => rationalTime(value.ticks, value.tick_rate)),
  duration: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) }).transform(value => rationalTime(value.ticks, value.tick_rate)),
  text: z.string().min(1).max(16_000),
  speaker_id: z.string().min(1).max(160).optional(),
  words: z.array(transcriptWordSchema).max(10_000),
}).superRefine((value, context) => {
  const range = { start: value.start, duration: value.duration }
  for (const [index, word] of value.words.entries()) {
    const sameRate = word.start.tick_rate.num === value.start.tick_rate.num
      && word.start.tick_rate.den === value.start.tick_rate.den
      && word.duration.tick_rate.num === value.start.tick_rate.num
      && word.duration.tick_rate.den === value.start.tick_rate.den
    if (!sameRate) {
      context.addIssue({ code: 'custom', path: ['words', index], message: 'word timestamps must use the segment PTS rate' })
      continue
    }
    if (compareRationalTime(word.start, range.start) < 0 || compareRationalTime(endOfRange({ start: word.start, duration: word.duration }), endOfRange(range)) > 0) {
      context.addIssue({ code: 'custom', path: ['words', index], message: 'word range must remain inside its segment range' })
    }
  }
})

export const timedTranscriptSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  source_id: mediaIdSchema,
  source_fingerprint: hashSchema,
  model_receipt_id: mediaIdSchema,
  source_offset: z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) }).transform(value => rationalTime(value.ticks, value.tick_rate)),
  language: z.string().min(1).max(32).optional(),
  segments: z.array(transcriptSegmentSchema).max(20_000),
  created_at: mediaIsoDateSchema,
})

const transcriptEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replace_text'), segment_id: mediaIdSchema, text: z.string().min(1).max(16_000) }),
  z.object({ kind: z.literal('set_speaker'), segment_ids: z.array(mediaIdSchema).min(1).max(10_000), speaker_id: z.string().min(1).max(160) }),
  z.object({ kind: z.literal('split_segment'), segment_id: mediaIdSchema, at_word_id: mediaIdSchema }),
  z.object({ kind: z.literal('merge_segments'), segment_ids: z.array(mediaIdSchema).min(2).max(10_000) }),
])

export const transcriptRevisionSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  transcript_id: mediaIdSchema,
  parent_revision_id: mediaIdSchema.optional(),
  base_transcript_fingerprint: hashSchema,
  edits: z.array(transcriptEditSchema).max(10_000),
  created_at: mediaIsoDateSchema,
})

export const cameraShotSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  source_id: mediaIdSchema,
  source_fingerprint: hashSchema,
  range: sourceTimeRangeSchema,
  boundary_source: z.enum(['scene_detect', 'embedded_cut_marker', 'manual']),
  boundary_confidence: z.number().min(0).max(1).optional(),
  created_at: mediaIsoDateSchema,
})

export const contentSegmentSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  source_id: mediaIdSchema,
  source_fingerprint: hashSchema,
  range: sourceTimeRangeSchema,
  camera_shot_ids: z.array(mediaIdSchema).max(1_000),
  segmentation_source: z.enum(['transcript_topic', 'sentence_group', 'silence', 'motion_change', 'ocr_change', 'fixed_interval_fallback', 'manual']),
  created_at: mediaIsoDateSchema,
})

export const evidenceWindowSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  source_id: mediaIdSchema,
  source_fingerprint: hashSchema,
  camera_shot_id: mediaIdSchema.optional(),
  content_segment_id: mediaIdSchema.optional(),
  range: sourceTimeRangeSchema,
  sample_strategy: z.enum(['representative_frame', 'start_middle_end', 'visual_change_points', 'transcript_signal', 'short_proxy']),
  keyframe_derivative_ids: z.array(mediaIdSchema).max(1_000),
  proxy_derivative_id: mediaIdSchema.optional(),
  transcript_segment_ids: z.array(mediaIdSchema).max(10_000),
  evidence_ids: z.array(mediaIdSchema).max(10_000),
  analysis_depth: z.enum(['summary', 'standard', 'deep']),
  sampling_receipt_id: mediaIdSchema,
  created_at: mediaIsoDateSchema,
})

const evidenceBaseSchema = z.object({
  id: mediaIdSchema,
  project_id: mediaIdSchema,
  source_id: mediaIdSchema,
  source_fingerprint: hashSchema,
  camera_shot_id: mediaIdSchema.optional(),
  content_segment_id: mediaIdSchema.optional(),
  evidence_window_id: mediaIdSchema.optional(),
  range: sourceTimeRangeSchema,
  derivative_ids: z.array(mediaIdSchema).max(1_000),
  provider_receipt_id: mediaIdSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  facts_schema_version: z.number().int().positive(),
  prompt_version: z.string().min(1).max(160),
  basis_hash: hashSchema,
  created_at: mediaIsoDateSchema,
})

export const videoFactEvidenceSchema = z.discriminatedUnion('kind', [
  evidenceBaseSchema.extend({ kind: z.literal('transcript'), payload: z.object({ transcript_id: mediaIdSchema, revision_id: mediaIdSchema.optional(), segment_ids: z.array(mediaIdSchema), text: z.string().min(1).max(32_000), speaker_ids: z.array(z.string().min(1).max(160)) }) }),
  evidenceBaseSchema.extend({ kind: z.literal('visual'), payload: z.object({ summary: z.string().min(1).max(32_000), subjects: z.array(z.string().min(1).max(500)), setting: z.string().min(1).max(4_000).optional(), camera_motion: z.string().min(1).max(1_000).optional(), warnings: z.array(z.string().min(1).max(1_000)) }) }),
  evidenceBaseSchema.extend({ kind: z.literal('ocr'), payload: z.object({ blocks: z.array(z.object({ text: z.string().min(1).max(16_000), normalized_box: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]) })) }) }),
  evidenceBaseSchema.extend({ kind: z.literal('quality'), payload: z.object({ metric: z.enum(['sharpness', 'stability', 'exposure', 'black_frame']), score: z.number().finite(), threshold_version: z.string().min(1).max(160) }) }),
  evidenceBaseSchema.extend({ kind: z.literal('object'), payload: z.object({ label: z.string().min(1).max(500), normalized_box: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(), subject_id: mediaIdSchema.optional() }) }),
  evidenceBaseSchema.extend({ kind: z.literal('action'), payload: z.object({ label: z.string().min(1).max(500), phase: z.enum(['start', 'middle', 'end', 'complete']).optional(), actor_subject_id: mediaIdSchema.optional() }) }),
  evidenceBaseSchema.extend({ kind: z.literal('beat_grid'), payload: z.object({ bpm: z.number().positive().optional(), beat_times: z.array(z.object({ ticks: z.string(), tick_rate: z.object({ num: positiveSafeInteger, den: positiveSafeInteger }) }).transform(value => rationalTime(value.ticks, value.tick_rate))), confidence: z.number().min(0).max(1), analyzer_version: z.string().min(1).max(160) }) }),
])

export type VideoFactSource = z.infer<typeof videoFactSourceSchema>
export type VideoDerivative = z.infer<typeof videoDerivativeSchema>
export type TimedTranscript = z.infer<typeof timedTranscriptSchema>
export type TranscriptRevision = z.infer<typeof transcriptRevisionSchema>
export type CameraShot = z.infer<typeof cameraShotSchema>
export type ContentSegment = z.infer<typeof contentSegmentSchema>
export type EvidenceWindow = z.infer<typeof evidenceWindowSchema>
export type VideoFactEvidence = z.infer<typeof videoFactEvidenceSchema>
export type VideoFact = VideoFactSource | VideoDerivative | TimedTranscript | TranscriptRevision | CameraShot | ContentSegment | EvidenceWindow | VideoFactEvidence
export type VideoFactKind = 'source' | 'derivative' | 'transcript' | 'transcript_revision' | 'camera_shot' | 'content_segment' | 'evidence_window' | 'evidence'

export function factBasisHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function factKind(value: VideoFact): VideoFactKind {
  if ('fast_identity' in value) return 'source'
  if ('generator_name' in value) return 'derivative'
  if ('transcript_id' in value && 'edits' in value) return 'transcript_revision'
  if ('segments' in value) return 'transcript'
  if ('boundary_source' in value) return 'camera_shot'
  if ('segmentation_source' in value) return 'content_segment'
  if ('sample_strategy' in value) return 'evidence_window'
  return 'evidence'
}

export function factSchema(kind: VideoFactKind): z.ZodType<VideoFact> {
  switch (kind) {
    case 'source': return videoFactSourceSchema
    case 'derivative': return videoDerivativeSchema
    case 'transcript': return timedTranscriptSchema
    case 'transcript_revision': return transcriptRevisionSchema
    case 'camera_shot': return cameraShotSchema
    case 'content_segment': return contentSegmentSchema
    case 'evidence_window': return evidenceWindowSchema
    case 'evidence': return videoFactEvidenceSchema
  }
}

export function normalizeFactSearchText(text: string): string {
  const cjkTokens = [...text].filter(character => /[\u3400-\u9fff]/u.test(character)).join(' ')
  return cjkTokens ? `${text}\n${cjkTokens}` : text
}

export function factSearchText(value: VideoFact): string {
  const text = 'segments' in value
    ? value.segments.map(segment => segment.text).join('\n')
    : 'edits' in value
      ? value.edits.map(edit => edit.kind === 'replace_text' ? edit.text : edit.kind).join('\n')
      : 'payload' in value
        ? JSON.stringify(value.payload)
        : ''
  // unicode61 keeps a continuous CJK sentence as one token. Add individual
  // ideographs to the same FTS document so a normal two-character query has a
  // stable, language-neutral fallback before a later embedding index exists.
  return normalizeFactSearchText(text)
}

export function factSourceRange(value: VideoFact): SourceTimeRange | undefined {
  if ('range' in value) return value.range
  return undefined
}

type EvidenceKind = VideoFactEvidence['kind']
type EvidencePayload<K extends EvidenceKind> = Extract<VideoFactEvidence, { kind: K }>['payload']

/**
 * Provider/model payloads never choose the evidence ID, source identity,
 * range, derivative references, or basis hash. The host creates those fields
 * from the durable EvidenceWindow/Source context before persistence.
 */
export function createHostedEvidence<K extends EvidenceKind>(input: {
  kind: K
  projectId: string
  source: VideoFactSource & { fingerprint: `sha256:${string}` }
  range: SourceTimeRange
  payload: EvidencePayload<K>
  promptVersion: string
  createdAt: string
  derivativeIds?: string[]
  cameraShotId?: string
  contentSegmentId?: string
  evidenceWindowId?: string
  providerReceiptId?: string
  confidence?: number
  id?: string
}): Extract<VideoFactEvidence, { kind: K }> {
  const value = {
    id: input.id ?? `evidence_${randomUUID().replaceAll('-', '')}`,
    project_id: input.projectId,
    source_id: input.source.id,
    source_fingerprint: input.source.fingerprint,
    ...(input.cameraShotId ? { camera_shot_id: input.cameraShotId } : {}),
    ...(input.contentSegmentId ? { content_segment_id: input.contentSegmentId } : {}),
    ...(input.evidenceWindowId ? { evidence_window_id: input.evidenceWindowId } : {}),
    range: input.range,
    derivative_ids: input.derivativeIds ?? [],
    ...(input.providerReceiptId ? { provider_receipt_id: input.providerReceiptId } : {}),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    facts_schema_version: 1,
    prompt_version: input.promptVersion,
    basis_hash: factBasisHash({
      source_fingerprint: input.source.fingerprint,
      range: input.range,
      derivative_ids: input.derivativeIds ?? [],
      kind: input.kind,
      payload: input.payload,
      prompt_version: input.promptVersion,
    }),
    created_at: input.createdAt,
    kind: input.kind,
    payload: input.payload,
  }
  return videoFactEvidenceSchema.parse(value) as Extract<VideoFactEvidence, { kind: K }>
}
