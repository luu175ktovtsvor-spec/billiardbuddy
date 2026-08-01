import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { VideoStudioProject } from '../../../shared/contracts/media.js'

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
  name: 'h264_videotoolbox' | 'h264_mf' | 'mpeg4'
  args: string[]
}

export type ProbedVideoSource = {
  duration_ms: number
  width: number
  height: number
  fps?: number
  has_audio: boolean
  rotation: number
  video_stream_count: number
  audio_stream_count: number
  content_hash: `sha256:${string}`
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
    if (!['h264_videotoolbox', 'h264_mf', 'mpeg4'].includes(explicit) || !has(explicit)) {
      throw new Error('指定的视频编码器不可用')
    }
    return explicit === 'mpeg4' ? FALLBACK_VIDEO_ENCODER : { name: explicit as VideoEncoderProfile['name'], args: ['-b:v', '8M'] }
  }
  if (platform === 'darwin' && has('h264_videotoolbox')) return { name: 'h264_videotoolbox', args: ['-b:v', '8M'] }
  if (platform === 'win32' && has('h264_mf')) return { name: 'h264_mf', args: ['-b:v', '8M'] }
  return FALLBACK_VIDEO_ENCODER
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

export async function videoFingerprint(path: string): Promise<`sha256:${string}`> {
  const digest = createHash('sha256')
  for await (const chunk of Bun.file(path).stream()) digest.update(chunk)
  return `sha256:${digest.digest('hex')}`
}

export async function probeVideoSource(
  path: string,
  runProcess: VideoProcessRunner,
  ffprobe: string,
): Promise<ProbedVideoSource> {
  const result = await runProcess([ffprobe, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path])
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `ffprobe exited ${result.exitCode}`)
  const metadata = JSON.parse(result.stdout) as {
    format?: { duration?: string }
    streams?: Array<Record<string, unknown>>
  }
  const videoStreams = metadata.streams?.filter(stream => stream.codec_type === 'video') ?? []
  const audioStreams = metadata.streams?.filter(stream => stream.codec_type === 'audio') ?? []
  const primary = videoStreams[0]
  if (!primary) throw new Error('素材中没有视频轨道')
  const rotationRaw = (primary.tags as Record<string, unknown> | undefined)?.rotate
    ?? (Array.isArray(primary.side_data_list)
      ? (primary.side_data_list as Array<Record<string, unknown>>).find(item => item.rotation !== undefined)?.rotation
      : undefined)
  const rotation = Number(rotationRaw)
  return {
    duration_ms: Math.max(1, Math.round(Number(metadata.format?.duration ?? primary.duration ?? 0) * 1000)),
    width: Math.max(0, Number(primary.width ?? 0)),
    height: Math.max(0, Number(primary.height ?? 0)),
    ...(parseRate(primary.avg_frame_rate ?? primary.r_frame_rate) ? { fps: parseRate(primary.avg_frame_rate ?? primary.r_frame_rate) } : {}),
    has_audio: audioStreams.length > 0,
    rotation: Number.isFinite(rotation) ? ((Math.trunc(rotation) % 360) + 360) % 360 : 0,
    video_stream_count: videoStreams.length,
    audio_stream_count: audioStreams.length,
    content_hash: await videoFingerprint(path),
  }
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
    streams?: Array<{ codec_type?: unknown; width?: unknown; height?: unknown; avg_frame_rate?: unknown; r_frame_rate?: unknown }>
    format?: { duration?: string }
  }
  const videoStreams = metadata.streams?.filter(stream => stream.codec_type === 'video') ?? []
  const audioStreams = metadata.streams?.filter(stream => stream.codec_type === 'audio') ?? []
  const primary = videoStreams[0]
  const duration = Number(metadata.format?.duration ?? 0)
  if (!primary || !Number.isFinite(duration) || duration <= 0) throw new Error('导出文件缺少有效视频轨或时长')
  const width = Number(primary.width)
  const height = Number(primary.height)
  const fps = parseRate(primary.avg_frame_rate ?? primary.r_frame_rate)
  return {
    byte_size: info.size,
    duration_ms: Math.max(1, Math.round(duration * 1000)),
    file_mtime_ms: info.mtimeMs,
    video_stream_count: videoStreams.length,
    audio_stream_count: audioStreams.length,
    ...(Number.isInteger(width) && width > 0 ? { width } : {}),
    ...(Number.isInteger(height) && height > 0 ? { height } : {}),
    ...(fps && fps > 0 ? { fps } : {}),
    content_hash: await videoFingerprint(path),
  }
}
