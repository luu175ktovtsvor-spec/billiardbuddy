import { randomUUID } from 'node:crypto'
import { rationalTime, type RationalTime } from '../../domain/mediaFacts/time.js'

export type FunAsrRoute = 'short_sync' | 'long_async'
export function selectFunAsrRoute(input: { sourceDurationMs: number; needsSpeakerDiarization: boolean; hotwords: string[] }): FunAsrRoute {
  return input.sourceDurationMs <= 5 * 60_000 && !input.needsSpeakerDiarization && input.hotwords.length === 0 ? 'short_sync' : 'long_async'
}

export type RemoteAsrWord = { text: string; begin_time: number; end_time: number; confidence?: number }
export type RemoteAsrSentence = { text: string; begin_time: number; end_time: number; speaker_id?: string; words: RemoteAsrWord[] }
export type TimedAsrSegment = { id: string; start: RationalTime; duration: RationalTime; text: string; speaker_id?: string; words: Array<{ id: string; start: RationalTime; duration: RationalTime; text: string; confidence?: number }> }

/** Converts provider millisecond offsets into immutable original-source PTS. */
export function normalizeFunAsrSentences(sentences: RemoteAsrSentence[], sourceOffset: RationalTime): TimedAsrSegment[] {
  const rate = sourceOffset.tick_rate
  const offset = BigInt(sourceOffset.ticks)
  return sentences.flatMap(sentence => {
    if (!sentence.text.trim() || !Number.isFinite(sentence.begin_time) || !Number.isFinite(sentence.end_time) || sentence.begin_time < 0 || sentence.end_time <= sentence.begin_time) return []
    const ticks = (ms: number) => BigInt(Math.round(ms * rate.num / (1000 * rate.den)))
    const start = offset + ticks(sentence.begin_time); const end = offset + ticks(sentence.end_time)
    const words = sentence.words.flatMap(word => {
      if (!word.text.trim() || !Number.isFinite(word.begin_time) || !Number.isFinite(word.end_time) || word.begin_time < sentence.begin_time || word.end_time > sentence.end_time || word.end_time <= word.begin_time) return []
      const wordStart = offset + ticks(word.begin_time); const wordEnd = offset + ticks(word.end_time)
      return [{ id: `word_${randomUUID().replaceAll('-', '')}`, start: rationalTime(wordStart, rate), duration: rationalTime(wordEnd - wordStart, rate), text: word.text.trim(), ...(word.confidence === undefined ? {} : { confidence: word.confidence }) }]
    })
    return [{ id: `segment_${randomUUID().replaceAll('-', '')}`, start: rationalTime(start, rate), duration: rationalTime(end - start, rate), text: sentence.text.trim(), ...(sentence.speaker_id ? { speaker_id: sentence.speaker_id } : {}), words }]
  })
}
