import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface MediaRef {
  src: string
  duration: number
  kind: string
  has_audio?: boolean
}

export interface Track {
  kind: string
  order: number
}

export interface Clip {
  track: string
  order: number
  media: string | null
  src_in: number
  src_out: number
  text: string | null
  start: number | null
  end: number | null
  style: string | null
  gain: number | null
  effects: string[]
}

export interface TimelineDoc {
  version: number
  fps: number
  width: number
  height: number
  media: Record<string, MediaRef>
  tracks: Record<string, Track>
  clips: Record<string, Clip>
  grade: string | null
  music: string | null
}

export interface VideoDocView {
  width: number
  height: number
  fps: number
  duration: number
  media: Record<string, { src: string; duration: number; has_audio?: boolean }>
  clips: Array<{ id: string; media: string | null; src_in: number; src_out: number; order: number }>
  captions: Array<{ id: string; text: string | null; start: number | null; end: number | null; style: string | null }>
  music: string | null
  grade: string | null
}

export interface LocalVideoJobOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  onProgress?: (progress: number, stage?: string) => Promise<void> | void
}

interface VideoProbe {
  ok: boolean
  duration_s: number
  width: number | null
  height: number | null
  fps: number | null
  has_audio: boolean
  codec: string | null
  error?: string
}

interface FootageHealth {
  ok: boolean
  is_bad: boolean
  reasons: string[]
  duration_s: number
  width: number | null
  height: number | null
  fps: number | null
  has_audio: boolean
  codec: string | null
  probe_error?: string
}

export class VideoEditError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'])
const LOUDNESS_FILTER = 'loudnorm=I=-16:TP=-1.5:LRA=11'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function intOr(value: unknown, fallback: number): number {
  return Math.floor(numberOr(value, fallback))
}

function cleanProjectName(project: string): string {
  const tail = project.split(/[\\/]/).pop()?.trim() ?? ''
  if (!tail || tail === '.' || tail === '..' || tail.includes('\0')) {
    throw new VideoEditError('非法剪辑项目名', 400)
  }
  return basename(tail)
}

function normalizeMediaMap(value: unknown): Record<string, MediaRef> {
  const out: Record<string, MediaRef> = {}
  if (!isRecord(value)) return out
  for (const [id, raw] of Object.entries(value)) {
    if (!id || !isRecord(raw) || typeof raw.src !== 'string') continue
    out[id] = {
      src: raw.src,
      duration: Math.max(0, numberOr(raw.duration, 0)),
      kind: stringOr(raw.kind, 'video'),
      ...(typeof raw.has_audio === 'boolean' ? { has_audio: raw.has_audio } : {}),
    }
  }
  return out
}

function normalizeTracks(value: unknown): Record<string, Track> {
  const out: Record<string, Track> = {}
  if (!isRecord(value)) return out
  for (const [id, raw] of Object.entries(value)) {
    if (!id || !isRecord(raw)) continue
    out[id] = {
      kind: stringOr(raw.kind, 'video'),
      order: intOr(raw.order, 0),
    }
  }
  return out
}

function normalizeClips(value: unknown): Record<string, Clip> {
  const out: Record<string, Clip> = {}
  if (!isRecord(value)) return out
  for (const [id, raw] of Object.entries(value)) {
    if (!id || !isRecord(raw) || typeof raw.track !== 'string' || !raw.track.trim()) continue
    out[id] = {
      track: raw.track,
      order: intOr(raw.order, 0),
      media: stringOrNull(raw.media),
      src_in: numberOr(raw.src_in, 0),
      src_out: numberOr(raw.src_out, 0),
      text: stringOrNull(raw.text),
      start: raw.start === null || raw.start === undefined ? null : numberOr(raw.start, 0),
      end: raw.end === null || raw.end === undefined ? null : numberOr(raw.end, 0),
      style: stringOrNull(raw.style),
      gain: raw.gain === null || raw.gain === undefined ? null : numberOr(raw.gain, 0),
      effects: Array.isArray(raw.effects) ? raw.effects.filter((v): v is string => typeof v === 'string') : [],
    }
  }
  return out
}

export function normalizeTimelineDoc(value: unknown): TimelineDoc {
  const raw = isRecord(value) ? value : {}
  return {
    version: intOr(raw.version, 1),
    fps: intOr(raw.fps, 30),
    width: intOr(raw.width, 1080),
    height: intOr(raw.height, 1920),
    media: normalizeMediaMap(raw.media),
    tracks: normalizeTracks(raw.tracks),
    clips: normalizeClips(raw.clips),
    grade: stringOrNull(raw.grade),
    music: stringOrNull(raw.music),
  }
}

function cloneDoc(doc: TimelineDoc): TimelineDoc {
  return normalizeTimelineDoc(JSON.parse(JSON.stringify(doc)) as unknown)
}

function trackKind(doc: TimelineDoc, trackId: string): string | null {
  return doc.tracks[trackId]?.kind ?? null
}

function videoClipEntries(doc: TimelineDoc): Array<[string, Clip]> {
  return Object.entries(doc.clips)
    .filter(([, clip]) => trackKind(doc, clip.track) === 'video')
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
}

function captionClipEntries(doc: TimelineDoc): Array<[string, Clip]> {
  return Object.entries(doc.clips)
    .filter(([, clip]) => trackKind(doc, clip.track) === 'caption')
    .sort((a, b) => (a[1].start ?? 0) - (b[1].start ?? 0) || a[0].localeCompare(b[0]))
}

function duration(doc: TimelineDoc): number {
  const total = videoClipEntries(doc).reduce((sum, [, clip]) => sum + Math.max(0, clip.src_out - clip.src_in), 0)
  return Math.round(total * 1000) / 1000
}

function genId(existing: Record<string, unknown>, prefix: string): string {
  let i = 1
  while (`${prefix}${i}` in existing) i += 1
  return `${prefix}${i}`
}

function nextOrder(doc: TimelineDoc, track: string): number {
  const orders = Object.values(doc.clips).filter(clip => clip.track === track).map(clip => clip.order)
  return orders.length ? Math.max(...orders) + 1 : 0
}

function requireKeys(op: Record<string, unknown>, ...keys: string[]): void {
  for (const key of keys) {
    if (!(key in op)) throw new VideoEditError(`操作 ${String(op.op)} 缺必填参数 ${key}`, 400)
  }
}

function validateDoc(doc: TimelineDoc): string[] {
  const errors: string[] = []
  for (const [id, clip] of Object.entries(doc.clips)) {
    const track = doc.tracks[clip.track]
    if (!track) {
      errors.push(`片段 ${id} 指向不存在的轨道 ${clip.track}`)
      continue
    }
    if (track.kind === 'video' || track.kind === 'audio') {
      if (!clip.media) {
        errors.push(`片段 ${id}(${track.kind})缺 media`)
        continue
      }
      const media = doc.media[clip.media]
      if (!media) {
        errors.push(`片段 ${id} 指向不存在的媒体 ${clip.media}`)
        continue
      }
      if (clip.src_out <= clip.src_in) errors.push(`片段 ${id} 区间非法:src_in(${clip.src_in}) >= src_out(${clip.src_out})`)
      if (clip.src_in < 0 || clip.src_out > media.duration + 0.05) {
        errors.push(`片段 ${id} 超出源素材范围 [0,${media.duration}]:${clip.src_in}-${clip.src_out}`)
      }
    } else if (track.kind === 'caption') {
      if (!(clip.text ?? '').trim()) errors.push(`字幕 ${id} 缺文字`)
      if (clip.start === null || clip.end === null || clip.end <= clip.start) {
        errors.push(`字幕 ${id} 时间非法:start=${clip.start} end=${clip.end}`)
      }
    }
  }
  return errors
}

function applyOne(doc: TimelineDoc, op: Record<string, unknown>): void {
  const kind = op.op
  if (kind === 'add_media') {
    requireKeys(op, 'src', 'duration')
    const id = stringOr(op.id, genId(doc.media, 'm'))
    if (doc.media[id]) throw new VideoEditError(`媒体 id ${id} 已存在`, 400)
    doc.media[id] = { src: String(op.src), duration: numberOr(op.duration, 0), kind: stringOr(op.kind, 'video') }
    return
  }
  if (kind === 'add_track') {
    requireKeys(op, 'kind')
    const id = stringOr(op.id, genId(doc.tracks, 't'))
    if (doc.tracks[id]) throw new VideoEditError(`轨道 id ${id} 已存在`, 400)
    doc.tracks[id] = { kind: String(op.kind), order: intOr(op.order, Object.keys(doc.tracks).length) }
    return
  }
  if (kind === 'add_clip') {
    requireKeys(op, 'track')
    const id = stringOr(op.id, genId(doc.clips, 'c'))
    if (doc.clips[id]) throw new VideoEditError(`片段 id ${id} 已存在`, 400)
    const track = String(op.track)
    doc.clips[id] = {
      track,
      order: 'order' in op ? intOr(op.order, 0) : nextOrder(doc, track),
      media: stringOrNull(op.media),
      src_in: numberOr(op.src_in, 0),
      src_out: numberOr(op.src_out, 0),
      text: null,
      start: null,
      end: null,
      style: null,
      gain: null,
      effects: [],
    }
    return
  }
  if (kind === 'add_caption') {
    requireKeys(op, 'track', 'text', 'start', 'end')
    const id = stringOr(op.id, genId(doc.clips, 's'))
    if (doc.clips[id]) throw new VideoEditError(`字幕 id ${id} 已存在`, 400)
    doc.clips[id] = {
      track: String(op.track),
      order: 0,
      media: null,
      src_in: 0,
      src_out: 0,
      text: String(op.text),
      start: numberOr(op.start, 0),
      end: numberOr(op.end, 0),
      style: stringOrNull(op.style),
      gain: null,
      effects: [],
    }
    return
  }
  if (kind === 'remove_clip') {
    requireKeys(op, 'id')
    const id = String(op.id)
    if (!doc.clips[id]) throw new VideoEditError(`要删的片段 ${id} 不存在`, 400)
    delete doc.clips[id]
    return
  }
  if (kind === 'trim_clip') {
    requireKeys(op, 'id')
    const id = String(op.id)
    const clip = doc.clips[id]
    if (!clip) throw new VideoEditError(`要裁的片段 ${id} 不存在`, 400)
    if ('src_in' in op) clip.src_in = numberOr(op.src_in, clip.src_in)
    if ('src_out' in op) clip.src_out = numberOr(op.src_out, clip.src_out)
    return
  }
  if (kind === 'reorder_clip') {
    requireKeys(op, 'id', 'order')
    const id = String(op.id)
    const clip = doc.clips[id]
    if (!clip) throw new VideoEditError(`要排序的片段 ${id} 不存在`, 400)
    clip.order = intOr(op.order, clip.order)
    return
  }
  if (kind === 'edit_caption') {
    requireKeys(op, 'id')
    const id = String(op.id)
    const clip = doc.clips[id]
    if (!clip) throw new VideoEditError(`要改的字幕 ${id} 不存在`, 400)
    if ('text' in op) clip.text = String(op.text)
    if ('style' in op) clip.style = stringOrNull(op.style)
    if ('start' in op) clip.start = numberOr(op.start, clip.start ?? 0)
    if ('end' in op) clip.end = numberOr(op.end, clip.end ?? 0)
    return
  }
  if (kind === 'set_music') {
    requireKeys(op, 'media')
    doc.music = String(op.media)
    return
  }
  if (kind === 'set_grade') {
    doc.grade = stringOrNull(op.grade)
    return
  }
  throw new VideoEditError(`未知操作:${String(kind)}(支持:add_media, add_track, add_clip, add_caption, remove_clip, trim_clip, reorder_clip, edit_caption, set_music, set_grade)`, 400)
}

function contentTypeForVideo(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.mkv') return 'video/x-matroska'
  if (ext === '.avi') return 'video/x-msvideo'
  return 'video/mp4'
}

function ratioFor(doc: TimelineDoc): string {
  if (doc.width === doc.height) return '1:1'
  if (doc.height > doc.width) return '9:16'
  return '16:9'
}

function shortText(value: string, max = 36): string {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

function roundSeconds(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000
}

function dimensionsForRatio(ratio: unknown): { width: number; height: number; ratio: string } {
  if (ratio === '1:1') return { width: 1080, height: 1080, ratio }
  if (ratio === '16:9') return { width: 1920, height: 1080, ratio }
  return { width: 1080, height: 1920, ratio: '9:16' }
}

function ffmpegBin(env: Record<string, string | undefined> | undefined): string {
  return env?.FFMPEG_BIN?.trim() || env?.FFMPEG_PATH?.trim() || 'ffmpeg'
}

function ffprobeBin(env: Record<string, string | undefined> | undefined): string {
  return env?.FFPROBE_BIN?.trim() || env?.FFPROBE_PATH?.trim() || 'ffprobe'
}

function ffconcatPath(path: string): string {
  return path.replaceAll("'", "'\\''")
}

function escapeSubtitleFilterPath(path: string): string {
  return path.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

function srtTimestamp(seconds: number): string {
  const msTotal = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(msTotal / 3_600_000)
  const minutes = Math.floor((msTotal % 3_600_000) / 60_000)
  const secs = Math.floor((msTotal % 60_000) / 1000)
  const ms = msTotal % 1000
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`
}

function captionsToSrt(captions: Array<[string, Clip]>, totalDuration: number): string {
  let index = 1
  const blocks: string[] = []
  for (const [, clip] of captions) {
    const text = (clip.text ?? '').trim()
    if (!text || clip.start === null || clip.end === null) continue
    const start = clamp(clip.start, 0, totalDuration)
    const end = clamp(clip.end, start + 0.1, totalDuration || start + 0.1)
    blocks.push(`${index}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${text}`)
    index += 1
  }
  return `${blocks.join('\n\n')}\n`
}

async function runProcess(command: string, args: string[], opts: { signal?: AbortSignal; cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  if (opts.signal?.aborted) throw new Error('任务已取消')
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const onAbort = () => child.kill('SIGTERM')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', err => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', code => {
      opts.signal?.removeEventListener('abort', onAbort)
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (opts.signal?.aborted) reject(new Error('任务已取消'))
      else if (code === 0) resolvePromise({ stdout: out, stderr: err })
      else reject(new Error(`${basename(command)} failed ${code}:${err.slice(-2000)}`))
    })
  })
}

function parseFps(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim() || value === '0/0') return null
  const parts = value.split('/').map(Number)
  const a = parts[0]
  const b = parts[1]
  const fps = a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && b ? a / b : Number(value)
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null
}

async function probeVideo(path: string, opts: LocalVideoJobOptions = {}): Promise<VideoProbe> {
  if (opts.signal?.aborted) throw new Error('任务已取消')
  if (/^https?:/i.test(path)) {
    return { ok: false, duration_s: 0, width: null, height: null, fps: null, has_audio: false, codec: null, error: '远程素材未做本地探测' }
  }
  try {
    const { stdout } = await runProcess(ffprobeBin(opts.env), [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      path,
    ], { signal: opts.signal })
    const parsed = JSON.parse(stdout || '{}') as unknown
    const root = isRecord(parsed) ? parsed : {}
    const streams = Array.isArray(root.streams) ? root.streams.filter(isRecord) : []
    const video = streams.find(stream => stream.codec_type === 'video')
    const hasAudio = streams.some(stream => stream.codec_type === 'audio')
    const format = isRecord(root.format) ? root.format : {}
    const durationValue = numberOr(video?.duration, numberOr(format.duration, 0))
    return {
      ok: !!video && durationValue > 0,
      duration_s: roundSeconds(durationValue),
      width: video ? intOr(video.width, 0) || null : null,
      height: video ? intOr(video.height, 0) || null : null,
      fps: parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate),
      has_audio: hasAudio,
      codec: typeof video?.codec_name === 'string' ? video.codec_name : null,
      ...(!video ? { error: '没有视频轨' } : {}),
    }
  } catch (error) {
    if (opts.signal?.aborted) throw new Error('任务已取消')
    return {
      ok: false,
      duration_s: 0,
      width: null,
      height: null,
      fps: null,
      has_audio: false,
      codec: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function footageHealth(probe: VideoProbe, mode: string): FootageHealth {
  const reasons: string[] = []
  if (!probe.ok) reasons.push('无法读取视频规格，已按默认时长处理')
  if (probe.duration_s > 0 && probe.duration_s < 1) reasons.push('素材时长过短')
  if (probe.width !== null && probe.height !== null && (probe.width < 320 || probe.height < 320)) reasons.push('分辨率偏低')
  if (mode === 'speech' && probe.ok && !probe.has_audio) reasons.push('口播模式需要音轨，但这段素材没有音轨')
  const isBad = !probe.ok || probe.duration_s < 1 || (mode === 'speech' && !probe.has_audio)
  return {
    ok: reasons.length === 0,
    is_bad: isBad,
    reasons,
    duration_s: probe.duration_s,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    has_audio: probe.has_audio,
    codec: probe.codec,
    ...(probe.error ? { probe_error: probe.error } : {}),
  }
}

export class VideoEditProjectStore {
  private readonly uploadsRoot: string

  constructor(stateRoot: string) {
    this.uploadsRoot = join(stateRoot, 'uploads')
  }

  async loadDoc(project: string): Promise<TimelineDoc | null> {
    const path = await this.docPath(project)
    if (!existsSync(path)) return null
    const raw = await readFile(path, 'utf8')
    return normalizeTimelineDoc(JSON.parse(raw) as unknown)
  }

  async saveDoc(project: string, doc: TimelineDoc): Promise<void> {
    const path = await this.docPath(project)
    await writeFile(path, `${JSON.stringify(doc)}\n`, 'utf8')
  }

  async getProject(project: string): Promise<{ project: string; doc: VideoDocView }> {
    const safeProject = cleanProjectName(project)
    const doc = await this.loadDoc(safeProject)
    if (!doc) throw new VideoEditError('没找到这个剪辑项目', 404)
    return { project: safeProject, doc: this.docView(doc) }
  }

  async applyOperations(project: string, operations: unknown): Promise<{ ok: boolean; errors: string[]; doc: VideoDocView }> {
    const safeProject = cleanProjectName(project)
    const doc = await this.loadDoc(safeProject)
    if (!doc) throw new VideoEditError('没找到这个剪辑项目(先 inventory)', 404)
    const ops = Array.isArray(operations) ? operations.filter(isRecord) : []
    const work = cloneDoc(doc)
    for (let i = 0; i < ops.length; i++) {
      try {
        applyOne(work, ops[i]!)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, errors: [`第${i + 1}步操作失败:${message}`], doc: this.docView(doc) }
      }
    }
    const errors = validateDoc(work)
    if (errors.length) return { ok: false, errors, doc: this.docView(doc) }
    await this.saveDoc(safeProject, work)
    return { ok: true, errors: [], doc: this.docView(work) }
  }

  async autoCaption(project: string, track: unknown): Promise<{ ok: boolean; added: number; errors?: string[]; doc: VideoDocView; local_preview?: boolean; message?: string }> {
    const safeProject = cleanProjectName(project)
    const doc = await this.loadDoc(safeProject)
    if (!doc) throw new VideoEditError('没找到这个剪辑项目', 404)
    const videos = videoClipEntries(doc)
    if (!videos.length) throw new VideoEditError('还没挑视频片段', 400)
    const existingCaptions = captionClipEntries(doc)
    if (existingCaptions.length) return { ok: true, added: 0, doc: this.docView(doc) }

    let trackId = stringOr(track, 'sub')
    if (doc.tracks[trackId] && doc.tracks[trackId]!.kind !== 'caption') trackId = genId(doc.tracks, 'sub')
    if (!doc.tracks[trackId]) doc.tracks[trackId] = { kind: 'caption', order: Object.keys(doc.tracks).length }

    let cursor = 0
    for (let i = 0; i < videos.length; i++) {
      const [, clip] = videos[i]!
      const length = Math.max(0.1, clip.src_out - clip.src_in)
      const id = genId(doc.clips, 's')
      doc.clips[id] = {
        track: trackId,
        order: 0,
        media: null,
        src_in: 0,
        src_out: 0,
        text: `镜头 ${i + 1}`,
        start: Math.round(cursor * 1000) / 1000,
        end: Math.round((cursor + length) * 1000) / 1000,
        style: null,
        gain: null,
        effects: [],
      }
      cursor += length
    }
    await this.saveDoc(safeProject, doc)
    return {
      ok: true,
      added: videos.length,
      doc: this.docView(doc),
      local_preview: true,
      message: '媒体后端未配置，TS 本地只生成占位字幕；真实口播识别仍需媒体后端。',
    }
  }

  async recaption(project: string, tonality: unknown): Promise<{ ok: boolean; brand: string; captions: string[]; local_preview: boolean; message: string }> {
    const safeProject = cleanProjectName(project)
    const doc = await this.loadDoc(safeProject)
    if (!doc) throw new VideoEditError('这个项目还没出过 V2 方案(先 /auto_plan_v2)', 404)
    const captions = await this.ensureCaptionText(doc, stringOr(tonality, '换一种更适合门店的表达'))
    await this.saveDoc(safeProject, doc)
    return {
      ok: true,
      brand: '本地预览',
      captions,
      local_preview: true,
      message: '媒体后端未配置，TS 本地只按反馈生成占位文案；真实文案重写仍需媒体后端。',
    }
  }

  async editFeedback(project: string, feedback: unknown): Promise<{
    ok: boolean
    reply: string
    brand: string
    shots: Array<{ src: string; start: number; end: number; caption: string }>
    grade?: string | null
    ratio?: string
    music_mood?: string | null
    local_preview: boolean
  }> {
    const safeProject = cleanProjectName(project)
    const doc = await this.loadDoc(safeProject)
    if (!doc) throw new VideoEditError('这个项目还没出过 V2 方案(先 /auto_plan_v2)', 404)
    const captions = await this.ensureCaptionText(doc, stringOr(feedback, '按当前素材生成门店短片文案'))
    await this.saveDoc(safeProject, doc)
    const shots = videoClipEntries(doc).map(([, clip], index) => ({
      src: clip.media ? doc.media[clip.media]?.src ?? '' : '',
      start: clip.src_in,
      end: clip.src_out,
      caption: captions[index] ?? '',
    }))
    return {
      ok: true,
      reply: '媒体后端未配置，已保留当前镜头并生成本地占位文案；真实换段、改序和智能重写需要媒体后端。',
      brand: '本地预览',
      shots,
      grade: doc.grade,
      ratio: ratioFor(doc),
      music_mood: doc.music,
      local_preview: true,
    }
  }

  async createLocalPlan(input: Record<string, unknown>, opts: LocalVideoJobOptions = {}): Promise<Record<string, unknown>> {
    const project = cleanProjectName(stringOr(input.project, `local_${Date.now()}`))
    const paths = stringArray(input.video_paths ?? input.paths)
    if (!paths.length) throw new VideoEditError('请先选择要剪的视频素材', 400)
    const targetDuration = clamp(numberOr(input.target_duration, 16), 3, 180)
    const perClip = clamp(targetDuration / paths.length, 2, 8)
    const mode = stringOr(input.mode, 'ambient')
    const sources: Array<{ raw: string; src: string; probe: VideoProbe; health: FootageHealth }> = []

    await opts.onProgress?.(8, '正在检查本地素材规格。')
    for (let i = 0; i < paths.length; i++) {
      const raw = paths[i]!
      const src = this.resolveMediaSource(raw)
      if (!/^https?:/i.test(src) && !existsSync(src)) throw new VideoEditError(`找不到素材:${raw}`, 404)
      const probe = await probeVideo(src, opts)
      const health = footageHealth(probe, mode)
      sources.push({ raw, src, probe, health })
      await opts.onProgress?.(Math.min(35, 8 + Math.floor(((i + 1) / paths.length) * 24)), '正在读取素材时长和音轨。')
    }

    const sized = dimensionsForRatio(input.ratio)
    const doc: TimelineDoc = {
      version: 1,
      fps: 30,
      width: sized.width,
      height: sized.height,
      media: {},
      tracks: {
        v1: { kind: 'video', order: 0 },
        sub: { kind: 'caption', order: 1 },
      },
      clips: {},
      grade: null,
      music: null,
    }

    await opts.onProgress?.(38, '正在创建本地剪辑方案。')
    let cursor = 0
    const footageHealthById: Record<string, FootageHealth & { src: string; name: string }> = {}
    const warnings: string[] = []
    const candidates: Array<{ media: string; name: string; duration: number; is_portrait: boolean; has_speech: boolean; scenes: [number, number][]; phrases: Array<{ start: number; end: number; text: string }> }> = []
    for (let i = 0; i < sources.length; i++) {
      const item = sources[i]!
      const mediaId = `m${i + 1}`
      const clipId = `c${i + 1}`
      const captionId = `s${i + 1}`
      const realDuration = item.probe.ok && item.probe.duration_s > 0 ? item.probe.duration_s : perClip
      const duration = roundSeconds(realDuration)
      const clipDuration = roundSeconds(clamp(Math.min(perClip, duration || perClip), 0.05, perClip))
      const name = basename(item.src)
      footageHealthById[mediaId] = { ...item.health, src: item.src, name }
      for (const reason of item.health.reasons) warnings.push(`素材 ${i + 1}「${name}」：${reason}`)
      candidates.push({
        media: mediaId,
        name,
        duration,
        is_portrait: (item.probe.height ?? 0) > (item.probe.width ?? 0),
        has_speech: item.health.has_audio,
        scenes: [[0, clipDuration]],
        phrases: [],
      })
      doc.media[mediaId] = { src: item.src, duration, kind: 'video', has_audio: item.health.has_audio }
      doc.clips[clipId] = {
        track: 'v1',
        order: i,
        media: mediaId,
        src_in: 0,
        src_out: clipDuration,
        text: null,
        start: null,
        end: null,
        style: null,
        gain: null,
        effects: [],
      }
      doc.clips[captionId] = {
        track: 'sub',
        order: 0,
        media: null,
        src_in: 0,
        src_out: 0,
        text: mode === 'speech' ? `口播片段 ${i + 1}` : `门店高光 ${i + 1}`,
        start: Math.round(cursor * 1000) / 1000,
        end: Math.round((cursor + clipDuration) * 1000) / 1000,
        style: null,
        gain: null,
        effects: [],
      }
      cursor += clipDuration
      await opts.onProgress?.(Math.min(78, 38 + Math.floor(((i + 1) / sources.length) * 36)), '正在整理本地时间线。')
    }
    await this.saveDoc(project, doc)
    const captions = captionClipEntries(doc).map(([, clip]) => clip.text ?? '')
    await opts.onProgress?.(100, '本地剪辑方案已创建。')
    const healthValues = Object.values(footageHealthById)
    const warningTail = warnings.length ? ` 素材提醒:${warnings.slice(0, 3).join('；')}${warnings.length > 3 ? `；另有 ${warnings.length - 3} 条` : ''}` : ''
    return {
      project,
      report: `TS 本地模式已按素材顺序创建可预览时间线，并读取了可用的本地时长/音轨信息；真实转写、VLM 挑高光和智能换段仍需媒体后端。${warningTail}`,
      brand: '本地预览',
      captions,
      candidates,
      footage_health: footageHealthById,
      footage_warnings: warnings,
      warnings,
      health_summary: {
        total: healthValues.length,
        bad: healthValues.filter(item => item.is_bad).length,
        warning_count: warnings.length,
        has_audio: healthValues.some(item => item.has_audio),
      },
      used_vlm: false,
      has_speech: mode === 'speech' && healthValues.some(item => item.has_audio),
      local_preview: true,
    }
  }

  async renderProject(project: string, input: Record<string, unknown> = {}, opts: LocalVideoJobOptions = {}): Promise<Record<string, unknown>> {
    const safeProject = cleanProjectName(project)
    const doc = await this.loadDoc(safeProject)
    if (!doc) throw new VideoEditError('没找到这个剪辑项目', 404)
    const errors = validateDoc(doc)
    if (errors.length) throw new VideoEditError(`时间线不能出片:${errors.join(';')}`, 400)
    const clips = videoClipEntries(doc).filter(([, clip]) => clip.media && doc.media[clip.media])
    if (!clips.length) throw new VideoEditError('时间线里没有可出片的视频片段', 400)

    const command = ffmpegBin(opts.env)
    const tempDir = await mkdtemp(join(tmpdir(), `qf-video-${safeProject}-`))
    const outputDir = join(this.uploadsRoot, 'videos')
    await mkdir(outputDir, { recursive: true })
    const stem = `video_edit_${safeProject}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
    const outputPath = join(outputDir, `${stem}.mp4`)
    const concatPath = join(tempDir, 'concat.mp4')
    try {
      await opts.onProgress?.(8, '正在准备本地视频出片。')
      const renderItems: Array<{ clip: Clip; src: string; hasAudio: boolean }> = []
      for (const [, clip] of clips) {
        const media = doc.media[clip.media!]!
        const src = this.resolveMediaSource(media.src)
        if (!/^https?:/i.test(src) && !existsSync(src)) throw new VideoEditError(`找不到素材:${media.src}`, 404)
        let hasAudio = media.has_audio
        if (hasAudio === undefined) {
          hasAudio = (await probeVideo(src, opts)).has_audio
        }
        renderItems.push({ clip, src, hasAudio })
      }
      const wantsLoudness = input.normalize_audio !== false
      const audioLoudnessNormalized = wantsLoudness && renderItems.every(item => item.hasAudio)
      const caveats: string[] = []
      if (wantsLoudness && !audioLoudnessNormalized) caveats.push('检测到部分片段没有音轨，已跳过响度标准化。')

      const segments: string[] = []
      for (let i = 0; i < renderItems.length; i++) {
        const { clip, src } = renderItems[i]!
        const segmentPath = join(tempDir, `segment_${i + 1}.mp4`)
        const length = Math.max(0.1, clip.src_out - clip.src_in)
        await opts.onProgress?.(12 + Math.floor((i / renderItems.length) * 60), `正在剪第 ${i + 1}/${renderItems.length} 段。`)
        const segmentArgs = [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', String(Math.max(0, clip.src_in)),
          '-t', String(length),
          '-i', src,
          '-map', '0:v:0',
          '-map', '0:a?',
          '-vf', `scale=${doc.width}:${doc.height}:force_original_aspect_ratio=decrease,pad=${doc.width}:${doc.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${doc.fps}`,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p',
        ]
        if (audioLoudnessNormalized) segmentArgs.push('-af', LOUDNESS_FILTER)
        segmentArgs.push(
          '-c:a', 'aac',
          '-ar', '48000',
          '-ac', '2',
          segmentPath,
        )
        await runProcess(command, segmentArgs, { signal: opts.signal })
        segments.push(segmentPath)
      }

      const listPath = join(tempDir, 'concat.txt')
      await writeFile(listPath, segments.map(path => `file '${ffconcatPath(path)}'`).join('\n'), 'utf8')
      const captions = captionClipEntries(doc)
      const totalDuration = duration(doc)
      const hasCaptions = captions.some(([, clip]) => (clip.text ?? '').trim())
      await opts.onProgress?.(82, '正在合成视频片段。')
      await runProcess(command, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', hasCaptions ? concatPath : outputPath], { signal: opts.signal })

      let captionUrl: string | undefined
      if (hasCaptions) {
        const srtPath = join(outputDir, `${stem}.srt`)
        const tempSrt = join(tempDir, 'captions.srt')
        const srt = captionsToSrt(captions, totalDuration)
        await writeFile(srtPath, srt, 'utf8')
        await writeFile(tempSrt, srt, 'utf8')
        captionUrl = `/uploads/videos/${basename(srtPath)}`
        await opts.onProgress?.(92, '正在烧录字幕。')
        try {
          await runProcess(command, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', concatPath,
            '-vf', `subtitles=${escapeSubtitleFilterPath(tempSrt)}`,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'copy',
            outputPath,
          ], { signal: opts.signal })
        } catch {
          await copyFile(concatPath, outputPath)
          caveats.push('字幕文件已导出，但当前 ffmpeg 不支持烧录字幕，成片未内嵌字幕。')
        }
      }

      await opts.onProgress?.(100, '本地视频已出片。')
      const url = `/uploads/videos/${basename(outputPath)}`
      return {
        urls: [url],
        video_url: url,
        caption_url: captionUrl,
        project: safeProject,
        output_name: stringOr(input.output_name, '成片'),
        duration: totalDuration,
        width: doc.width,
        height: doc.height,
        fps: doc.fps,
        provider: 'ts-ffmpeg',
        render_engine: 'ffmpeg',
        audio_loudness_normalized: audioLoudnessNormalized,
        ...(audioLoudnessNormalized ? { audio_loudness_filter: LOUDNESS_FILTER } : {}),
        local_preview: false,
        caveat: caveats.length ? caveats.join(' ') : undefined,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async localFileResponse(pathValue: string | null, rangeHeader: string | null): Promise<Response> {
    const raw = pathValue?.trim()
    if (!raw) return Response.json({ ok: false, detail: '缺少视频文件路径' }, { status: 400 })
    const path = resolve(raw)
    const ext = extname(path).toLowerCase()
    if (!VIDEO_EXT.has(ext)) return Response.json({ ok: false, detail: '视频格式不支持' }, { status: 400 })
    let info
    try {
      info = await stat(path)
    } catch {
      return Response.json({ ok: false, detail: '找不到该视频或格式不支持' }, { status: 404 })
    }
    if (!info.isFile()) return Response.json({ ok: false, detail: '找不到该视频或格式不支持' }, { status: 404 })
    const size = info.size
    const type = contentTypeForVideo(path)
    const file = Bun.file(path)
    const baseHeaders = { 'Accept-Ranges': 'bytes', 'Content-Type': type }
    const range = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/)
    if (!range) return new Response(file, { headers: baseHeaders })

    const start = Math.min(Number.parseInt(range[1]!, 10), Math.max(0, size - 1))
    const end = range[2] ? Math.min(Number.parseInt(range[2], 10), size - 1) : size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` } })
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      },
    })
  }

  private async docPath(project: string): Promise<string> {
    const dir = join(this.uploadsRoot, 'edits', cleanProjectName(project))
    await mkdir(dir, { recursive: true })
    return join(dir, 'timeline.json')
  }

  private resolveMediaSource(value: string): string {
    const raw = value.trim()
    if (/^https?:/i.test(raw)) return raw
    if (/^file:/i.test(raw)) return fileURLToPath(raw)
    if (raw.startsWith('/uploads/')) {
      const rel = raw.slice('/uploads/'.length)
      const abs = resolve(this.uploadsRoot, rel)
      const root = resolve(this.uploadsRoot)
      if (abs !== root && !abs.startsWith(`${root}/`)) throw new VideoEditError('素材路径越界', 400)
      return abs
    }
    return resolve(raw)
  }

  private docView(doc: TimelineDoc): VideoDocView {
    return {
      width: doc.width,
      height: doc.height,
      fps: doc.fps,
      duration: duration(doc),
      media: Object.fromEntries(Object.entries(doc.media).map(([id, media]) => [id, {
        src: media.src,
        duration: media.duration,
        ...(typeof media.has_audio === 'boolean' ? { has_audio: media.has_audio } : {}),
      }])),
      clips: videoClipEntries(doc).map(([id, clip]) => ({
        id,
        media: clip.media,
        src_in: clip.src_in,
        src_out: clip.src_out,
        order: clip.order,
      })),
      captions: captionClipEntries(doc).map(([id, clip]) => ({
        id,
        text: clip.text,
        start: clip.start,
        end: clip.end,
        style: clip.style,
      })),
      music: doc.music,
      grade: doc.grade,
    }
  }

  private async ensureCaptionText(doc: TimelineDoc, instruction: string): Promise<string[]> {
    const clips = videoClipEntries(doc)
    if (!clips.length) return []
    const captionText = shortText(instruction, 28)
    let captions = captionClipEntries(doc)
    if (!captions.length) {
      let trackId = 'sub'
      if (doc.tracks[trackId] && doc.tracks[trackId]!.kind !== 'caption') trackId = genId(doc.tracks, 'sub')
      if (!doc.tracks[trackId]) doc.tracks[trackId] = { kind: 'caption', order: Object.keys(doc.tracks).length }
      let cursor = 0
      for (let i = 0; i < clips.length; i++) {
        const [, clip] = clips[i]!
        const length = Math.max(0.1, clip.src_out - clip.src_in)
        const id = genId(doc.clips, 's')
        doc.clips[id] = {
          track: trackId,
          order: 0,
          media: null,
          src_in: 0,
          src_out: 0,
          text: `${captionText} · 镜头${i + 1}`,
          start: Math.round(cursor * 1000) / 1000,
          end: Math.round((cursor + length) * 1000) / 1000,
          style: null,
          gain: null,
          effects: [],
        }
        cursor += length
      }
      captions = captionClipEntries(doc)
    } else {
      for (let i = 0; i < captions.length; i++) {
        captions[i]![1].text = `${captionText} · 镜头${i + 1}`
      }
    }
    return captions.map(([, clip]) => clip.text ?? '')
  }
}
