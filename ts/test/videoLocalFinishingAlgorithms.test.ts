import { expect, test } from 'bun:test'
import { detectBeatGrid, detectBeatGridFromPcmChunks } from '../src/server/video/domain/finishingDelivery/beatDetector.js'
import { trackSubject } from '../src/server/video/domain/finishingDelivery/subjectTracker.js'
import { rationalTime, sourceTimeRange } from '../src/server/video/domain/mediaFacts/time.js'

function clickTrack(bpm: number, seconds = 8, sampleRate = 8_000): Float32Array {
  const pcm = new Float32Array(seconds * sampleRate)
  const interval = 60 / bpm
  for (let at = 0.5; at < seconds - 0.1; at += interval) {
    const start = Math.round(at * sampleRate)
    for (let offset = 0; offset < Math.min(16, pcm.length - start); offset += 1) pcm[start + offset] = 1
  }
  return pcm
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
  for (let offset = 0, size = 5; offset < bytes.length; offset += size, size = size === 17 ? 5 : size + 3) {
    yield bytes.subarray(offset, Math.min(bytes.length, offset + size))
  }
}

test('BeatGrid v2 对同一 PCM 的流式解码保留哈希、覆盖和可信节拍', async () => {
  const start = rationalTime('100', { num: 1_000, den: 1 })
  const pcm = clickTrack(120)
  const direct = detectBeatGrid(pcm, 8_000, start)
  const streamed = await detectBeatGridFromPcmChunks(chunks(new Uint8Array(pcm.buffer.slice(0))), 8_000, start)

  expect(direct.analyzer_version).toBe('local-energy-v2')
  expect(streamed.pcm_hash).toBe(direct.pcm_hash)
  expect(streamed.coverage).toEqual(direct.coverage)
  expect(streamed.beats.map(beat => beat.at.ticks)).toEqual(direct.beats.map(beat => beat.at.ticks))
  expect(streamed.beats.every(beat => beat.strength >= 0 && beat.strength <= 1 && beat.downbeat === false)).toBeTrue()
  expect(streamed.confidence).toBeGreaterThanOrEqual(0.65)
})

test('主体轨迹只在短可信间隔做本地平滑，长缺口显式降级', () => {
  const rate = { num: 1_000, den: 1 }
  const range = sourceTimeRange(rationalTime('0', rate), rationalTime('4000', rate))
  const tracked = trackSubject(range, [
    { evidence_id: 'evidence_00000001', range: sourceTimeRange(rationalTime('0', rate), rationalTime('100', rate)), confidence: 0.91, box: [0.10, 0.2, 0.40, 0.8] },
    { evidence_id: 'evidence_00000002', range: sourceTimeRange(rationalTime('300', rate), rationalTime('100', rate)), confidence: 0.90, box: [0.20, 0.2, 0.50, 0.8] },
    { evidence_id: 'evidence_00000003', range: sourceTimeRange(rationalTime('3000', rate), rationalTime('100', rate)), confidence: 0.88, box: [0.60, 0.2, 0.90, 0.8] },
  ])

  expect(tracked.points.some(point => point.source === 'local_track')).toBeTrue()
  expect(tracked.unresolved_ranges).toContainEqual(expect.objectContaining({ reason: 'left_frame' }))
  expect(tracked.points.every(point => point.at.ticks !== '1650')).toBeTrue()
  expect(tracked.anchor_evidence_ids).toEqual(['evidence_00000001', 'evidence_00000002', 'evidence_00000003'])
})
