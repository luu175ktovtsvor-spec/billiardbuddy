import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { VideoExecutionPlan, VideoExportProfileRevision, VideoStudioProject } from '../../../shared/contracts/media.js'
import { ContentAddressedStore } from '../media/kernel/assets/contentAddressedStore.js'
import type { VideoFactSource } from '../video/domain/mediaFacts/model.js'
import { inspectCaptionDelivery } from '../video/domain/finishingDelivery/finishingDeliveryApplication.js'
import {
  asInt64FromFfprobe,
  frameRate,
  mediaTimeBase,
  rationalFromFfprobe,
  rationalTime,
  rationalTimeFromDecimalSeconds,
  tickRateForTimeBase,
  type MediaTimeBase,
  type Rational,
  type RationalTime,
} from '../video/domain/mediaFacts/time.js'

export type VideoProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type VideoProcessRunner = (
  command: string[],
  options?: { signal?: AbortSignal },
) => Promise<VideoProcessResult>

export type VideoEncoderProfile = {
  name: 'h264_videotoolbox' | 'h264_mf' | 'libx264' | 'prores_ks' | 'mpeg4'
  args: string[]
}

export type DeliveryVideoEncoderProfile = VideoEncoderProfile & {
  profile_codec: 'h264' | 'prores_422'
  fallback_from?: 'h264_videotoolbox' | 'h264_mf'
}

const FAST_IDENTITY_WINDOW_BYTES = 64 * 1024

type FfprobeStream = Record<string, unknown>
type FfprobeMetadata = {
  format?: { duration?: unknown; start_time?: unknown }
  streams?: FfprobeStream[]
}

export type FastVideoIdentity = VideoFactSource['fast_identity']

/**
 * This is deliberately not a content fingerprint.  It permits immediate local
 * probing while the full, resumable SHA-256 operation runs independently.
 */
export async function fastVideoIdentity(path: string): Promise<FastVideoIdentity> {
  const info = await stat(path)
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) throw new Error('视频素材不是可读取的普通文件')
  const handle = await open(path, 'r')
  try {
    const digest = createHash('sha256')
    const headSize = Math.min(FAST_IDENTITY_WINDOW_BYTES, info.size)
    if (headSize > 0) {
      const head = Buffer.allocUnsafe(headSize)
      const { bytesRead } = await handle.read(head, 0, headSize, 0)
      digest.update(head.subarray(0, bytesRead))
    }
    if (info.size > FAST_IDENTITY_WINDOW_BYTES) {
      const tailSize = Math.min(FAST_IDENTITY_WINDOW_BYTES, info.size - FAST_IDENTITY_WINDOW_BYTES)
      const tail = Buffer.allocUnsafe(tailSize)
      const { bytesRead } = await handle.read(tail, 0, tailSize, info.size - tailSize)
      digest.update(tail.subarray(0, bytesRead))
    }
    return {
      byte_size: info.size,
      mtime_ms: info.mtimeMs,
      file_id: Number.isSafeInteger(info.dev) && Number.isSafeInteger(info.ino) ? `${info.dev}:${info.ino}` : undefined,
      head_tail_hash: `sha256:${digest.digest('hex')}`,
    }
  } finally {
    await handle.close()
  }
}

function normalizedRotation(stream: FfprobeStream): number {
  const rotationRaw = (stream.tags as Record<string, unknown> | undefined)?.rotate
    ?? (Array.isArray(stream.side_data_list)
      ? (stream.side_data_list as Array<Record<string, unknown>>).find(item => item.rotation !== undefined)?.rotation
      : undefined)
  const rotation = Number(rotationRaw)
  return Number.isFinite(rotation) ? ((Math.trunc(rotation) % 360) + 360) % 360 : 0
}

function streamTimeBase(stream: FfprobeStream, fallback: MediaTimeBase): MediaTimeBase {
  const raw = rationalFromFfprobe(stream.time_base, 'stream time_base')
  return raw ? mediaTimeBase(raw.num, raw.den) : fallback
}

function streamTime(stream: FfprobeStream, field: 'start' | 'duration', tickRate: Rational, fallback: unknown): RationalTime | undefined {
  const ticks = asInt64FromFfprobe(stream[field === 'start' ? 'start_pts' : 'duration_ts'])
  if (ticks !== undefined) return rationalTime(ticks, tickRate)
  return rationalTimeFromDecimalSeconds(stream[field === 'start' ? 'start_time' : 'duration'], tickRate, field === 'start' ? 'nearest' : 'ceil')
    ?? rationalTimeFromDecimalSeconds(fallback, tickRate, field === 'start' ? 'nearest' : 'ceil')
}

function validRate(value: unknown): Rational | undefined {
  try {
    return rationalFromFfprobe(value, 'frame rate')
  } catch {
    return undefined
  }
}

function ffprobeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Only transfers with an explicit HDR meaning may enter the tone-map path. */
function hdrKindFromFfprobe(stream: FfprobeStream): 'sdr' | 'pq' | 'hlg' | 'unknown' {
  const transfer = ffprobeString(stream.color_transfer)?.toLowerCase()
  if (!transfer) return 'unknown'
  if (transfer === 'smpte2084' || transfer === 'pq' || transfer.includes('2084')) return 'pq'
  if (transfer === 'arib-std-b67' || transfer === 'hlg' || transfer.includes('b67')) return 'hlg'
  // ffprobe may report `unknown`, `unspecified`, reserved values, or a
  // transfer characteristic newer than this renderer understands.  Treating
  // any of those as SDR would turn a missing color fact into a destructive
  // delivery decision.  Only a small, explicit SDR set is safe to compile.
  if (new Set([
    'bt709',
    'bt470m',
    'bt470bg',
    'smpte170m',
    'smpte240m',
    'iec61966-2-1',
    'iec61966-2-4',
    'gamma22',
    'gamma28',
  ]).has(transfer)) return 'sdr'
  return 'unknown'
}

/** FFprobe is read once; every raw PTS/time-base fact is retained losslessly. */
export async function probeVideoFactSource(input: {
  id: string
  projectId: string
  path: string
  name: string
  now: string
  runProcess: VideoProcessRunner
  ffprobe: string
}): Promise<VideoFactSource> {
  const result = await input.runProcess([input.ffprobe, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input.path])
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `ffprobe exited ${result.exitCode}`)
  const metadata = JSON.parse(result.stdout) as FfprobeMetadata
  const allStreams = metadata.streams ?? []
  const videoStreams = allStreams.filter(stream => stream.codec_type === 'video')
  const audioStreams = allStreams.filter(stream => stream.codec_type === 'audio')
  const primary = videoStreams[0]
  if (!primary) throw new Error('素材中没有视频轨道')
  const timeBase = streamTimeBase(primary, mediaTimeBase(1, 1000))
  const tickRate = tickRateForTimeBase(timeBase)
  const start = streamTime(primary, 'start', tickRate, metadata.format?.start_time) ?? rationalTime('0', tickRate)
  const duration = streamTime(primary, 'duration', tickRate, metadata.format?.duration) ?? rationalTime('0', tickRate)
  if (BigInt(duration.ticks) <= 0n) throw new Error('素材没有可用的视频时长')
  const averageRate = validRate(primary.avg_frame_rate)
  const nominalRate = validRate(primary.r_frame_rate)
  const audioTracks = audioStreams.map((stream, index) => {
    const sampleRate = Number(stream.sample_rate)
    const audioTimeBase = streamTimeBase(stream, mediaTimeBase(1, Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate : 48_000))
    const audioTickRate = tickRateForTimeBase(audioTimeBase)
    const tags = stream.tags as Record<string, unknown> | undefined
    const disposition = stream.disposition as Record<string, unknown> | undefined
    const duration = streamTime(stream, 'duration', audioTickRate, metadata.format?.duration)
    return {
      stream_index: Number.isSafeInteger(stream.index) && Number(stream.index) >= 0 ? Number(stream.index) : index,
      time_base: audioTimeBase,
      start_time: streamTime(stream, 'start', audioTickRate, metadata.format?.start_time) ?? rationalTime('0', audioTickRate),
      ...(duration ? { duration } : {}),
      codec: typeof stream.codec_name === 'string' && stream.codec_name ? stream.codec_name : 'unknown',
      sample_rate: Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate : 48_000,
      channels: Number.isSafeInteger(stream.channels) && Number(stream.channels) > 0 ? Number(stream.channels) : 1,
      ...(typeof stream.channel_layout === 'string' && stream.channel_layout ? { channel_layout: stream.channel_layout } : {}),
      ...(typeof tags?.language === 'string' && tags.language ? { language: tags.language } : {}),
      ...(typeof tags?.title === 'string' && tags.title ? { title: tags.title } : {}),
      disposition_default: Number(disposition?.default) === 1,
    }
  })
  return {
    id: input.id,
    project_id: input.projectId,
    path: input.path,
    name: input.name,
    fast_identity: await fastVideoIdentity(input.path),
    fingerprint_state: 'pending',
    primary_video_stream: {
      stream_index: Number.isSafeInteger(primary.index) && Number(primary.index) >= 0 ? Number(primary.index) : 0,
      time_base: timeBase,
      start_time: start,
      duration,
      codec: typeof primary.codec_name === 'string' && primary.codec_name ? primary.codec_name : 'unknown',
      width: Number.isSafeInteger(primary.width) && Number(primary.width) > 0 ? Number(primary.width) : 1,
      height: Number.isSafeInteger(primary.height) && Number(primary.height) > 0 ? Number(primary.height) : 1,
      rotation: normalizedRotation(primary),
      ...(ffprobeString(primary.color_space) ? { color_space: ffprobeString(primary.color_space) } : {}),
      ...(ffprobeString(primary.color_transfer) ? { color_transfer: ffprobeString(primary.color_transfer) } : {}),
      ...(ffprobeString(primary.color_primaries) ? { color_primaries: ffprobeString(primary.color_primaries) } : {}),
      ...(ffprobeString(primary.color_range) ? { color_range: ffprobeString(primary.color_range) } : {}),
      ...(ffprobeString(primary.pix_fmt) ? { pixel_format: ffprobeString(primary.pix_fmt) } : {}),
      hdr_kind: hdrKindFromFfprobe(primary),
      ...(averageRate ? { average_frame_rate: frameRate(averageRate.num, averageRate.den) } : {}),
      ...(nominalRate ? { nominal_frame_rate: frameRate(nominalRate.num, nominalRate.den) } : {}),
      variable_frame_rate: Boolean(averageRate && nominalRate && (averageRate.num !== nominalRate.num || averageRate.den !== nominalRate.den)),
    },
    presentation_duration: duration,
    audio_tracks: audioTracks,
    state: 'ready',
    created_at: input.now,
    updated_at: input.now,
  }
}

export type VerifiedVideoOutput = {
  content_hash: `sha256:${string}`
  byte_size: number
  file_mtime_ms: number
  duration_ms: number
  video_stream_count: number
  audio_stream_count: number
  width?: number
  height?: number
  fps?: number
  container?: 'mp4' | 'mov'
  video_codec?: 'h264' | 'prores_422'
  prores_profile?: 'standard' | 'hq'
  audio_codec?: 'aac_lc' | 'pcm_s16le'
  pixel_format?: 'yuv420p' | 'yuv422p10le'
  color_range?: 'sdr_bt709'
  audio_sample_rate?: number
  audio_channels?: number
  audio_channel_layout?: string
  sample_aspect_ratio?: string
  display_aspect_ratio?: string
  rotation?: number
  audio_video_duration_delta_ms?: number
}

export type DeliveryOutputVerification = VerifiedVideoOutput & {
  decoded: boolean
  packet_timestamps_monotonic: boolean
  expected_duration_ms: number
  duration_delta_ms: number
  /** Full-output blackdetect result; retained in the output-verify receipt. */
  black_duration_ms: number
  black_ratio: number
  /** Full-output silencedetect result; retained in the output-verify receipt. */
  silence_duration_ms: number
  silence_ratio: number
}

export const FALLBACK_VIDEO_ENCODER: VideoEncoderProfile = {
  name: 'mpeg4',
  args: ['-q:v', '3'],
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (value.includes('/')) {
    const [left, right] = value.split('/').map(Number)
    if (!Number.isFinite(left) || !Number.isFinite(right) || !right) return undefined
    return Math.round((left! / right!) * 1000) / 1000
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3)
}

/** ExecutionPlan uses rational seconds, unlike the legacy clip renderer's milliseconds. */
function planTimeSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('ExecutionPlan 秒数无效')
  return value.toFixed(6)
}

export function videoBinary(
  name: 'ffmpeg' | 'ffprobe',
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string {
  const explicit = env[name === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN']?.trim()
  if (explicit) return explicit
  const directory = env.BB_MEDIA_BIN_DIR?.trim()
  if (directory) return `${directory}/${platform === 'win32' ? `${name}.exe` : name}`
  return name
}

export async function defaultVideoProcessRunner(
  command: string[],
  options: { signal?: AbortSignal } = {},
): Promise<VideoProcessResult> {
  const process = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.signal,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

export async function videoToolchainStatus(
  runProcess: VideoProcessRunner,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<{ ffmpeg: { available: boolean; command: string }; ffprobe: { available: boolean; command: string } }> {
  const check = async (name: 'ffmpeg' | 'ffprobe') => {
    const command = videoBinary(name, env, platform)
    if (isAbsolute(command) && !existsSync(command)) return { available: false, command }
    try {
      return { available: (await runProcess([command, '-version'])).exitCode === 0, command }
    } catch {
      return { available: false, command }
    }
  }
  const [ffmpeg, ffprobe] = await Promise.all([check('ffmpeg'), check('ffprobe')])
  return { ffmpeg, ffprobe }
}

export async function selectVideoEncoder(
  runProcess: VideoProcessRunner,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Promise<VideoEncoderProfile> {
  const ffmpeg = videoBinary('ffmpeg', env, platform)
  const result = await runProcess([ffmpeg, '-hide_banner', '-encoders']).catch(() => null)
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  const has = (name: string) => new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(output)
  const explicit = env.BB_FFMPEG_VIDEO_ENCODER?.trim()
  if (explicit) {
    if (!['h264_videotoolbox', 'h264_mf', 'libx264', 'mpeg4'].includes(explicit) || !has(explicit)) {
      throw new Error('指定的视频编码器不可用')
    }
    return explicit === 'mpeg4' ? FALLBACK_VIDEO_ENCODER : { name: explicit as VideoEncoderProfile['name'], args: ['-b:v', '8M'] }
  }
  if (platform === 'darwin' && has('h264_videotoolbox')) return { name: 'h264_videotoolbox', args: ['-b:v', '8M'] }
  if (platform === 'win32' && has('h264_mf')) return { name: 'h264_mf', args: ['-b:v', '8M'] }
  if (has('libx264')) return { name: 'libx264', args: ['-crf', '20', '-preset', 'medium'] }
  return FALLBACK_VIDEO_ENCODER
}

/**
 * Delivery exports may fall back from a hardware H.264 encoder only to the
 * software H.264 implementation.  MPEG-4 is retained for old preview
 * compatibility, but is never an equivalent formal-delivery fallback.
 */
export async function selectDeliveryVideoEncoder(
  runProcess: VideoProcessRunner,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  profile: VideoExportProfileRevision,
  options: { forceSoftware?: boolean; fallbackFrom?: 'h264_videotoolbox' | 'h264_mf' } = {},
): Promise<DeliveryVideoEncoderProfile> {
  const ffmpeg = videoBinary('ffmpeg', env, platform)
  const result = await runProcess([ffmpeg, '-hide_banner', '-encoders']).catch(() => null)
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  const has = (name: string) => new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(output)
  const explicit = env.BB_FFMPEG_VIDEO_ENCODER?.trim()
  if (profile.encoding.video.codec === 'prores_422') {
    if (explicit && explicit !== 'prores_ks') throw new Error('指定的视频编码器不符合冻结的 ProRes Profile')
    if (!has('prores_ks')) throw new Error('当前 FFmpeg 不支持 ProRes 422 导出')
    return {
      name: 'prores_ks',
      profile_codec: 'prores_422',
      args: ['-profile:v', profile.encoding.video.quality.profile === 'hq' ? '3' : '2', '-pix_fmt', 'yuv422p10le'],
    }
  }
  const allowed = ['h264_videotoolbox', 'h264_mf', 'libx264']
  if (explicit && !allowed.includes(explicit)) throw new Error('指定的视频编码器不符合冻结的 H.264 Profile')
  // The formal H.264 Profile freezes libx264's CRF and preset semantics.  A
  // fixed hardware bitrate is not an equivalent mapping: its rate-control and
  // quality range are encoder/platform dependent.  Until a reviewed, complete
  // per-encoder mapping is introduced, hardware selection must fail closed
  // rather than silently emit a different delivery contract.
  if (explicit === 'h264_videotoolbox' || explicit === 'h264_mf') {
    throw new Error('冻结的 H.264 CRF/preset 质量合同不支持硬件编码器；请使用 libx264')
  }
  if (!has('libx264')) {
    const hardwareAvailable = (platform === 'darwin' && has('h264_videotoolbox'))
      || (platform === 'win32' && has('h264_mf'))
    if (hardwareAvailable && !options.forceSoftware) {
      throw new Error('当前仅有硬件 H.264 编码器，无法等价执行冻结的 CRF/preset 质量合同')
    }
    throw new Error('当前 FFmpeg 不支持冻结 H.264 Profile 所需的 libx264 编码器')
  }
  const quality = profile.encoding.video.quality
  return {
    name: 'libx264',
    profile_codec: 'h264',
    args: ['-crf', String(quality.value), '-preset', quality.preset],
    ...(options.fallbackFrom ? { fallback_from: options.fallbackFrom } : {}),
  }
}

export function buildVideoRenderCommand(
  ffmpeg: string,
  project: VideoStudioProject,
  outputPath: string,
  encoder: VideoEncoderProfile = FALLBACK_VIDEO_ENCODER,
): string[] {
  const sources = new Map(project.sources.map(source => [source.id, source]))
  const inputs: string[] = []
  const filters: string[] = []
  const concatInputs: string[] = []
  const { width, height, fps } = project.output
  project.timeline.forEach((clip, index) => {
    const source = sources.get(clip.source_id)
    if (!source) throw new Error(`素材不存在: ${clip.source_id}`)
    const duration = clip.out_ms - clip.in_ms
    inputs.push('-ss', seconds(clip.in_ms), '-t', seconds(duration), '-i', source.path)
    filters.push(
      `[${index}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`,
    )
    if (source.has_audio) {
      filters.push(
        `[${index}:a]asetpts=PTS-STARTPTS,aresample=48000,`
        + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`,
      )
    } else {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${seconds(duration)}[a${index}]`)
    }
    concatInputs.push(`[v${index}][a${index}]`)
  })
  if (concatInputs.length === 0) throw new Error('时间线为空')
  filters.push(`${concatInputs.join('')}concat=n=${project.timeline.length}:v=1:a=1[vout][aout]`)
  return [
    ffmpeg, '-hide_banner', '-y', ...inputs,
    '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]',
    '-c:v', encoder.name, ...encoder.args, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath,
  ]
}

function planSeconds(value: { ticks: string; tick_rate: { num: number; den: number } }): number {
  const ticks = Number(value.ticks)
  if (!Number.isSafeInteger(ticks) || !Number.isSafeInteger(value.tick_rate.num) || !Number.isSafeInteger(value.tick_rate.den) || value.tick_rate.num <= 0 || value.tick_rate.den <= 0) {
    throw new Error('ExecutionPlan 时间戳不可安全执行')
  }
  return ticks * value.tick_rate.den / value.tick_rate.num
}

function atempoFilters(speed: number, input: string, output: string): string {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('ExecutionPlan speed 无效')
  const factors: number[] = []
  let remaining = speed
  while (remaining > 2) { factors.push(2); remaining /= 2 }
  while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5 }
  factors.push(remaining)
  return `${input}${factors.map(factor => `atempo=${factor.toFixed(8)}`).join(',')}${output}`
}

function numericExpression(
  keyframes: Array<{
    at: { ticks: string; tick_rate: { num: number; den: number } }
    value: number
    interpolation?: 'hold' | 'linear' | 'bezier'
  }>,
  timelineStart: { ticks: string; tick_rate: { num: number; den: number } },
  fallback: number,
): string {
  const values = keyframes.map(keyframe => ({
    at: Math.max(0, planSeconds(keyframe.at) - planSeconds(timelineStart)),
    value: keyframe.value,
    interpolation: keyframe.interpolation ?? 'linear',
  }))
    .sort((left, right) => left.at - right.at)
  if (!values.length) return String(fallback)
  let expression = String(values[0]!.value)
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!
    const next = values[index]!
    if (previous.interpolation === 'bezier') throw new Error('ExecutionPlan 包含尚未实现的 bezier 关键帧')
    const duration = Math.max(0.000001, next.at - previous.at)
    const interpolated = previous.interpolation === 'hold'
      ? String(previous.value)
      : `(${previous.value}+(${next.value}-${previous.value})*(t-${previous.at})/${duration})`
    expression = `if(lt(t,${next.at}),${interpolated},${next.value})`
  }
  return expression
}

function filterValue(value: string): string {
  return value.replace(/([\\':,;\[\]])/g, '\\$1')
}

function assColor(hex: string): string {
  const value = hex.replace('#', '')
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}&`
}

function subtitleTimestamp(value: { ticks: string; tick_rate: { num: number; den: number } }, vtt = false): string {
  const milliseconds = Math.max(0, Math.round(planSeconds(value) * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds % 3_600_000 / 60_000)
  const secondsValue = Math.floor(milliseconds % 60_000 / 1000)
  const fraction = milliseconds % 1000
  const separator = vtt ? '.' : ','
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secondsValue).padStart(2, '0')}${separator}${String(fraction).padStart(3, '0')}`
}

function captionGlyphWidth(character: string, fontSize: number): number {
  if (/\s/u.test(character)) return fontSize * 0.32
  if (/^[\u0000-\u024f]$/u.test(character)) return fontSize * 0.56
  return fontSize
}

function captionLineWidth(characters: readonly string[], fontSize: number): number {
  return characters.reduce((width, character) => width + captionGlyphWidth(character, fontSize), 0)
}

/** Hard-wrap before libass so SRT, VTT and burn-in all honor max_width. */
function wrapCaptionLine(line: string, maxPixels: number, fontSize: number): string[] {
  const characters = [...line]
  if (!characters.length) return ['']
  const lines: string[] = []
  let current: string[] = []
  let currentWidth = 0
  let lastWhitespace = -1
  for (const character of characters) {
    const width = captionGlyphWidth(character, fontSize)
    if (current.length && currentWidth + width > maxPixels) {
      if (lastWhitespace > 0) {
        const completed = current.slice(0, lastWhitespace).join('').trimEnd()
        if (completed) lines.push(completed)
        current = current.slice(lastWhitespace + 1)
      } else {
        lines.push(current.join('').trimEnd())
        current = []
      }
      currentWidth = captionLineWidth(current, fontSize)
      lastWhitespace = current.map((value, index) => /\s/u.test(value) ? index : -1).reduce((latest, index) => Math.max(latest, index), -1)
    }
    current.push(character)
    currentWidth += width
    if (/\s/u.test(character)) lastWhitespace = current.length - 1
  }
  const completed = current.join('').trimEnd()
  if (completed || !lines.length) lines.push(completed)
  return lines
}

function formattedCaptionText(text: string, plan: VideoExecutionPlan): string {
  const caption = plan.caption!
  const maxPixels = Math.floor(plan.encoder.width * caption.style.max_width)
  return text.replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap(line => wrapCaptionLine(line, maxPixels, caption.style.font_size))
    .join('\n')
}

function assertExecutionPlanCaption(plan: VideoExecutionPlan): void {
  const caption = plan.caption
  if (!caption) return
  const issues = inspectCaptionDelivery(caption.style, caption.cues, { width: plan.encoder.width, height: plan.encoder.height })
  if (issues.length) throw new Error(issues[0]!.message)
  const planEnd = plan.timeline_items
    .filter(item => item.kind === 'video' && item.track_kind === 'primary_video')
    .reduce((latest, item) => Math.max(latest, planSeconds(item.timeline_range.start) + planSeconds(item.timeline_range.duration)), 0)
  const cues = [...caption.cues].sort((left, right) => planSeconds(left.timeline_range.start) - planSeconds(right.timeline_range.start))
  for (const cue of cues) {
    const start = planSeconds(cue.timeline_range.start)
    const duration = planSeconds(cue.timeline_range.duration)
    if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 || start + duration > planEnd + 0.002) {
      throw new Error('ExecutionPlan 字幕 Cue 超出冻结时间线范围')
    }
  }
  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1]!
    const current = cues[index]!
    if (planSeconds(current.timeline_range.start) < planSeconds(previous.timeline_range.start) + planSeconds(previous.timeline_range.duration) - 0.000_001) {
      throw new Error('ExecutionPlan 字幕 Cue 不能重叠')
    }
  }
}

/** Writes the exact frozen caption revision used by a preview or render. */
export async function writeExecutionPlanCaption(plan: VideoExecutionPlan, path: string, format: 'srt' | 'vtt' = 'srt'): Promise<{ content_hash: `sha256:${string}`; byte_size: number } | null> {
  if (!plan.caption) return null
  assertExecutionPlanCaption(plan)
  const vtt = format === 'vtt'
  const body = [
    ...(vtt ? ['WEBVTT', ''] : []),
    ...plan.caption.cues.flatMap((cue, index) => [
      String(index + 1),
      `${subtitleTimestamp(cue.timeline_range.start, vtt)} --> ${subtitleTimestamp({
        ticks: (BigInt(cue.timeline_range.start.ticks) + BigInt(cue.timeline_range.duration.ticks)).toString(),
        tick_rate: cue.timeline_range.start.tick_rate,
      }, vtt)}`,
      formattedCaptionText(cue.text, plan),
      '',
    ]),
  ].join('\n')
  const bytes = new TextEncoder().encode(body)
  await writeFile(path, bytes, { mode: 0o600 })
  return { content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byte_size: bytes.byteLength }
}

export type ExecutionPlanProjectAsset = {
  path: string
  content_hash: `sha256:${string}`
  mime_type?: string
}

export type ExecutionPlanRenderOptions = {
  burnInCaptionPath?: string
  /** Absolute directory containing the same reviewed font face as Relay. */
  burnInCaptionFontDirectory?: string
  /** Resolved by the service only after managed-path, hash and license checks. */
  projectAssets?: ReadonlyMap<string, ExecutionPlanProjectAsset>
}

function assetLooksLikeImage(asset: ExecutionPlanProjectAsset): boolean {
  return asset.mime_type?.startsWith('image/') === true || /\.(?:avif|gif|jpe?g|png|webp)$/i.test(asset.path)
}

/**
 * Compile the frozen v2 ExecutionPlan directly to FFmpeg. Timeline order,
 * placement, audio policy and every asset binding are explicit in the plan;
 * this function never projects a legacy scene list or dereferences a URL.
 */
export function buildExecutionPlanRenderCommand(
  ffmpeg: string,
  project: VideoStudioProject,
  plan: VideoExecutionPlan,
  outputPath: string,
  encoder: VideoEncoderProfile = FALLBACK_VIDEO_ENCODER,
  options: ExecutionPlanRenderOptions = {},
): string[] {
  const items = [...plan.timeline_items].sort((left, right) => left.order - right.order)
  type PlanItem = VideoExecutionPlan['timeline_items'][number]
  type SourcePlanItem = PlanItem & { binding: Extract<PlanItem['binding'], { kind: 'source' }> }
  const videos = items.filter((item): item is SourcePlanItem => item.kind === 'video' && item.track_kind === 'primary_video' && item.binding.kind === 'source')
  if (!videos.length) throw new Error('ExecutionPlan 缺少主视频条目')
  if (items.some(item => item.kind === 'video' && item.track_kind === 'primary_video' && item.binding.kind !== 'source')) {
    throw new Error('主视频轨只能引用已校验的源素材')
  }
  if (items.some(item => item.track_kind === 'music' && item.binding.kind !== 'project_asset')) {
    throw new Error('音乐轨只能引用已受管并声明许可的项目资产')
  }
  assertExecutionPlanCaption(plan)
  if (plan.caption?.mode === 'burn_in' && !options.burnInCaptionPath) throw new Error('ExecutionPlan 烧录字幕缺少冻结的字幕文件')
  if (plan.caption?.mode === 'burn_in' && (!options.burnInCaptionFontDirectory || !isAbsolute(options.burnInCaptionFontDirectory))) {
    throw new Error('ExecutionPlan 烧录字幕缺少受控字体目录')
  }
  const sourceById = new Map(project.sources.map(source => [source.id, source]))
  type SourceExecutionInput = Extract<VideoExecutionPlan['inputs'][number], { kind: 'source' }>
  type ProjectAssetExecutionInput = Extract<VideoExecutionPlan['inputs'][number], { kind: 'project_asset' }>
  const sourceInputs = new Map<string, SourceExecutionInput>()
  const projectAssetInputs = new Map<string, ProjectAssetExecutionInput>()
  for (const input of plan.inputs) {
    if (input.kind === 'source') {
      const key = `${input.source_id}\0${input.source_fingerprint}`
      const previous = sourceInputs.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(input)) {
        throw new Error('ExecutionPlan 对同一素材冻结了冲突的原始流输入')
      }
      sourceInputs.set(key, input)
      continue
    }
    if (input.kind === 'project_asset') {
      const key = `${input.asset_id}\0${input.asset_content_hash}`
      const previous = projectAssetInputs.get(key)
      if (previous && JSON.stringify(previous.video_color) !== JSON.stringify(input.video_color)) {
        throw new Error('ExecutionPlan 对同一项目视频资产冻结了冲突的颜色特征')
      }
      projectAssetInputs.set(key, input)
    }
  }
  const transformByItem = new Map(plan.filters.filter((filter): filter is Extract<typeof filter, { kind: 'transform' }> => filter.kind === 'transform').map(filter => [filter.item_id, filter]))
  const volumeByItem = new Map(plan.filters.filter((filter): filter is Extract<typeof filter, { kind: 'volume' }> => filter.kind === 'volume').map(filter => [filter.item_id, filter]))
  const denoiseByItem = new Map(plan.filters.filter((filter): filter is Extract<typeof filter, { kind: 'audio_denoise' }> => filter.kind === 'audio_denoise').map(filter => [filter.item_id, filter]))
  const fadeByItem = new Map(plan.filters.filter((filter): filter is Extract<typeof filter, { kind: 'audio_fade' }> => filter.kind === 'audio_fade').map(filter => [filter.item_id, filter]))
  const inputs: string[] = []; const filters: string[] = []; const videoConcat: string[] = []
  let inputCount = 0
  const width = plan.encoder.width; const height = plan.encoder.height
  const targetAspect = (width / height).toFixed(12)
  const fps = plan.encoder.frame_rate.num / plan.encoder.frame_rate.den
  const channelLayout = plan.audio_pipeline.channels === 1 ? 'mono' : 'stereo'
  const timelineDuration = items.reduce((latest, item) => Math.max(latest, planSeconds(item.timeline_range.start) + planSeconds(item.timeline_range.duration)), 0)
  if (!Number.isFinite(timelineDuration) || timelineDuration <= 0) throw new Error('ExecutionPlan 没有有效的时间线时长')

  type ResolvedInput = {
    path: string
    start: number
    duration: number
    image: boolean
    speed: number
    audioStreamIndex?: number
    hdrKind: 'sdr' | 'pq' | 'hlg' | 'unknown'
  }
  const resolvedInput = (item: PlanItem): ResolvedInput => {
    const timelineItemDuration = planSeconds(item.timeline_range.duration)
    const speed = item.speed ? item.speed.num / item.speed.den : 1
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('ExecutionPlan speed 无效')
    if (item.binding.kind === 'source') {
      const binding = item.binding
      const source = sourceById.get(binding.source_id)
      if (!source || source.fingerprint !== binding.source_fingerprint || source.content_changed || source.missing) {
        throw new Error(`ExecutionPlan 素材不可用: ${binding.source_id}`)
      }
      const sourceInput = sourceInputs.get(`${binding.source_id}\0${binding.source_fingerprint}`)
      if (!sourceInput) throw new Error('ExecutionPlan 缺少冻结的原始流输入')
      const duration = planSeconds(binding.source_range.duration)
      if (Math.abs(duration / speed - timelineItemDuration) > 0.002) throw new Error('ExecutionPlan speed 与范围不一致')
      const sourceRangeStart = planSeconds(binding.source_range.start)
      if (item.kind === 'audio' && item.track_kind === 'source_audio') {
        if (sourceInput.audio_stream_index === undefined
          || !sourceInput.audio_start
          || !sourceInput.audio_duration
          || sourceInput.audio_sample_rate === undefined
          || sourceInput.audio_channels === undefined) {
          throw new Error('ExecutionPlan 源音频缺少冻结的流映射或 PTS 边界')
        }
        const audioStart = planSeconds(sourceInput.audio_start)
        const audioEnd = audioStart + planSeconds(sourceInput.audio_duration)
        if (sourceRangeStart + 0.000001 < audioStart || sourceRangeStart + duration > audioEnd + 0.000001) {
          throw new Error('ExecutionPlan 源音频范围超出冻结的音频流边界')
        }
        if (sourceRangeStart < 0) throw new Error('ExecutionPlan 源音频 PTS 不能安全映射为输入 seek 位置')
        return {
          path: source.path,
          // Input -ss is measured against the source presentation clock.  A
          // stream beginning after zero must retain that PTS offset; otherwise
          // -t cuts the selected audio short by the stream start delta.
          start: sourceRangeStart,
          duration,
          image: false,
          speed,
          audioStreamIndex: sourceInput.audio_stream_index,
          hdrKind: sourceInput.video_color?.hdr_kind ?? 'unknown',
        }
      }
      const sourceStart = planSeconds(sourceInput.source_start)
      if (sourceRangeStart + 0.000001 < sourceStart || sourceRangeStart < 0) {
        throw new Error('ExecutionPlan 源视频 PTS 不能安全映射为输入 seek 位置')
      }
      return { path: source.path, start: sourceRangeStart, duration, image: false, speed, hdrKind: sourceInput.video_color?.hdr_kind ?? 'unknown' }
    }
    if (item.binding.kind === 'project_asset') {
      const asset = options.projectAssets?.get(item.binding.asset_id)
      if (!asset || asset.content_hash !== item.binding.asset_content_hash) {
        throw new Error(`ExecutionPlan 项目资产不可用或哈希不匹配: ${item.binding.asset_id}`)
      }
      const frozen = projectAssetInputs.get(`${item.binding.asset_id}\0${item.binding.asset_content_hash}`)
      if (!frozen) throw new Error(`ExecutionPlan 缺少项目资产冻结输入: ${item.binding.asset_id}`)
      const image = assetLooksLikeImage(asset)
      const selectedRange = frozen.source_range
      const requiresVideoColor = item.kind === 'video' || (item.track_kind === 'overlay' && !image)
      if (!image && !selectedRange) {
        throw new Error('ExecutionPlan 项目 A/V 资产缺少冻结的选取范围')
      }
      const start = selectedRange ? planSeconds(selectedRange.start) : 0
      const duration = selectedRange ? planSeconds(selectedRange.duration) : timelineItemDuration
      if (Math.abs(duration - timelineItemDuration) > 0.002) throw new Error('项目资产范围与时间线时长不一致')
      if (item.binding.source_range && selectedRange
        && (Math.abs(planSeconds(item.binding.source_range.start) - start) > 0.000001
          || Math.abs(planSeconds(item.binding.source_range.duration) - duration) > 0.000001)) {
        throw new Error('ExecutionPlan 项目资产范围与冻结输入不一致')
      }
      const color = frozen.video_color
      if (requiresVideoColor && (!color || color.hdr_kind === 'unknown')) {
        throw new Error('ExecutionPlan 项目视频资产缺少可验证的颜色特征，拒绝将其标记为 SDR')
      }
      if (requiresVideoColor) {
        if (!frozen.video_start || !frozen.video_duration) {
          throw new Error('ExecutionPlan 项目视频资产缺少冻结的原始视频流边界')
        }
        const videoStart = planSeconds(frozen.video_start)
        const videoEnd = videoStart + planSeconds(frozen.video_duration)
        if (start + 0.000001 < videoStart || start + duration > videoEnd + 0.000001) {
          throw new Error('ExecutionPlan 项目视频资产范围超出冻结的视频流边界')
        }
      }
      let audioStreamIndex: number | undefined
      if (item.kind === 'audio') {
        if (frozen.audio_stream_index === undefined
          || !frozen.audio_start
          || !frozen.audio_duration
          || frozen.audio_sample_rate === undefined
          || frozen.audio_channels === undefined) {
          throw new Error('ExecutionPlan 项目音频资产缺少冻结的流映射或 PTS 边界')
        }
        const audioStart = planSeconds(frozen.audio_start)
        const audioEnd = audioStart + planSeconds(frozen.audio_duration)
        if (start + 0.000001 < audioStart || start + duration > audioEnd + 0.000001) {
          throw new Error('ExecutionPlan 项目音频资产范围超出冻结的音频流边界')
        }
        audioStreamIndex = frozen.audio_stream_index
      }
      return {
        path: asset.path,
        start: Math.max(0, start),
        duration,
        image,
        speed: 1,
        ...(audioStreamIndex === undefined ? {} : { audioStreamIndex }),
        hdrKind: image || item.kind === 'audio' ? 'sdr' : color?.hdr_kind ?? 'unknown',
      }
    }
    throw new Error('字幕文档不能作为 FFmpeg 媒体输入')
  }
  const addInput = (item: PlanItem, media: ResolvedInput): number => {
    const inputIndex = inputCount
    inputCount += 1
    if (media.image) {
      inputs.push('-loop', '1', '-framerate', fps.toFixed(8), '-t', planTimeSeconds(planSeconds(item.timeline_range.duration)), '-i', media.path)
    } else {
      inputs.push('-ss', planTimeSeconds(media.start), '-t', planTimeSeconds(media.duration), '-i', media.path)
    }
    return inputIndex
  }
  const videoFilters = (item: PlanItem, media: ResolvedInput, inputIndex: number, output: string, timelineOffset = 0): void => {
    const transform = transformByItem.get(item.item_id)
    if (media.hdrKind === 'unknown') throw new Error('ExecutionPlan 缺少可验证的源素材颜色特征，拒绝将其标记为 SDR')
    if ((media.hdrKind === 'pq' || media.hdrKind === 'hlg') && plan.color_pipeline.hdr_input_policy === 'reject') {
      throw new Error('ExecutionPlan 的导出 Profile 拒绝 HDR/HLG/PQ 素材')
    }
    const parts = [
      ...(media.hdrKind === 'pq' || media.hdrKind === 'hlg'
        ? [
            // This is a pixel conversion, not output metadata relabeling. zscale
            // reads the retained PQ/HLG tags, linearizes, tone-maps, then writes
            // a limited-range BT.709 SDR frame for the frozen profile.
            `zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=tv,format=${plan.encoder.encoding.output_color.pixel_format}`,
          ]
        : []),
      // Parenthesize the subtraction before division. Without this, FFmpeg
      // parses `PTS-STARTPTS/2` as `PTS-(STARTPTS/2)`, leaving a zero-start
      // video at its original speed while the matching audio is retimed.
      `setpts=(PTS-STARTPTS)/${media.speed.toFixed(8)}`,
    ]
    if (transform) {
      const scale = numericExpression(transform.keyframes.map(keyframe => ({ at: keyframe.at, value: keyframe.value.scale, interpolation: keyframe.interpolation })), item.timeline_range.start, 1)
      const x = numericExpression(transform.keyframes.map(keyframe => ({ at: keyframe.at, value: keyframe.value.x, interpolation: keyframe.interpolation })), item.timeline_range.start, 0)
      const y = numericExpression(transform.keyframes.map(keyframe => ({ at: keyframe.at, value: keyframe.value.y, interpolation: keyframe.interpolation })), item.timeline_range.start, 0)
      // Reframe to the frozen output aspect before final scaling.  A transform
      // therefore produces a real crop instead of an aspect-preserving zoom
      // followed by padding/letterboxing.  `t` stays item-local here; overlays
      // receive their timeline offset only after keyframe evaluation.
      const cropWidth = `trunc(if(gte(iw/ih,${targetAspect}),ih*${targetAspect}/(${scale}),iw/(${scale}))/2)*2`
      const cropHeight = `trunc(if(gte(iw/ih,${targetAspect}),ih/(${scale}),iw/${targetAspect}/(${scale}))/2)*2`
      parts.push(`crop=w='${cropWidth}':h='${cropHeight}':x='(iw-ow)*(0.5+(${x})/2)':y='(ih-oh)*(0.5+(${y})/2)'`)
    }
    if (timelineOffset) parts.push(`setpts=PTS+${timelineOffset.toFixed(6)}/TB`)
    parts.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', `fps=${fps.toFixed(8)}`)
    filters.push(`[${inputIndex}:v]${parts.join(',')}[${output}]`)
  }

  let cursor = 0
  for (const [index, item] of videos.entries()) {
    const media = resolvedInput(item)
    const timelineStart = planSeconds(item.timeline_range.start)
    const timelineDuration = planSeconds(item.timeline_range.duration)
    if (timelineStart + 0.001 < cursor) throw new Error('ExecutionPlan 主视频时间线重叠')
    const gap = timelineStart - cursor
    if (gap > 0.001) {
      const gapIndex = `gap${index}`
      filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${gap.toFixed(6)}[v${gapIndex}]`)
      videoConcat.push(`[v${gapIndex}]`)
    }
    const inputIndex = addInput(item, media)
    videoFilters(item, media, inputIndex, `vmain${index}`)
    videoConcat.push(`[vmain${index}]`)
    cursor = timelineStart + timelineDuration
  }
  if (cursor + 0.001 < timelineDuration) {
    const gap = timelineDuration - cursor
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${gap.toFixed(6)}[vfinalgap]`)
    videoConcat.push('[vfinalgap]')
  }
  filters.push(`${videoConcat.join('')}concat=n=${videoConcat.length}:v=1:a=0[vbase]`)

  let currentVideo = 'vbase'
  const composited = items.filter(item => (item.track_kind === 'b_roll' && item.kind === 'video') || (item.track_kind === 'overlay' && item.kind === 'overlay'))
  for (const [index, item] of composited.entries()) {
    if (item.binding.kind === 'caption_document') throw new Error('视频合成条目不能引用字幕文档')
    const media = resolvedInput(item)
    const inputIndex = addInput(item, media)
    const overlayName = `voverlay${index}`
    videoFilters(item, media, inputIndex, overlayName, planSeconds(item.timeline_range.start))
    const start = planSeconds(item.timeline_range.start).toFixed(6)
    const finish = (planSeconds(item.timeline_range.start) + planSeconds(item.timeline_range.duration)).toFixed(6)
    const next = `vcomposite${index}`
    filters.push(`[${currentVideo}][${overlayName}]overlay=x=0:y=0:eof_action=pass:shortest=0:enable='between(t,${start},${finish})'[${next}]`)
    currentVideo = next
  }
  if (plan.caption?.mode === 'burn_in') {
    const caption = plan.caption
    const horizontalMargin = Math.round(plan.encoder.width * (1 - caption.style.max_width) / 2)
    const style = `FontName=${filterValue(caption.style.font_family)},FontSize=${caption.style.font_size},PrimaryColour=${assColor(caption.style.fill)},OutlineColour=${assColor(caption.style.outline_fill)},Outline=${caption.style.outline_width},Alignment=2,MarginL=${horizontalMargin},MarginR=${horizontalMargin},MarginV=${Math.round(plan.encoder.height * caption.style.bottom_safe_area)},WrapStyle=0`
    filters.push(`[${currentVideo}]subtitles=filename='${filterValue(options.burnInCaptionPath!)}':fontsdir='${filterValue(options.burnInCaptionFontDirectory!)}':force_style='${style}'[vcaption]`)
    currentVideo = 'vcaption'
  }
  // Every video path, including burn-in, must terminate at the label mapped
  // below.  Leaving the subtitle output as an internal label makes FFmpeg
  // reject the render with "Output with label 'vout' does not exist".
  if (currentVideo !== 'vout') {
    filters.push(`[${currentVideo}]null[vout]`)
  }

  const sourceAudio = items.filter(item => item.kind === 'audio' && item.track_kind === 'source_audio')
  const music = items.filter(item => item.kind === 'audio' && item.track_kind === 'music')
  if (plan.audio_pipeline.policy === 'source_only' && music.length) throw new Error('冻结音频策略为 source_only，不能编译音乐轨')
  if (plan.audio_pipeline.policy === 'music_only' && !music.length) throw new Error('冻结音频策略为 music_only，但时间线没有音乐条目')
  const audioItems = plan.audio_pipeline.policy === 'source_only'
    ? sourceAudio
    : plan.audio_pipeline.policy === 'music_only'
      ? music
      : [...sourceAudio, ...music]
  const audioLabels: string[] = []
  for (const [index, item] of audioItems.entries()) {
    if (item.binding.kind === 'caption_document') throw new Error('音频条目不能引用字幕文档')
    const media = resolvedInput(item)
    if (media.image) throw new Error('图像项目资产不能作为音频轨')
    const inputIndex = addInput(item, media)
    const duration = planSeconds(item.timeline_range.duration)
    const sourceParts = [`atrim=duration=${media.duration.toFixed(6)}`, 'asetpts=PTS-STARTPTS', 'aresample=48000', `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=${channelLayout}`]
    const denoise = denoiseByItem.get(item.item_id)
    if (denoise) {
      // `afftdn` is probed by the Sidecar before preflight/render.  Do not
      // replace it with a best-effort alternative: a frozen plan must either
      // get this exact conservative treatment or fail closed.
      sourceParts.push(`afftdn=nr=${denoise.noise_reduction_db.toFixed(2)}:nf=-45:tn=1`)
    }
    const raw = `araw${index}`
    const audioInput = media.audioStreamIndex === undefined ? `[${inputIndex}:a]` : `[${inputIndex}:${media.audioStreamIndex}]`
    const tempo = media.speed === 1
      ? `${audioInput}${sourceParts.join(',')}[${raw}]`
      : atempoFilters(media.speed, `${audioInput}${sourceParts.join(',')},`, `[${raw}]`)
    filters.push(tempo)
    // Source-domain cleanup precedes tempo; every creative automation below
    // is expressed in item-local timeline seconds and therefore must run
    // after atempo.  Otherwise a 2x clip places a one-second outro fade in
    // the middle of the delivered timeline.
    const timelineParts: string[] = []
    const volume = volumeByItem.get(item.item_id)
    if (volume) timelineParts.push(`volume='${numericExpression(volume.keyframes, item.timeline_range.start, 1)}':eval=frame`)
    const fade = fadeByItem.get(item.item_id)
    if (fade?.fade_in) timelineParts.push(`afade=t=in:st=0:d=${planSeconds(fade.fade_in).toFixed(6)}`)
    if (fade?.fade_out) {
      const start = Math.max(0, duration - planSeconds(fade.fade_out))
      timelineParts.push(`afade=t=out:st=${start.toFixed(6)}:d=${planSeconds(fade.fade_out).toFixed(6)}`)
    }
    const processed = `aprocessed${index}`
    filters.push(`[${raw}]${timelineParts.length ? timelineParts.join(',') : 'anull'}[${processed}]`)
    const output = `aitem${index}`
    const delayMs = Math.max(0, Math.round(planSeconds(item.timeline_range.start) * 1_000))
    // `asetpts` alone shifts timestamps but does not generate samples before
    // a late item or after a short item.  Players and the output verifier then
    // observe a shorter audio stream than the video.  Build a full-duration
    // timeline signal for every selected item: delay supplies leading silence,
    // apad supplies the tail, and the final trim makes the contract exact.
    filters.push(`[${processed}]adelay=${delayMs}:all=1,apad=whole_dur=${timelineDuration.toFixed(6)},atrim=duration=${timelineDuration.toFixed(6)},asetpts=PTS-STARTPTS[${output}]`)
    audioLabels.push(`[${output}]`)
  }
  if (!audioLabels.length) {
    filters.push(`anullsrc=channel_layout=${channelLayout}:sample_rate=48000,atrim=duration=${timelineDuration.toFixed(6)}[aout]`)
  } else if (audioLabels.length === 1) {
    filters.push(`${audioLabels[0]}atrim=duration=${timelineDuration.toFixed(6)}[aout]`)
  } else {
    filters.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,atrim=duration=${timelineDuration.toFixed(6)}[aout]`)
  }
  const audioArgs = plan.encoder.encoding.audio.codec === 'aac_lc'
    ? ['-c:a', 'aac', '-ar', '48000', '-ac', String(plan.encoder.encoding.audio.channels), '-b:a', '192k']
    : ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', String(plan.encoder.encoding.audio.channels)]
  const outputArgs = [
    '-c:v', encoder.name, ...encoder.args,
    '-pix_fmt', plan.encoder.encoding.output_color.pixel_format,
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...audioArgs,
    ...(plan.encoder.encoding.container === 'mp4' ? ['-movflags', '+faststart'] : []),
    outputPath,
  ]
  return [
    ffmpeg, '-hide_banner', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]',
    ...outputArgs,
  ]
}

export async function videoFingerprint(path: string): Promise<`sha256:${string}`> {
  const inspected = await new ContentAddressedStore().inspect(path)
  if (!inspected) throw new Error('视频素材不存在或不可读取')
  return inspected.content_hash
}

export async function verifyVideoOutput(
  path: string,
  runProcess: VideoProcessRunner,
  ffprobe: string,
): Promise<VerifiedVideoOutput> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size <= 0) throw new Error('导出文件不存在或为空')
  const result = await runProcess([ffprobe, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  if (result.exitCode !== 0) throw new Error('导出文件无法通过 ffprobe 校验')
  const metadata = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: unknown
      codec_name?: unknown
      profile?: unknown
      width?: unknown
      height?: unknown
      avg_frame_rate?: unknown
      r_frame_rate?: unknown
      pix_fmt?: unknown
      color_space?: unknown
      color_transfer?: unknown
      color_primaries?: unknown
      color_range?: unknown
      sample_rate?: unknown
      channels?: unknown
      channel_layout?: unknown
      sample_aspect_ratio?: unknown
      display_aspect_ratio?: unknown
      tags?: Record<string, unknown>
      side_data_list?: Array<Record<string, unknown>>
      duration?: unknown
    }>
    format?: { duration?: string; format_name?: unknown; tags?: Record<string, unknown> }
  }
  const videoStreams = metadata.streams?.filter(stream => stream.codec_type === 'video') ?? []
  const audioStreams = metadata.streams?.filter(stream => stream.codec_type === 'audio') ?? []
  const primary = videoStreams[0]
  const duration = Number(metadata.format?.duration ?? 0)
  if (!primary || !Number.isFinite(duration) || duration <= 0) throw new Error('导出文件缺少有效视频轨或时长')
  const width = Number(primary.width)
  const height = Number(primary.height)
  const fps = parseRate(primary.avg_frame_rate ?? primary.r_frame_rate)
  // Container duration is not stream duration evidence.  A muxer may extend
  // one track, omit a stream duration entirely, or report a rounded format
  // duration.  Keep the A/V delta absent unless both primary streams attest
  // their own finite duration; the formal delivery verifier rejects that
  // absence instead of silently substituting a zero delta.
  const primaryVideoDuration = Number(primary.duration)
  const primaryAudioDuration = Number(audioStreams[0]?.duration)
  const formatNames = ffprobeString(metadata.format?.format_name)?.toLowerCase().split(',') ?? []
  const majorBrand = ffprobeString(metadata.format?.tags?.major_brand)?.trim().toLowerCase()
  // `mov,mp4,...` is a shared demuxer label.  The atom brand is the actual
  // file identity, so a .mp4 name can never make a QuickTime file pass.
  const container = majorBrand === 'qt'
    ? 'mov' as const
    : (majorBrand && /^(?:isom|iso[0-9]|avc1|mp4[12]|dash|msdh|m4v)/.test(majorBrand) && formatNames.includes('mov'))
      ? 'mp4' as const
      : undefined
  const videoCodec = primary.codec_name === 'h264' ? 'h264' as const : primary.codec_name === 'prores' ? 'prores_422' as const : undefined
  const rawProresProfile = ffprobeString(primary.profile)?.trim().toLowerCase()
  const proresProfile = videoCodec === 'prores_422'
    ? rawProresProfile === 'standard' ? 'standard' as const : rawProresProfile === 'hq' ? 'hq' as const : undefined
    : undefined
  const audioCodec = audioStreams[0]?.codec_name === 'aac' ? 'aac_lc' as const : audioStreams[0]?.codec_name === 'pcm_s16le' ? 'pcm_s16le' as const : undefined
  const pixelFormat = primary.pix_fmt === 'yuv420p' ? 'yuv420p' as const : primary.pix_fmt === 'yuv422p10le' ? 'yuv422p10le' as const : undefined
  const colorRange = primary.color_space === 'bt709' && primary.color_transfer === 'bt709' && primary.color_primaries === 'bt709' && primary.color_range === 'tv'
    ? 'sdr_bt709' as const
    : undefined
  const audioSampleRate = Number(audioStreams[0]?.sample_rate)
  const audioChannels = Number(audioStreams[0]?.channels)
  const audioLayout = ffprobeString(audioStreams[0]?.channel_layout)
  const sampleAspectRatio = ffprobeString(primary.sample_aspect_ratio)
  const displayAspectRatio = ffprobeString(primary.display_aspect_ratio)
  const rotation = normalizedRotation(primary as FfprobeStream)
  return {
    byte_size: info.size,
    duration_ms: Math.max(1, Math.round(duration * 1000)),
    file_mtime_ms: info.mtimeMs,
    video_stream_count: videoStreams.length,
    audio_stream_count: audioStreams.length,
    ...(Number.isInteger(width) && width > 0 ? { width } : {}),
    ...(Number.isInteger(height) && height > 0 ? { height } : {}),
    ...(fps && fps > 0 ? { fps } : {}),
    ...(container ? { container } : {}),
    ...(videoCodec ? { video_codec: videoCodec } : {}),
    ...(proresProfile ? { prores_profile: proresProfile } : {}),
    ...(audioCodec ? { audio_codec: audioCodec } : {}),
    ...(pixelFormat ? { pixel_format: pixelFormat } : {}),
    ...(colorRange ? { color_range: colorRange } : {}),
    ...(Number.isSafeInteger(audioSampleRate) && audioSampleRate > 0 ? { audio_sample_rate: audioSampleRate } : {}),
    ...(Number.isSafeInteger(audioChannels) && audioChannels > 0 ? { audio_channels: audioChannels } : {}),
    ...(audioLayout ? { audio_channel_layout: audioLayout } : {}),
    ...(sampleAspectRatio ? { sample_aspect_ratio: sampleAspectRatio } : {}),
    ...(displayAspectRatio ? { display_aspect_ratio: displayAspectRatio } : {}),
    rotation,
    ...(Number.isFinite(primaryVideoDuration) && Number.isFinite(primaryAudioDuration) && primaryAudioDuration > 0
      ? { audio_video_duration_delta_ms: Math.abs(Math.round((primaryVideoDuration - primaryAudioDuration) * 1000)) }
      : {}),
    content_hash: await videoFingerprint(path),
  }
}

function reducedRatio(numerator: number, denominator: number): string {
  let left = Math.abs(Math.trunc(numerator))
  let right = Math.abs(Math.trunc(denominator))
  while (right) [left, right] = [right, left % right]
  const divisor = left || 1
  return `${Math.trunc(numerator / divisor)}:${Math.trunc(denominator / divisor)}`
}

function assertExpectedDeliveryProfile(output: VerifiedVideoOutput, profile: VideoExportProfileRevision): void {
  const expectedFps = profile.frame_rate.num / profile.frame_rate.den
  const expectedDisplayAspect = reducedRatio(profile.width, profile.height)
  const expectedLayout = profile.encoding.audio.channels === 1 ? 'mono' : 'stereo'
  const exact: Array<[string, unknown, unknown]> = [
    ['容器', output.container, profile.encoding.container],
    ['视频编码', output.video_codec, profile.encoding.video.codec],
    ...(profile.encoding.video.codec === 'prores_422'
      ? [['ProRes profile', output.prores_profile, profile.encoding.video.quality.profile] as [string, unknown, unknown]]
      : []),
    ['音频编码', output.audio_codec, profile.encoding.audio.codec],
    ['像素格式', output.pixel_format, profile.encoding.output_color.pixel_format],
    ['颜色范围', output.color_range, profile.encoding.output_color.range],
    ['宽度', output.width, profile.width],
    ['高度', output.height, profile.height],
    ['音频采样率', output.audio_sample_rate, profile.encoding.audio.sample_rate],
    ['音频声道数', output.audio_channels, profile.encoding.audio.channels],
    ['音频声道布局', output.audio_channel_layout, expectedLayout],
    ['像素宽高比', output.sample_aspect_ratio, '1:1'],
    ['显示宽高比', output.display_aspect_ratio, expectedDisplayAspect],
    ['旋转', output.rotation, 0],
  ]
  const mismatch = exact.find(([, actual, expected]) => actual !== expected)
  if (mismatch) throw new Error(`正式导出${mismatch[0]}与冻结 Profile 不一致`)
  if (!output.fps || Math.abs(output.fps - expectedFps) > 0.001) {
    throw new Error('正式导出帧率与冻结 Profile 不一致')
  }
}

function detectedDurationMs(stderr: string, kind: 'black' | 'silence', totalDurationMs: number): number {
  const label = kind === 'black' ? 'black' : 'silence'
  const durationPattern = new RegExp(`\\b${label}_duration:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'gi')
  let seconds = 0
  let match: RegExpExecArray | null
  while ((match = durationPattern.exec(stderr))) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > 0) seconds += value
  }

  // FFmpeg normally emits a duration once a detected interval closes.  If a
  // file ends while it is still inside one, account for that tail explicitly
  // instead of silently claiming a clean output.
  const starts = [...stderr.matchAll(new RegExp(`\\b${label}_start:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'gi'))]
    .map(candidate => Number(candidate[1]))
    .filter(value => Number.isFinite(value) && value >= 0)
  const ends = [...stderr.matchAll(new RegExp(`\\b${label}_end:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'gi'))]
    .map(candidate => Number(candidate[1]))
    .filter(value => Number.isFinite(value) && value >= 0)
  if (starts.length > ends.length) {
    const lastStart = starts.at(-1)!
    seconds += Math.max(0, totalDurationMs / 1_000 - lastStart)
  }
  return Math.min(totalDurationMs, Math.max(0, Math.round(seconds * 1_000)))
}

async function scanDeliveryOutputQuality(input: {
  path: string
  ffmpeg: string
  runProcess: VideoProcessRunner
  durationMs: number
}): Promise<Pick<DeliveryOutputVerification, 'black_duration_ms' | 'black_ratio' | 'silence_duration_ms' | 'silence_ratio'>> {
  const [black, silence] = await Promise.all([
    input.runProcess([
      input.ffmpeg, '-v', 'info', '-i', input.path,
      '-map', '0:v:0', '-an', '-vf', 'blackdetect=d=0.25:pix_th=0.10:pic_th=0.98', '-f', 'null', '-',
    ]),
    input.runProcess([
      input.ffmpeg, '-v', 'info', '-i', input.path,
      '-map', '0:a:0', '-vn', '-af', 'silencedetect=noise=-45dB:d=0.30', '-f', 'null', '-',
    ]),
  ])
  if (black.exitCode !== 0) throw new Error('导出文件黑场扫描失败')
  if (silence.exitCode !== 0) throw new Error('导出文件静音扫描失败')
  const blackDurationMs = detectedDurationMs(`${black.stdout}\n${black.stderr}`, 'black', input.durationMs)
  const silenceDurationMs = detectedDurationMs(`${silence.stdout}\n${silence.stderr}`, 'silence', input.durationMs)
  return {
    black_duration_ms: blackDurationMs,
    black_ratio: blackDurationMs / input.durationMs,
    silence_duration_ms: silenceDurationMs,
    silence_ratio: silenceDurationMs / input.durationMs,
  }
}

/**
 * Decode and packet checks are separate from ffprobe metadata inspection.
 * A successful encoder exit is not proof that the bytes are decodable or that
 * packet timestamps remain usable by a downstream player.
 */
export async function verifyDeliveryVideoOutput(input: {
  path: string
  runProcess: VideoProcessRunner
  ffmpeg: string
  ffprobe: string
  expected_duration_ms: number
  /** Required by the formal render service; omitted only for low-level inspection tests. */
  expected_profile?: VideoExportProfileRevision
}): Promise<DeliveryOutputVerification> {
  const inspected = await verifyVideoOutput(input.path, input.runProcess, input.ffprobe)
  // The formal renderer maps exactly one synthesized video stream and one
  // mixed (or explicit silent) audio stream.  Permit neither missing audio nor
  // hidden extra streams: both make the ExecutionPlan receipt ambiguous.
  if (inspected.video_stream_count !== 1 || inspected.audio_stream_count !== 1) {
    throw new Error('正式导出必须恰好包含一条视频流和一条音频流')
  }
  if (inspected.audio_video_duration_delta_ms === undefined) {
    throw new Error('正式导出缺少独立的音视频流时长证据')
  }
  if (input.expected_profile) assertExpectedDeliveryProfile(inspected, input.expected_profile)
  const decode = await input.runProcess([input.ffmpeg, '-v', 'error', '-i', input.path, '-map', '0', '-f', 'null', '-'])
  if (decode.exitCode !== 0) throw new Error('导出文件未通过全量解码扫描')
  const packets = await input.runProcess([
    input.ffprobe, '-v', 'error', '-print_format', 'json', '-show_packets',
    '-show_entries', 'packet=stream_index,dts,pts', input.path,
  ])
  if (packets.exitCode !== 0) throw new Error('导出文件包时间戳不可读取')
  const packetRows = JSON.parse(packets.stdout) as { packets?: Array<{ stream_index?: unknown; dts?: unknown; pts?: unknown }> }
  if (!Array.isArray(packetRows.packets) || !packetRows.packets.length) {
    throw new Error('导出文件没有可验证的媒体包')
  }
  const previous = new Map<number, bigint>()
  let monotonic = true
  for (const packet of packetRows.packets ?? []) {
    const streamIndex = Number(packet.stream_index)
    const rawTimestamp = packet.dts ?? packet.pts
    if (!Number.isSafeInteger(streamIndex) || (typeof rawTimestamp !== 'string' && typeof rawTimestamp !== 'number')) continue
    let timestamp: bigint
    try { timestamp = BigInt(String(rawTimestamp)) } catch { continue }
    const last = previous.get(streamIndex)
    if (last !== undefined && timestamp < last) monotonic = false
    previous.set(streamIndex, timestamp)
  }
  if (!previous.has(0) || !previous.has(1)) {
    throw new Error('导出文件缺少可验证的音视频包时间戳')
  }
  if (!monotonic) throw new Error('导出文件包时间戳不单调')
  const quality = await scanDeliveryOutputQuality({
    path: input.path,
    ffmpeg: input.ffmpeg,
    runProcess: input.runProcess,
    durationMs: inspected.duration_ms,
  })
  return {
    ...inspected,
    decoded: true,
    packet_timestamps_monotonic: true,
    expected_duration_ms: input.expected_duration_ms,
    duration_delta_ms: Math.abs(inspected.duration_ms - input.expected_duration_ms),
    ...quality,
  }
}
