import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

export interface MediaRef {
  src: string
  duration: number
  kind: string
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
  media: Record<string, { src: string; duration: number }>
  clips: Array<{ id: string; media: string | null; src_in: number; src_out: number; order: number }>
  captions: Array<{ id: string; text: string | null; start: number | null; end: number | null; style: string | null }>
  music: string | null
  grade: string | null
}

export class VideoEditError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'])

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

  private docView(doc: TimelineDoc): VideoDocView {
    return {
      width: doc.width,
      height: doc.height,
      fps: doc.fps,
      duration: duration(doc),
      media: Object.fromEntries(Object.entries(doc.media).map(([id, media]) => [id, { src: media.src, duration: media.duration }])),
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
