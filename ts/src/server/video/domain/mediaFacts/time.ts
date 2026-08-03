import { z } from 'zod/v4'

const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

export type Rational = { num: number; den: number }
export type RationalTime = { ticks: string; tick_rate: Rational }
export type TimeRange = { start: RationalTime; duration: RationalTime }
export type MediaTimeBase = Rational & { readonly __media_time_base: 'media_time_base' }
export type FrameRate = Rational & { readonly __frame_rate: 'frame_rate' }
export type SourceTimeRange = TimeRange & { readonly __time_domain: 'source' }
export type EditorialTimeRange = TimeRange & { readonly __time_domain: 'editorial' }
export type DeliveryVariantTimeRange = TimeRange & { readonly __time_domain: 'delivery_variant' }
export type TimeRounding = 'floor' | 'ceil' | 'nearest'
export type TimeRescaleReceipt = {
  source_rate: Rational
  target_rate: Rational
  rounding: TimeRounding
  reason: string
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left)
  let b = Math.abs(right)
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`)
}

export function rational(num: number, den: number): Rational {
  assertSafeInteger(num, 'rational numerator')
  assertSafeInteger(den, 'rational denominator')
  if (num <= 0 || den <= 0) throw new Error('rational values must be positive')
  const divisor = gcd(num, den)
  return { num: num / divisor, den: den / divisor }
}

export function parseInt64(value: string): bigint {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('ticks must be an int64 decimal string')
  const parsed = BigInt(value)
  if (parsed < INT64_MIN || parsed > INT64_MAX) throw new Error('ticks exceed int64')
  return parsed
}

export function rationalTime(ticks: string | bigint, tickRate: Rational): RationalTime {
  const parsed = typeof ticks === 'bigint' ? ticks : parseInt64(ticks)
  if (parsed < INT64_MIN || parsed > INT64_MAX) throw new Error('ticks exceed int64')
  return { ticks: parsed.toString(), tick_rate: rational(tickRate.num, tickRate.den) }
}

export function mediaTimeBase(num: number, den: number): MediaTimeBase {
  return rational(num, den) as MediaTimeBase
}

export function frameRate(num: number, den: number): FrameRate {
  return rational(num, den) as FrameRate
}

export function tickRateForTimeBase(timeBase: MediaTimeBase): Rational {
  return rational(timeBase.den, timeBase.num)
}

export function sourceTimeRange(start: RationalTime, duration: RationalTime): SourceTimeRange {
  return createRange(start, duration) as SourceTimeRange
}

export function editorialTimeRange(start: RationalTime, duration: RationalTime): EditorialTimeRange {
  return createRange(start, duration) as EditorialTimeRange
}

export function deliveryVariantTimeRange(start: RationalTime, duration: RationalTime): DeliveryVariantTimeRange {
  return createRange(start, duration) as DeliveryVariantTimeRange
}

function createRange(start: RationalTime, duration: RationalTime): TimeRange {
  const normalizedStart = rationalTime(start.ticks, start.tick_rate)
  const normalizedDuration = rationalTime(duration.ticks, duration.tick_rate)
  if (
    normalizedStart.tick_rate.num !== normalizedDuration.tick_rate.num
    || normalizedStart.tick_rate.den !== normalizedDuration.tick_rate.den
  ) throw new Error('range start and duration must use one tick rate')
  if (parseInt64(normalizedDuration.ticks) < 0n) throw new Error('range duration must not be negative')
  return { start: normalizedStart, duration: normalizedDuration }
}

function applyRounding(numerator: bigint, denominator: bigint, rounding: TimeRounding): bigint {
  if (denominator <= 0n) throw new Error('rescale denominator must be positive')
  if (rounding === 'floor') return numerator >= 0n ? numerator / denominator : -((-numerator + denominator - 1n) / denominator)
  if (rounding === 'ceil') return numerator >= 0n ? (numerator + denominator - 1n) / denominator : -((-numerator) / denominator)
  const sign = numerator < 0n ? -1n : 1n
  const absolute = numerator < 0n ? -numerator : numerator
  return sign * ((absolute + denominator / 2n) / denominator)
}

export function rescaleRationalTime(value: RationalTime, targetRate: Rational, rounding: TimeRounding): RationalTime {
  const sourceRate = rational(value.tick_rate.num, value.tick_rate.den)
  const destinationRate = rational(targetRate.num, targetRate.den)
  const ticks = parseInt64(value.ticks)
  const numerator = ticks * BigInt(sourceRate.den) * BigInt(destinationRate.num)
  const denominator = BigInt(sourceRate.num) * BigInt(destinationRate.den)
  return rationalTime(applyRounding(numerator, denominator, rounding), destinationRate)
}

export function rescaleTimeRange(range: TimeRange, targetRate: Rational, rounding: TimeRounding): TimeRange {
  return createRange(
    rescaleRationalTime(range.start, targetRate, rounding),
    rescaleRationalTime(range.duration, targetRate, rounding),
  )
}

/**
 * Cross-domain conversion carries an explicit receipt; callers cannot silently
 * reinterpret a source PTS range as editorial or delivery time.
 */
export function sourceRangeToEditorial(
  range: SourceTimeRange,
  targetRate: Rational,
  rounding: TimeRounding,
  reason: string,
): { range: EditorialTimeRange; receipt: TimeRescaleReceipt } {
  const rescaled = rescaleTimeRange(range, targetRate, rounding)
  return {
    range: editorialTimeRange(rescaled.start, rescaled.duration),
    receipt: { source_rate: range.start.tick_rate, target_rate: rational(targetRate.num, targetRate.den), rounding, reason },
  }
}

export function compareRationalTime(left: RationalTime, right: RationalTime): -1 | 0 | 1 {
  const a = parseInt64(left.ticks) * BigInt(left.tick_rate.den) * BigInt(right.tick_rate.num)
  const b = parseInt64(right.ticks) * BigInt(right.tick_rate.den) * BigInt(left.tick_rate.num)
  return a === b ? 0 : a < b ? -1 : 1
}

export function addRationalTime(left: RationalTime, right: RationalTime, rounding: TimeRounding = 'nearest'): RationalTime {
  const converted = rescaleRationalTime(right, left.tick_rate, rounding)
  return rationalTime(parseInt64(left.ticks) + parseInt64(converted.ticks), left.tick_rate)
}

export function endOfRange(range: TimeRange): RationalTime {
  return addRationalTime(range.start, range.duration, 'ceil')
}

export function rangesIntersect(left: TimeRange, right: TimeRange): boolean {
  return compareRationalTime(left.start, endOfRange(right)) < 0 && compareRationalTime(right.start, endOfRange(left)) < 0
}

export function rationalFromFfprobe(value: unknown, label: string): Rational | undefined {
  if (typeof value !== 'string' || !value || value === '0/0' || value === 'N/A') return undefined
  const match = value.match(/^([0-9]+)\/([0-9]+)$/)
  if (!match) throw new Error(`${label} is not a rational FFprobe value`)
  return rational(Number(match[1]), Number(match[2]))
}

export function rationalTimeFromDecimalSeconds(value: unknown, tickRate: Rational, rounding: TimeRounding): RationalTime | undefined {
  if (typeof value !== 'string' || !value || value === 'N/A') return undefined
  const match = value.match(/^(-?)([0-9]+)(?:\.([0-9]+))?$/)
  if (!match) throw new Error('FFprobe timestamp is invalid')
  const fraction = match[3] ?? ''
  const scale = 10n ** BigInt(fraction.length)
  const secondsNumerator = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n)
  const numerator = secondsNumerator * BigInt(tickRate.num)
  const denominator = scale * BigInt(tickRate.den)
  return rationalTime(applyRounding(numerator, denominator, rounding), tickRate)
}

export function asInt64FromFfprobe(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value)
  try {
    return parseInt64(text).toString()
  } catch {
    return undefined
  }
}

const rationalInputSchema = z.object({
  num: z.number().int().safe(),
  den: z.number().int().safe(),
}).transform(value => rational(value.num, value.den))

export const rationalSchema: z.ZodType<Rational> = rationalInputSchema
export const rationalTimeSchema: z.ZodType<RationalTime> = z.object({
  ticks: z.string(),
  tick_rate: rationalInputSchema,
}).transform(value => rationalTime(value.ticks, value.tick_rate))
export const timeRangeSchema: z.ZodType<TimeRange> = z.object({
  start: rationalTimeSchema,
  duration: rationalTimeSchema,
}).transform(value => createRange(value.start, value.duration))
export const sourceTimeRangeSchema: z.ZodType<SourceTimeRange> = timeRangeSchema.transform(value => value as SourceTimeRange)
export const editorialTimeRangeSchema: z.ZodType<EditorialTimeRange> = timeRangeSchema.transform(value => value as EditorialTimeRange)
export const deliveryVariantTimeRangeSchema: z.ZodType<DeliveryVariantTimeRange> = timeRangeSchema.transform(value => value as DeliveryVariantTimeRange)

export function timeToMilliseconds(value: RationalTime): number {
  const ticks = parseInt64(value.ticks)
  const numerator = ticks * BigInt(value.tick_rate.den) * 1000n
  const denominator = BigInt(value.tick_rate.num)
  const result = applyRounding(numerator, denominator, 'nearest')
  if (result > SAFE_INTEGER || result < -SAFE_INTEGER) throw new Error('time exceeds JavaScript display range')
  return Number(result)
}
