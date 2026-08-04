import { expect, test } from 'bun:test'
import { normalizeFunAsrSentences, selectFunAsrRoute } from '../src/server/video/infrastructure/providers/funAsrAdapter.js'
import { rationalTime } from '../src/server/video/domain/mediaFacts/time.js'

test('Fun-ASR routes short sync vs long async and keeps source offset/speaker/word timestamps', () => {
  expect(selectFunAsrRoute({ sourceDurationMs: 5 * 60_000, needsSpeakerDiarization: false, hotwords: [] })).toBe('short_sync')
  expect(selectFunAsrRoute({ sourceDurationMs: 5 * 60_000 + 1, needsSpeakerDiarization: false, hotwords: [] })).toBe('long_async')
  expect(selectFunAsrRoute({ sourceDurationMs: 1_000, needsSpeakerDiarization: true, hotwords: [] })).toBe('long_async')
  const segments = normalizeFunAsrSentences([{ text: '开球', begin_time: 100, end_time: 900, speaker_id: 'speaker_1', words: [{ text: '开', begin_time: 100, end_time: 300, confidence: 0.9 }, { text: '球', begin_time: 300, end_time: 900 }] }], rationalTime('9000', { num: 90_000, den: 1 }))
  expect(segments).toHaveLength(1)
  expect(segments[0]).toMatchObject({ start: { ticks: '18000' }, duration: { ticks: '72000' }, speaker_id: 'speaker_1' })
  expect(segments[0]?.words[0]?.start.ticks).toBe('18000')
})
