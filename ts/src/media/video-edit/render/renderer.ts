import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ffmpegBinFrom, ffprobeBinFrom, subtitleFontConfig } from '../../mediaBinaries'
import { videoProjectSchema, videoRenderRequestSchema, type VideoAudioLayer, type VideoProject, type VideoRenderInput, type VideoScene } from '../../../../shared/contracts/video-edit'
import { runFfmpegText } from '../evidence/ffmpeg'

export interface VideoQualityReport {
  passed: boolean
  duration_ms: number
  width: number
  height: number
  has_video: boolean
  has_audio: boolean
  decode_verified: boolean
  warnings: string[]
}

export interface VideoQualityExpectation {
  expectedDurationMs: number
  expectedWidth: number
  expectedHeight: number
  preview: boolean
}

export interface VideoRenderResult {
  project_id: string
  revision: number
  video_url: string
  manifest_url: string
  preview: boolean
  warnings: string[]
  duration_ms: number
}

export interface VideoRendererOptions {
  stateRoot: string
  env?: Record<string, string | undefined>
  onProgress?: (progress: number, stage: string) => Promise<void> | void
  signal?: AbortSignal
  qualityCheck?: typeof inspectRenderedVideo
}

function ffmpegRun(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, signal })
    let stderr = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-3000) || `ffmpeg failed:${code}`)))
  })
}

function detectedDurations(stderr: string, key: 'black_duration' | 'freeze_duration'): number[] {
  const pattern = new RegExp(`${key}:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'g')
  return [...stderr.matchAll(pattern)].map(match => Number(match[1])).filter(Number.isFinite)
}

export async function inspectRenderedVideo(
  path: string,
  expected: VideoQualityExpectation,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
): Promise<VideoQualityReport> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size <= 0) throw new Error('导出质检失败:成片文件为空')
  const probe = await runFfmpegText(ffprobeBinFrom(env), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
    signal,
    timeoutMs: 60_000,
  })
  if (probe.code !== 0) throw new Error(`导出质检失败:无法读取成片信息${probe.stderr.trim() ? ` (${probe.stderr.trim().slice(-300)})` : ''}`)
  let parsed: { format?: { duration?: string }; streams?: Array<Record<string, unknown>> }
  try {
    parsed = JSON.parse(probe.stdout)
  } catch {
    throw new Error('导出质检失败:成片信息不是有效 JSON')
  }
  const streams = parsed.streams ?? []
  const video = streams.find(stream => stream.codec_type === 'video')
  const audio = streams.find(stream => stream.codec_type === 'audio')
  if (!video) throw new Error('导出质检失败:成片没有视频轨')
  if (!audio) throw new Error('导出质检失败:成片没有音频轨')
  const durationMs = Math.round(Number(parsed.format?.duration ?? 0) * 1000)
  const width = Math.round(Number(video.width ?? 0))
  const height = Math.round(Number(video.height ?? 0))
  if (!(durationMs > 0)) throw new Error('导出质检失败:成片时长无效')
  if (width !== expected.expectedWidth || height !== expected.expectedHeight) {
    throw new Error(`导出质检失败:成片画幅 ${width}x${height} 与计划 ${expected.expectedWidth}x${expected.expectedHeight} 不一致`)
  }
  const durationToleranceMs = Math.max(500, Math.round(expected.expectedDurationMs * 0.03))
  if (Math.abs(durationMs - expected.expectedDurationMs) > durationToleranceMs) {
    throw new Error(`导出质检失败:成片时长 ${durationMs}ms 与计划 ${expected.expectedDurationMs}ms 偏差过大`)
  }

  const warnings: string[] = []
  let decodeVerified = false
  if (!expected.preview) {
    const decoded = await runFfmpegText(ffmpegBinFrom(env), [
      '-hide_banner', '-nostats', '-v', 'warning', '-i', path,
      '-vf', 'blackdetect=d=1:pix_th=0.02,freezedetect=n=-60dB:d=2',
      '-f', 'null', '-',
    ], { signal, timeoutMs: 30 * 60_000 })
    if (decoded.code !== 0) throw new Error(`导出质检失败:成片无法完整解码${decoded.stderr.trim() ? ` (${decoded.stderr.trim().slice(-300)})` : ''}`)
    decodeVerified = true
    const blackDuration = Math.max(0, ...detectedDurations(decoded.stderr, 'black_duration'))
    const freezeDuration = Math.max(0, ...detectedDurations(decoded.stderr, 'freeze_duration'))
    if (blackDuration >= 1) warnings.push(`检测到持续黑场 ${blackDuration.toFixed(1)} 秒，请预览确认`)
    if (freezeDuration >= 2) warnings.push(`检测到画面冻结 ${freezeDuration.toFixed(1)} 秒，请预览确认`)
  }
  return {
    passed: true,
    duration_ms: durationMs,
    width,
    height,
    has_video: true,
    has_audio: true,
    decode_verified: decodeVerified,
    warnings,
  }
}

function assTime(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = (total % 60).toFixed(2).padStart(5, '0')
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
}

function assText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('{', '\\{').replaceAll('}', '\\}').replace(/\r?\n/g, '\\N')
}

export function renderAssDocument(project: VideoProject, scenes: VideoScene[], env: Record<string, string | undefined>, includeSubtitles: boolean): string {
  const font = subtitleFontConfig(env)?.family ?? 'Arial'
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${project.canvas.width}`,
    `PlayResY: ${project.canvas.height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Subtitle,${font},52,&H00FFFFFF,&H000000FF,&H00111111,&H99000000,-1,0,0,0,100,100,0,0,1,3,0,2,80,80,150,1`,
    `Style: Title,${font},72,&H00FFFFFF,&H000000FF,&H00111111,&H88000000,-1,0,0,0,100,100,0,0,1,3,0,8,90,90,130,1`,
    `Style: CTA,${font},60,&H00FFFFFF,&H000000FF,&H00111111,&H99000000,-1,0,0,0,100,100,0,0,1,3,0,2,100,100,190,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (const scene of scenes) {
    if (includeSubtitles && scene.dialogue?.state !== 'deleted' && scene.dialogue?.display_text.trim()) {
      lines.push(`Dialogue: 0,${assTime(scene.output_range.start_ms)},${assTime(scene.output_range.end_ms)},Subtitle,,0,0,0,,{\\fad(100,100)}${assText(scene.dialogue.display_text)}`)
    }
    for (const graphic of scene.graphics.filter(item => !item.hidden_reason && item.text?.trim() && (includeSubtitles || item.role !== 'subtitle'))) {
      const start = scene.output_range.start_ms + graphic.enter_ms
      const end = Math.min(scene.output_range.end_ms, start + graphic.hold_ms + graphic.exit_ms)
      const style = graphic.role === 'cta' ? 'CTA' : graphic.role === 'subtitle' ? 'Subtitle' : 'Title'
      lines.push(`Dialogue: 1,${assTime(start)},${assTime(Math.max(start + 100, end))},${style},,0,0,0,,{\\fad(${graphic.enter_ms},${graphic.exit_ms})}${assText(graphic.text!)}`)
    }
  }
  const lastScene = scenes[scenes.length - 1]
  if (lastScene && project.brand.cta_text?.trim() && !lastScene.graphics.some(graphic => !graphic.hidden_reason && graphic.role === 'cta' && graphic.text?.trim())) {
    const start = Math.max(lastScene.output_range.start_ms, lastScene.output_range.end_ms - Math.min(2500, sceneDurationMs(lastScene)))
    lines.push(`Dialogue: 2,${assTime(start)},${assTime(lastScene.output_range.end_ms)},CTA,,0,0,0,,{\\fad(120,120)}${assText(project.brand.cta_text)}`)
  }
  return `${lines.join('\n')}\n`
}

function sceneDurationMs(scene: VideoScene): number {
  return Math.max(1, scene.output_range.end_ms - scene.output_range.start_ms)
}

function envelopeExpression(layer: VideoAudioLayer | undefined, time = 't'): string {
  const points = layer?.gain_envelope.slice().sort((a, b) => a.at_ms - b.at_ms) ?? []
  if (!points.length) return '1'
  if (points.length === 1) return String(points[0]!.gain)
  let expression = String(points.at(-1)!.gain)
  for (let index = points.length - 2; index >= 0; index--) {
    const from = points[index]!
    const to = points[index + 1]!
    const start = from.at_ms / 1000
    const end = to.at_ms / 1000
    const span = Math.max(0.001, end - start)
    expression = `if(lt(${time},${end}),${from.gain}+(${time}-${start})*(${to.gain}-${from.gain})/${span},${expression})`
  }
  return expression
}

function musicGainExpression(scenes: VideoScene[]): string {
  const segments = scenes.map((scene, index) => {
    const layer = scene.audio_layers.find(item => item.enabled && item.role === 'music')
    const start = scene.output_range.start_ms / 1000
    const end = scene.output_range.end_ms / 1000
    const points = layer?.gain_envelope.slice().sort((a, b) => a.at_ms - b.at_ms) ?? []
    const target = points[0]?.gain ?? (scene.edit_clock === 'dialogue' ? 0.18 : scene.edit_clock === 'action' ? 0.35 : 0.55)
    const previousLayer = index > 0 ? scenes[index - 1]!.audio_layers.find(item => item.enabled && item.role === 'music') : undefined
    const previousPoints = previousLayer?.gain_envelope.slice().sort((a, b) => a.at_ms - b.at_ms) ?? []
    const previous = previousPoints.at(-1)?.gain ?? target
    const local = envelopeExpression(layer, `(t-${start})`)
    const ramp = Math.min((layer?.fade_in_ms ?? 0) / 1000, Math.max(0, (end - start) / 3))
    const value = ramp > 0 && previous !== target
      ? `if(lt(t,${start + ramp}),${previous}+(t-${start})*(${target}-${previous})/${ramp},${local})`
      : local
    return { start, end, value }
  })
  let expression = segments.at(-1)?.value ?? '0.5'
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!
    expression = `if(between(t,${segment.start},${segment.end}),${segment.value},${expression})`
  }
  return expression
}

function atempoFilter(speed: number): string {
  const filters: string[] = []
  let remaining = speed
  while (remaining > 2) { filters.push('atempo=2'); remaining /= 2 }
  while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5 }
  filters.push(`atempo=${Number(remaining.toFixed(6))}`)
  return filters.join(',')
}

function sourceFor(project: VideoProject, id: string) {
  const source = project.sources.find(item => item.id === id)
  if (!source || source.missing || !existsSync(source.file_uri)) throw new Error(`素材离线:${source?.name ?? id}`)
  return source
}

function escapeFilterPath(path: string): string {
  return path.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

async function renderScene(
  bin: string,
  project: VideoProject,
  scene: VideoScene,
  output: string,
  preview: boolean,
  signal?: AbortSignal,
) {
  const visual = [...scene.video_layers].reverse().find(layer => layer.enabled && layer.role === 'broll')
    ?? scene.video_layers.find(layer => layer.enabled && layer.role === 'primary')
    ?? scene.video_layers[0]
  if (!visual) throw new Error(`Scene ${scene.id} 没有可渲染画面`)
  const visualSource = sourceFor(project, visual.source_range.source_id)
  const sourceAudioLayer = scene.audio_layers.find(layer => layer.enabled && layer.role === 'speech' && layer.source_range)
    ?? scene.audio_layers.find(layer => layer.enabled && layer.owner && layer.role !== 'music' && layer.source_range)
    ?? scene.audio_layers.find(layer => layer.enabled && layer.role !== 'music' && layer.source_range)
  const audioRange = sourceAudioLayer?.source_range ?? scene.source_ranges[0]!
  const audioSource = sourceFor(project, audioRange.source_id)
  const durationSec = sceneDurationMs(scene) / 1000
  const width = preview ? Math.min(project.canvas.width, 540) : project.canvas.width
  const height = preview ? Math.round(width * project.canvas.height / project.canvas.width) : project.canvas.height
  const inputDurationSec = durationSec * visual.speed
  const args = [
    '-y',
    '-ss', String(visual.source_range.in_ms / 1000), '-t', String(inputDurationSec), '-i', visualSource.file_uri,
  ]
  const audioVisualLayer = scene.video_layers.find(layer => layer.enabled && layer.source_range.source_id === audioRange.source_id)
  const audioSpeedValue = audioVisualLayer?.speed ?? 1
  if (audioSource.has_audio === false) {
    args.push('-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000')
  } else {
    args.push('-ss', String(audioRange.in_ms / 1000), '-t', String(durationSec * audioSpeedValue), '-i', audioSource.file_uri)
  }
  const fit = visual.crop.fit
  const normalizedCrop = `crop=iw*${visual.crop.width}:ih*${visual.crop.height}:iw*${visual.crop.x}:ih*${visual.crop.y}`
  const fitFilter = fit === 'cover'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
  const videoFilter = `${normalizedCrop},setpts=PTS/${visual.speed},${fitFilter},setsar=1,fps=${project.canvas.fps},format=yuv420p`
  const gain = envelopeExpression(sourceAudioLayer)
  const audioSpeed = atempoFilter(audioSpeedValue)
  const fadeIn = Math.min(durationSec / 3, (sourceAudioLayer?.fade_in_ms ?? 0) / 1000)
  const fadeOut = Math.min(durationSec / 3, (sourceAudioLayer?.fade_out_ms ?? 0) / 1000)
  const audioFades = [
    fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn}` : '',
    fadeOut > 0 ? `afade=t=out:st=${Math.max(0, durationSec - fadeOut)}:d=${fadeOut}` : '',
  ].filter(Boolean).join(',')
  args.push(
    '-filter_complex', `[0:v]${videoFilter}[v];[1:a]atrim=duration=${durationSec * audioSpeedValue},asetpts=PTS-STARTPTS,${audioSpeed},apad=pad_dur=${durationSec},atrim=duration=${durationSec},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume='${gain}'${audioFades ? `,${audioFades}` : ''}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'medium', '-crf', preview ? '28' : '20',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', output,
  )
  await ffmpegRun(bin, args, signal)
}

function transitionGraph(scenes: VideoScene[]): { graph: string; video: string; audio: string; durationMs: number } {
  const count = scenes.length
  if (count === 1) return { graph: '[0:v]null[vbase];[0:a]anull[abase]', video: 'vbase', audio: 'abase', durationMs: sceneDurationMs(scenes[0]!) }
  const parts: string[] = []
  let video = '0:v'
  let audio = '0:a'
  let elapsed = sceneDurationMs(scenes[0]!) / 1000
  let overlapTotal = 0
  for (let index = 1; index < count; index++) {
    const scene = scenes[index]!
    const transitionSec = scene.transition_in.kind === 'cut' ? 0.01 : Math.max(0.1, scene.transition_in.duration_ms / 1000)
    const offset = Math.max(0.01, elapsed - transitionSec)
    const nextVideo = `vx${index}`
    const nextAudio = `ax${index}`
    const transition = scene.transition_in.kind === 'brand' ? 'fadeblack' : 'fade'
    parts.push(`[${video}][${index}:v]xfade=transition=${transition}:duration=${transitionSec}:offset=${offset}[${nextVideo}]`)
    parts.push(`[${audio}][${index}:a]acrossfade=d=${transitionSec}:c1=tri:c2=tri[${nextAudio}]`)
    video = nextVideo
    audio = nextAudio
    elapsed += sceneDurationMs(scene) / 1000 - transitionSec
    overlapTotal += transitionSec * 1000
  }
  return { graph: parts.join(';'), video, audio, durationMs: Math.max(1, Math.round(scenes.reduce((sum, scene) => sum + sceneDurationMs(scene), 0) - overlapTotal)) }
}

export class VideoRenderer {
  private readonly env: Record<string, string | undefined>

  constructor(private readonly options: VideoRendererOptions) {
    this.env = options.env ?? process.env
  }

  async render(rawProject: VideoProject, rawRequest: VideoRenderInput): Promise<VideoRenderResult> {
    const project = videoProjectSchema.parse(structuredClone(rawProject))
    const request = videoRenderRequestSchema.parse(rawRequest)
    if (request.revision != null && request.revision !== project.revision) throw new Error(`导出锁定 revision ${request.revision}，当前项目是 ${project.revision}`)
    const scenes = project.scenes.filter(scene => !scene.deleted && (!request.scene_id || scene.id === request.scene_id))
    if (request.scene_id && !scenes.length) throw new Error(`找不到要预览的 Scene:${request.scene_id}`)
    if (!scenes.length) throw new Error('项目没有可导出的 Scene')
    const bin = ffmpegBinFrom(this.env)
    const projectDir = join(this.options.stateRoot, 'uploads', 'edits', project.project_id)
    const renderId = `${request.preview ? 'preview' : 'export'}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const workDir = join(projectDir, 'proxies', renderId)
    const exportDir = join(projectDir, 'exports')
    await mkdir(workDir, { recursive: true })
    await mkdir(exportDir, { recursive: true })
    const warnings: string[] = []
    const parts: string[] = []
    try {
      for (let index = 0; index < scenes.length; index++) {
        await this.options.onProgress?.(Math.round((index / scenes.length) * 65), `正在渲染 Scene ${index + 1}/${scenes.length}`)
        const path = join(workDir, `scene-${String(index).padStart(3, '0')}.mp4`)
        await renderScene(bin, project, scenes[index]!, path, request.preview, this.options.signal)
        parts.push(path)
      }
      const assPath = join(workDir, 'graphics.ass')
      await writeFile(assPath, renderAssDocument(project, scenes, this.env, request.include_subtitles))
      const target = join(exportDir, `${renderId}.mp4`)
      const temporary = `${target}.tmp.mp4`
      const args = ['-y']
      for (const part of parts) args.push('-i', part)
      let musicInput = -1
      const musicAllowed = request.include_music && project.music.enabled && project.music.path && project.music.license_id
      if (request.include_music && project.music.enabled && project.music.path && !project.music.license_id) warnings.push('音乐缺少已确认授权 ID，本次导出未使用')
      if (musicAllowed) {
        musicInput = parts.length
        args.push('-stream_loop', '-1', '-i', project.music.path!)
      }
      let logoInput = -1
      if (project.brand.logo_path && existsSync(project.brand.logo_path)) {
        logoInput = parts.length + (musicInput >= 0 ? 1 : 0)
        args.push('-loop', '1', '-i', project.brand.logo_path)
      }
      const transitions = transitionGraph(scenes)
      const filters = [transitions.graph]
      let videoLabel = transitions.video
      filters.push(`[${videoLabel}]ass='${escapeFilterPath(assPath)}'[vtext]`)
      videoLabel = 'vtext'
      if (logoInput >= 0) {
        filters.push(`[${logoInput}:v]scale=160:-1[logo];[${videoLabel}][logo]overlay=W-w-40:40:shortest=1[vlogo]`)
        videoLabel = 'vlogo'
      }
      let audioLabel = transitions.audio
      if (musicInput >= 0) {
        filters.push(`[${musicInput}:a]atrim=duration=${transitions.durationMs / 1000},asetpts=PTS-STARTPTS,volume='${musicGainExpression(scenes)}':eval=frame[music]`)
        filters.push(`[${audioLabel}][music]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[audio]`)
        audioLabel = 'audio'
      }
      filters.push(`[${audioLabel}]loudnorm=I=-16:TP=-1.5:LRA=11[anorm]`)
      audioLabel = 'anorm'
      args.push(
        '-filter_complex', filters.join(';'),
        '-map', `[${videoLabel}]`, '-map', `[${audioLabel}]`,
        '-c:v', 'libx264', '-preset', request.preview ? 'ultrafast' : 'medium', '-crf', request.preview ? '28' : '20',
        '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-shortest', temporary,
      )
      await this.options.onProgress?.(75, '正在合成字幕、图形和音频')
      await ffmpegRun(bin, args, this.options.signal)
      const expectedWidth = request.preview ? Math.min(project.canvas.width, 540) : project.canvas.width
      const expectedHeight = request.preview ? Math.round(expectedWidth * project.canvas.height / project.canvas.width) : project.canvas.height
      await this.options.onProgress?.(92, request.preview ? '正在检查预览文件' : '正在检查成片完整性')
      let qualityChecks: VideoQualityReport
      try {
        qualityChecks = await (this.options.qualityCheck ?? inspectRenderedVideo)(temporary, {
          expectedDurationMs: transitions.durationMs,
          expectedWidth,
          expectedHeight,
          preview: request.preview,
        }, this.env, this.options.signal)
        warnings.push(...qualityChecks.warnings)
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      const manifestPath = join(exportDir, `${renderId}.manifest.json`)
      const manifest = {
        schema_version: 1,
        project_id: project.project_id,
        revision: project.revision,
        created_at: new Date().toISOString(),
        preview: request.preview,
        output: target,
        duration_ms: transitions.durationMs,
        source_fingerprints: project.sources.map(source => ({ source_id: source.id, fingerprint: source.fingerprint })),
        warnings,
        scene_ids: scenes.map(scene => scene.id),
        visual_semantics: scenes.map(scene => ({ scene_id: scene.id, layers: scene.video_layers })),
        transition_semantics: scenes.map(scene => ({ scene_id: scene.id, ...scene.transition_in })),
        audio_semantics: scenes.map(scene => ({ scene_id: scene.id, edit_clock: scene.edit_clock, layers: scene.audio_layers })),
        music_semantics: project.music,
        brand_semantics: project.brand,
        loudness_target: { integrated_lufs: -16, true_peak_db: -1.5, loudness_range: 11 },
        quality_checks: qualityChecks,
      }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      await this.options.onProgress?.(100, '导出完成')
      return {
        project_id: project.project_id,
        revision: project.revision,
        video_url: `/api/v1/video-edit/projects/${encodeURIComponent(project.project_id)}/exports/${encodeURIComponent(basename(target))}`,
        manifest_url: `/api/v1/video-edit/projects/${encodeURIComponent(project.project_id)}/exports/${encodeURIComponent(basename(manifestPath))}`,
        preview: request.preview,
        warnings,
        duration_ms: transitions.durationMs,
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
