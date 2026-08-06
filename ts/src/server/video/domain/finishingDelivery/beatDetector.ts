import { createHash } from 'node:crypto'
import { rationalTime, sourceTimeRange, type RationalTime, type SourceTimeRange } from '../mediaFacts/time.js'

const ANALYZER_VERSION = 'local-energy-v2' as const

export type BeatGrid = {
  bpm?: number
  tempo_bpm?: number
  beat_times: RationalTime[]
  beats: Array<{ at: RationalTime; strength: number; downbeat: boolean }>
  confidence: number
  analyzer_version: typeof ANALYZER_VERSION
  pcm_hash: `sha256:${string}`
  sample_rate: number
  coverage: SourceTimeRange[]
}

function pcmHash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function coverage(sourceStart: RationalTime, sampleRate: number, sampleCount: number): SourceTimeRange[] {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || sampleCount <= 0) return []
  const rate = sourceStart.tick_rate
  const duration = rationalTime(
    BigInt(sampleCount) * BigInt(rate.num) / (BigInt(sampleRate) * BigInt(rate.den)),
    rate,
  )
  return [sourceTimeRange(sourceStart, duration)]
}

function emptyGrid(sampleRate: number, sourceStart: RationalTime, sampleCount: number, hash: `sha256:${string}`): BeatGrid {
  return {
    beat_times: [],
    beats: [],
    confidence: 0,
    analyzer_version: ANALYZER_VERSION,
    pcm_hash: hash,
    sample_rate: sampleRate,
    coverage: coverage(sourceStart, sampleRate, sampleCount),
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

type EnergyPeak = { index: number; energy: number }

/**
 * A bounded onset detector used by both the array and stream entry points.
 * The only unbounded collection is the final list of beats returned to the
 * caller; media duration never creates an in-memory energy timeline.
 */
class StreamingEnergyBeatDetector {
  private readonly minimumDistance: number
  private beforePrevious?: { index: number; energy: number; threshold: number }
  private previous?: { index: number; energy: number; threshold: number }
  private readonly peaks: EnergyPeak[] = []
  private floor = 0
  private deviation = 0
  private initialized = false
  private index = 0

  constructor(readonly windowSeconds: number) {
    this.minimumDistance = Math.max(1, Math.round(0.25 / windowSeconds))
  }

  private threshold(): number {
    return Math.max(0.003, this.floor + Math.max(this.deviation * 4, this.floor * 1.5))
  }

  private updateNoiseFloor(energy: number, threshold: number): void {
    if (!this.initialized) {
      this.floor = energy
      this.deviation = 0
      this.initialized = true
      return
    }
    // Do not let a transient onset raise the baseline used to find the next
    // one. This is an EWMA, so state stays constant regardless of duration.
    if (energy > threshold * 1.5) return
    const nextFloor = this.floor + (energy - this.floor) * 0.02
    this.deviation += (Math.abs(energy - nextFloor) - this.deviation) * 0.02
    this.floor = nextFloor
  }

  push(energy: number): void {
    const threshold = this.threshold()
    const current = { index: this.index, energy, threshold }
    if (this.beforePrevious && this.previous
      && this.previous.energy >= this.beforePrevious.energy
      && this.previous.energy >= current.energy
      && this.previous.energy >= this.previous.threshold) {
      const last = this.peaks.at(-1)
      if (last && this.previous.index - last.index < this.minimumDistance) {
        if (this.previous.energy > last.energy) this.peaks[this.peaks.length - 1] = { index: this.previous.index, energy: this.previous.energy }
      } else {
        this.peaks.push({ index: this.previous.index, energy: this.previous.energy })
      }
    }
    this.updateNoiseFloor(energy, threshold)
    this.beforePrevious = this.previous
    this.previous = current
    this.index += 1
  }

  values(): EnergyPeak[] {
    return this.peaks
  }
}

function gridFromPeaks(
  peaks: EnergyPeak[],
  windowSeconds: number,
  sourceStart: RationalTime,
  sampleRate: number,
  sampleCount: number,
  hash: `sha256:${string}`,
): BeatGrid {
  if (peaks.length < 4) return emptyGrid(sampleRate, sourceStart, sampleCount, hash)
  const intervals = peaks.slice(1).map((peak, index) => (peak.index - peaks[index]!.index) * windowSeconds).filter(value => value > 0)
  const interval = median(intervals)
  if (!Number.isFinite(interval) || interval <= 0) return emptyGrid(sampleRate, sourceStart, sampleCount, hash)
  let bpm = 60 / interval
  while (bpm < 60) bpm *= 2
  while (bpm > 200) bpm /= 2
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length
  const variance = intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length
  const coefficient = mean > 0 ? Math.sqrt(variance) / mean : 1
  const confidence = Math.max(0, Math.min(1, 0.98 - coefficient * 2 - Math.max(0, 6 - peaks.length) * 0.05))
  const roundedBpm = Math.round(bpm * 100) / 100
  if (confidence < 0.65) {
    return { ...emptyGrid(sampleRate, sourceStart, sampleCount, hash), bpm: roundedBpm, tempo_bpm: roundedBpm, confidence }
  }
  const rate = sourceStart.tick_rate
  const beats = peaks.map(peak => {
    const delta = BigInt(Math.round(peak.index * windowSeconds * rate.num / rate.den))
    return {
      at: rationalTime(BigInt(sourceStart.ticks) + delta, rate),
      strength: Math.max(0, Math.min(1, (peak.energy - 0.003) / Math.max(0.000_001, peak.energy))),
      // Phase cannot be inferred from energy alone.  Never present a guessed
      // downbeat as a deterministic editorial anchor.
      downbeat: false,
    }
  })
  return {
    bpm: roundedBpm,
    tempo_bpm: roundedBpm,
    beat_times: beats.map(beat => beat.at),
    beats,
    confidence,
    analyzer_version: ANALYZER_VERSION,
    pcm_hash: hash,
    sample_rate: sampleRate,
    coverage: coverage(sourceStart, sampleRate, sampleCount),
  }
}

/**
 * Deterministic local onset detector. It deliberately prefers no grid to a
 * speculative BPM: callers must gate Beat Sync on confidence >= 0.65.
 */
export function detectBeatGrid(
  pcm: Float32Array,
  sampleRate: number,
  sourceStart: RationalTime,
): BeatGrid {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const hash = pcmHash(bytes)
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || !pcm.length) {
    return emptyGrid(sampleRate, sourceStart, 0, hash)
  }
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.01))
  const detector = new StreamingEnergyBeatDetector(windowSamples / sampleRate)
  for (let offset = 0; offset < pcm.length; offset += windowSamples) {
    let sum = 0
    const end = Math.min(pcm.length, offset + windowSamples)
    for (let index = offset; index < end; index += 1) sum += Math.abs(pcm[index] ?? 0)
    detector.push(sum / Math.max(1, end - offset))
  }
  return gridFromPeaks(detector.values(), windowSamples / sampleRate, sourceStart, sampleRate, pcm.length, hash)
}

/**
 * Consume FFmpeg f32le stdout without buffering a full media file in memory.
 * Only one 10ms energy window, the local peak state, and a four-byte sample
 * tail stay in memory. The returned BeatGrid itself naturally contains one
 * entry per detected beat.
 */
export async function detectBeatGridFromPcmChunks(
  chunks: AsyncIterable<Uint8Array<ArrayBufferLike>>,
  sampleRate: number,
  sourceStart: RationalTime,
): Promise<BeatGrid> {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000) {
    return emptyGrid(sampleRate, sourceStart, 0, pcmHash(new Uint8Array()))
  }
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.01))
  const detector = new StreamingEnergyBeatDetector(windowSamples / sampleRate)
  let windowSum = 0
  let samplesInWindow = 0
  let sampleCount = 0
  let tail: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  const hasher = createHash('sha256')
  for await (const chunk of chunks) {
    hasher.update(chunk)
    const bytes: Uint8Array<ArrayBufferLike> = tail.length
      ? (() => { const merged = new Uint8Array(tail.length + chunk.length); merged.set(tail); merged.set(chunk, tail.length); return merged })()
      : chunk
    const aligned = bytes.length - bytes.length % 4
    const view = new DataView(bytes.buffer, bytes.byteOffset, aligned)
    for (let offset = 0; offset < aligned; offset += 4) {
      windowSum += Math.abs(view.getFloat32(offset, true))
      samplesInWindow += 1
      sampleCount += 1
      if (samplesInWindow === windowSamples) {
        detector.push(windowSum / samplesInWindow)
        windowSum = 0
        samplesInWindow = 0
      }
    }
    tail = bytes.subarray(aligned)
  }
  if (samplesInWindow > 0) detector.push(windowSum / samplesInWindow)
  const hash = `sha256:${hasher.digest('hex')}` as `sha256:${string}`
  if (!sampleCount) return emptyGrid(sampleRate, sourceStart, sampleCount, hash)
  return gridFromPeaks(detector.values(), windowSamples / sampleRate, sourceStart, sampleRate, sampleCount, hash)
}
