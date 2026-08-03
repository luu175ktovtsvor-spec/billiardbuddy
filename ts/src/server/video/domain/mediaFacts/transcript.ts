import { createHash } from 'node:crypto'
import type { TimedTranscript, TranscriptRevision } from './model.js'

export type TranscriptProjectionSegment = {
  anchor_segment_ids: string[]
  start: TimedTranscript['segments'][number]['start']
  duration: TimedTranscript['segments'][number]['duration']
  text: string
  speaker_id?: string
  word_ids: string[]
}

export type TranscriptProjection = {
  transcript_id: string
  revision_id?: string
  segments: TranscriptProjectionSegment[]
}

/** The original ASR payload is immutable; this hash is the revision anchor. */
export function transcriptRevisionFingerprint(transcript: TimedTranscript): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    id: transcript.id,
    source_id: transcript.source_id,
    source_fingerprint: transcript.source_fingerprint,
    model_receipt_id: transcript.model_receipt_id,
    source_offset: transcript.source_offset,
    language: transcript.language,
    segments: transcript.segments,
  })).digest('hex')}`
}

function projectionSegment(segment: TimedTranscript['segments'][number]): TranscriptProjectionSegment {
  return {
    anchor_segment_ids: [segment.id],
    start: segment.start,
    duration: segment.duration,
    text: segment.text,
    ...(segment.speaker_id ? { speaker_id: segment.speaker_id } : {}),
    word_ids: segment.words.map(word => word.id),
  }
}

/**
 * Applies text/speaker/grouping edits without changing any source timestamp.
 * Split and merge projections retain every original Segment/Word anchor so
 * later editorial commands cannot mistake rewritten text for a new timecode.
 */
export function materializeTranscriptRevision(transcript: TimedTranscript, revision?: TranscriptRevision): TranscriptProjection {
  if (!revision) return { transcript_id: transcript.id, segments: transcript.segments.map(projectionSegment) }
  if (revision.transcript_id !== transcript.id) throw new Error('转录修订不属于该原始转录')
  if (revision.base_transcript_fingerprint !== transcriptRevisionFingerprint(transcript)) {
    throw new Error('转录修订不再匹配不可变原始转录')
  }
  let segments = transcript.segments.map(projectionSegment)
  for (const edit of revision.edits) {
    if (edit.kind === 'replace_text') {
      const segment = segments.find(item => item.anchor_segment_ids.includes(edit.segment_id))
      if (!segment) throw new Error('文字修订引用了不存在的原始片段')
      segment.text = edit.text
      continue
    }
    if (edit.kind === 'set_speaker') {
      const targets = new Set(edit.segment_ids)
      const matched = segments.filter(item => item.anchor_segment_ids.some(id => targets.has(id)))
      if (matched.length !== targets.size) throw new Error('说话人修订引用了不存在的原始片段')
      for (const segment of matched) segment.speaker_id = edit.speaker_id
      continue
    }
    if (edit.kind === 'split_segment') {
      const index = segments.findIndex(item => item.anchor_segment_ids.length === 1 && item.anchor_segment_ids[0] === edit.segment_id)
      if (index < 0) throw new Error('断句只能锚定未合并的原始片段')
      const original = transcript.segments.find(item => item.id === edit.segment_id)
      const wordIndex = original?.words.findIndex(word => word.id === edit.at_word_id) ?? -1
      if (!original || wordIndex <= 0 || wordIndex >= original.words.length) throw new Error('断句位置必须位于原始词之间')
      const leftWords = original.words.slice(0, wordIndex)
      const rightWords = original.words.slice(wordIndex)
      const originalProjection = segments[index]!
      const leftDuration = rightWords[0]!.start.ticks === original.start.ticks
        ? '0'
        : (BigInt(rightWords[0]!.start.ticks) - BigInt(original.start.ticks)).toString()
      const rightStart = rightWords[0]!.start
      const rightDuration = (BigInt(original.start.ticks) + BigInt(original.duration.ticks) - BigInt(rightStart.ticks)).toString()
      segments.splice(index, 1,
        { ...originalProjection, text: leftWords.map(word => word.text).join(' '), duration: { ...original.duration, ticks: leftDuration }, word_ids: leftWords.map(word => word.id) },
        { ...originalProjection, start: rightStart, duration: { ...original.duration, ticks: rightDuration }, text: rightWords.map(word => word.text).join(' '), word_ids: rightWords.map(word => word.id) },
      )
      continue
    }
    const positions = edit.segment_ids.map(id => segments.findIndex(item => item.anchor_segment_ids.length === 1 && item.anchor_segment_ids[0] === id))
    if (positions.some(position => position < 0)) throw new Error('合并修订引用了不存在或已重组的原始片段')
    const sorted = [...positions].sort((left, right) => left - right)
    if (sorted.some((position, index) => index > 0 && position !== sorted[index - 1]! + 1)) {
      throw new Error('只能合并连续的原始转录片段')
    }
    const first = segments[sorted[0]!]!
    const last = segments[sorted.at(-1)!]!
    const duration = (BigInt(last.start.ticks) + BigInt(last.duration.ticks) - BigInt(first.start.ticks)).toString()
    const merged = segments.slice(sorted[0]!, sorted.at(-1)! + 1)
    segments.splice(sorted[0]!, merged.length, {
      anchor_segment_ids: merged.flatMap(item => item.anchor_segment_ids),
      start: first.start,
      duration: { ...first.duration, ticks: duration },
      text: merged.map(item => item.text).join(' '),
      ...(merged.every(item => item.speaker_id === first.speaker_id) && first.speaker_id ? { speaker_id: first.speaker_id } : {}),
      word_ids: merged.flatMap(item => item.word_ids),
    })
  }
  return { transcript_id: transcript.id, revision_id: revision.id, segments }
}
