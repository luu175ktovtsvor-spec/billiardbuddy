import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  legacyTimelineV1Schema,
  videoCreateProjectRequestSchema,
  videoOperationSchema,
  videoProjectSchema,
  videoSceneSchema,
  type VideoAlternative,
  type VideoCreateProjectInput,
  type VideoOperation,
  type VideoProject,
  type VideoScene,
  type VideoSource,
  type VideoSourceRange,
} from '../../../shared/contracts/video-edit'
import { VideoUsageHistory } from './planning/usageHistory'
import { applyAudioClock } from './planning/audio'
import { solveGraphics } from './planning/graphics'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const HISTORY_LIMIT = 30
const SOURCE_OFFLINE_WARNING = '原素材已离线，请重新定位后继续预览或导出'

type HistoryEntry = {
  id: string
  kind: 'operation' | 'alternative' | 'undo' | 'redo' | 'migration'
  at: string
  before: VideoProject
  after: VideoProject
  operations?: VideoOperation[]
  undo_stack: VideoProject[]
  redo_stack: VideoProject[]
}

export class VideoProjectError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'VideoProjectError'
  }
}

function now(): string {
  return new Date().toISOString()
}

function projectId(): string {
  return `video-${Date.now()}-${randomUUID().slice(0, 8)}`
}

function canvasForRatio(ratio: '9:16' | '1:1' | '16:9') {
  if (ratio === '1:1') return { width: 1080, height: 1080, ratio }
  if (ratio === '16:9') return { width: 1920, height: 1080, ratio }
  return { width: 1080, height: 1920, ratio }
}

async function fingerprintFile(path: string): Promise<string> {
  const info = await stat(path)
  const handle = await open(path, 'r')
  try {
    const first = Buffer.alloc(Math.min(1024 * 1024, info.size))
    if (first.length) await handle.read(first, 0, first.length, 0)
    const tailSize = Math.min(1024 * 1024, Math.max(0, info.size - first.length))
    const tail = Buffer.alloc(tailSize)
    if (tail.length) await handle.read(tail, 0, tail.length, Math.max(0, info.size - tail.length))
    return createHash('sha256').update(String(info.size)).update(first).update(tail).digest('hex')
  } finally {
    await handle.close()
  }
}

async function sourceFromPath(pathValue: string, role: VideoSource['role'] = 'unclassified'): Promise<VideoSource> {
  const path = resolve(pathValue)
  let info
  try {
    info = await stat(path)
  } catch {
    throw new VideoProjectError(`找不到视频素材:${basename(path)}`, 'source_missing', 404, { path })
  }
  if (!info.isFile() || !VIDEO_EXTENSIONS.has(extname(path).toLowerCase())) {
    throw new VideoProjectError(`不支持的视频素材:${basename(path)}`, 'unsupported_source', 415, { path })
  }
  return videoProjectSchema.shape.sources.element.parse({
    id: `source-${randomUUID().slice(0, 12)}`,
    file_uri: path,
    name: basename(path),
    fingerprint: await fingerprintFile(path),
    role,
  })
}

function sceneDuration(scene: VideoScene): number {
  const primary = scene.video_layers.find(layer => layer.role === 'primary' && layer.enabled) ?? scene.video_layers[0]
  if (!primary) return Math.max(1, scene.output_range.end_ms - scene.output_range.start_ms)
  return Math.max(1, Math.round((primary.source_range.out_ms - primary.source_range.in_ms) / primary.speed))
}

export function normalizeSceneOutputRanges(project: VideoProject): VideoProject {
  let cursor = 0
  project.scenes.sort((a, b) => a.order - b.order).forEach((scene, index) => {
    scene.order = index
    const duration = sceneDuration(scene)
    if (!scene.deleted) {
      scene.output_range = { start_ms: cursor, end_ms: cursor + duration }
      cursor += duration
    }
  })
  return project
}

function cloneProject(project: VideoProject): VideoProject {
  return videoProjectSchema.parse(structuredClone(project))
}

function refreshSourceAvailability(project: VideoProject): VideoProject {
  for (const source of project.sources) {
    const missing = !/^https?:/i.test(source.file_uri) && !existsSync(source.file_uri)
    source.missing = missing
    source.warnings = source.warnings.filter(warning => warning !== SOURCE_OFFLINE_WARNING)
    if (missing) source.warnings.push(SOURCE_OFFLINE_WARNING)
  }
  return project
}

function repairProjectCompatibility(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const project = value as Record<string, unknown>
  const scenes = Array.isArray(project.scenes) ? project.scenes : []
  let repaired = false
  for (const rawScene of scenes) {
    if (!rawScene || typeof rawScene !== 'object' || Array.isArray(rawScene)) continue
    const scene = rawScene as Record<string, unknown>
    const clock = scene.edit_clock
    const layers = Array.isArray(scene.audio_layers) ? scene.audio_layers : []
    const expected = (role: unknown) => clock === 'dialogue'
      ? role === 'speech'
      : clock === 'music'
        ? role === 'music'
        : role === 'ambience' || role === 'sfx'
    const enabledOwners = layers.filter(layer => layer && typeof layer === 'object' && !Array.isArray(layer) && (layer as Record<string, unknown>).enabled !== false && (layer as Record<string, unknown>).owner === true)
    if (enabledOwners.length <= 1 && (!enabledOwners[0] || expected((enabledOwners[0] as Record<string, unknown>).role))) continue
    let assigned = false
    for (const rawLayer of layers) {
      if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) continue
      const layer = rawLayer as Record<string, unknown>
      const owner = layer.enabled !== false && expected(layer.role) && !assigned
      layer.owner = owner
      if (owner) assigned = true
    }
    repaired = true
  }
  if (repaired && project.status && typeof project.status === 'object' && !Array.isArray(project.status)) {
    const status = project.status as Record<string, unknown>
    const warnings = Array.isArray(status.warnings) ? status.warnings.filter(item => typeof item === 'string') as string[] : []
    status.warnings = [...new Set([...warnings, '旧项目音频主层已按 Scene 时钟完成兼容修正'])]
  }
  return project
}

function requireScene(project: VideoProject, id: string): VideoScene {
  const scene = project.scenes.find(item => item.id === id)
  if (!scene) throw new VideoProjectError('找不到要编辑的 Scene', 'scene_not_found', 404, { scene_id: id })
  return scene
}

function requireSource(project: VideoProject, id: string): VideoSource {
  const source = project.sources.find(item => item.id === id)
  if (!source) throw new VideoProjectError('找不到要编辑的素材', 'source_not_found', 404, { source_id: id })
  return source
}

function setPrimaryRange(scene: VideoScene, range: VideoSourceRange) {
  scene.source_ranges[0] = range
  const primary = scene.video_layers.find(layer => layer.role === 'primary') ?? scene.video_layers[0]
  if (primary) primary.source_range = range
}

function setSceneRange(scene: VideoScene, range: VideoSourceRange) {
  setPrimaryRange(scene, range)
  scene.source_ranges[0] = range
  for (const layer of scene.audio_layers) {
    if (layer.source_range?.source_id === range.source_id) layer.source_range = range
  }
}

function uniqueSceneId(project: VideoProject): string {
  let id = `scene-${randomUUID().slice(0, 12)}`
  while (project.scenes.some(scene => scene.id === id)) id = `scene-${randomUUID().slice(0, 12)}`
  return id
}

function applyOperation(project: VideoProject, operation: VideoOperation): string[] {
  switch (operation.type) {
    case 'scene.move': {
      const scene = requireScene(project, operation.scene_id)
      project.scenes = project.scenes.filter(item => item.id !== scene.id)
      project.scenes.splice(Math.min(operation.to_index, project.scenes.length), 0, scene)
      return [scene.id]
    }
    case 'scene.split': {
      const scene = requireScene(project, operation.scene_id)
      const primary = scene.video_layers.find(layer => layer.role === 'primary') ?? scene.video_layers[0]
      if (!primary || operation.at_source_ms <= primary.source_range.in_ms || operation.at_source_ms >= primary.source_range.out_ms) {
        throw new VideoProjectError('拆分点必须位于当前 Scene 的素材区间内', 'invalid_split_point', 409)
      }
      const firstRange = { ...primary.source_range, out_ms: operation.at_source_ms }
      const secondRange = { ...primary.source_range, in_ms: operation.at_source_ms }
      setSceneRange(scene, firstRange)
      const next = structuredClone(scene)
      next.id = uniqueSceneId(project)
      next.video_layers = next.video_layers.map(layer => ({ ...layer, id: `layer-${randomUUID().slice(0, 8)}` }))
      next.audio_layers = next.audio_layers.map(layer => ({ ...layer, id: `audio-${randomUUID().slice(0, 8)}` }))
      next.graphics = next.graphics.map(graphic => ({ ...graphic, id: `graphic-${randomUUID().slice(0, 8)}` }))
      setSceneRange(next, secondRange)
      if (next.dialogue) {
        next.dialogue = { ...next.dialogue, original_text: '', semantic_text: '', display_text: '', transcript_ref: undefined }
        next.needs_review = [...next.needs_review, '拆分点尚未重新对齐文字，请在文字稿中确认第二段内容']
      }
      const index = project.scenes.findIndex(item => item.id === scene.id)
      project.scenes.splice(index + 1, 0, next)
      return [scene.id, next.id]
    }
    case 'scene.merge': {
      const scene = requireScene(project, operation.scene_id)
      const next = requireScene(project, operation.next_scene_id)
      if (next.order !== scene.order + 1) throw new VideoProjectError('只能合并相邻 Scene', 'scenes_not_adjacent', 409)
      const firstLayer = scene.video_layers.find(layer => layer.role === 'primary') ?? scene.video_layers[0]
      const nextLayer = next.video_layers.find(layer => layer.role === 'primary') ?? next.video_layers[0]
      if (!firstLayer || !nextLayer || firstLayer.source_range.source_id !== nextLayer.source_range.source_id || Math.abs(firstLayer.source_range.out_ms - nextLayer.source_range.in_ms) > 200) {
        throw new VideoProjectError('当前两个 Scene 不是同一素材的连续区间，不能无损合并', 'scenes_not_mergeable', 409)
      }
      setSceneRange(scene, { ...firstLayer.source_range, out_ms: nextLayer.source_range.out_ms })
      if (scene.dialogue && next.dialogue) {
        scene.dialogue.original_text = [scene.dialogue.original_text, next.dialogue.original_text].filter(Boolean).join('\n')
        scene.dialogue.semantic_text = [scene.dialogue.semantic_text, next.dialogue.semantic_text].filter(Boolean).join('\n')
        scene.dialogue.display_text = [scene.dialogue.display_text, next.dialogue.display_text].filter(Boolean).join('\n')
      }
      scene.graphics = [...scene.graphics, ...next.graphics].slice(0, 30)
      scene.needs_review = [...new Set([...scene.needs_review, ...next.needs_review])]
      project.scenes = project.scenes.filter(item => item.id !== next.id)
      return [scene.id, next.id]
    }
    case 'scene.delete':
    case 'scene.restore': {
      const scene = requireScene(project, operation.scene_id)
      scene.deleted = operation.type === 'scene.delete'
      if (scene.dialogue) scene.dialogue.state = scene.deleted ? 'deleted' : 'kept'
      return [scene.id]
    }
    case 'scene.set_story_role': {
      const scene = requireScene(project, operation.scene_id)
      scene.story_role = operation.story_role
      return [scene.id]
    }
    case 'scene.set_clock': {
      const scene = requireScene(project, operation.scene_id)
      scene.edit_clock = operation.edit_clock
      scene.audio_layers = applyAudioClock(scene.audio_layers, operation.edit_clock)
      return [scene.id]
    }
    case 'scene.set_transition': {
      const scene = requireScene(project, operation.scene_id)
      scene.transition_in = operation.transition
      return [scene.id]
    }
    case 'scene.set_crop': {
      const scene = requireScene(project, operation.scene_id)
      const layer = scene.video_layers.find(item => item.id === operation.layer_id)
      if (!layer) throw new VideoProjectError('找不到要裁切的视频层', 'video_layer_not_found', 404)
      layer.crop = operation.crop
      return [scene.id]
    }
    case 'scene.set_speed': {
      const scene = requireScene(project, operation.scene_id)
      const layer = scene.video_layers.find(item => item.id === operation.layer_id)
      if (!layer) throw new VideoProjectError('找不到要变速的视频层', 'video_layer_not_found', 404)
      layer.speed = operation.speed
      return [scene.id]
    }
    case 'scene.set_locked': {
      const scene = requireScene(project, operation.scene_id)
      scene.locked_by_user = operation.locked
      return [scene.id]
    }
    case 'scene.replace_source': {
      requireSource(project, operation.source_range.source_id)
      const scene = requireScene(project, operation.scene_id)
      const previous = scene.source_ranges[0]
      setPrimaryRange(scene, operation.source_range)
      if (scene.edit_clock !== 'dialogue') {
        for (const layer of scene.audio_layers) {
          if (layer.role === 'ambience' && layer.source_range && previous && layer.source_range.source_id === previous.source_id && layer.source_range.in_ms === previous.in_ms && layer.source_range.out_ms === previous.out_ms) {
            layer.source_range = operation.source_range
          }
        }
      }
      return [scene.id]
    }
    case 'scene.set_broll': {
      const scene = requireScene(project, operation.scene_id)
      scene.video_layers = scene.video_layers.filter(layer => layer.role !== 'broll')
      scene.source_ranges = scene.source_ranges.slice(0, 1)
      if (operation.source_range) {
        requireSource(project, operation.source_range.source_id)
        scene.source_ranges.push(operation.source_range)
        scene.video_layers.push({
          id: `layer-${randomUUID().slice(0, 8)}`,
          role: 'broll',
          source_range: operation.source_range,
          crop: { x: 0, y: 0, width: 1, height: 1, fit: 'contain' },
          speed: 1,
          opacity: 1,
          enabled: true,
        })
      }
      return [scene.id]
    }
    case 'scene.add_narration': {
      const scene = requireScene(project, operation.scene_id)
      scene.dialogue = {
        origin: 'narration',
        original_text: '', semantic_text: operation.text, display_text: operation.text,
        state: 'kept', take_options: [],
      }
      scene.needs_review = scene.needs_review.filter(item => !item.includes('旁白文字已保存'))
      if (operation.source_range) {
        const source = requireSource(project, operation.source_range.source_id)
        if (source.has_audio === false) throw new VideoProjectError('所选旁白素材没有音轨', 'narration_audio_missing', 409)
        scene.audio_layers = scene.audio_layers.filter(layer => layer.role !== 'speech')
        scene.audio_layers.push({
          id: `audio-${randomUUID().slice(0, 8)}`,
          role: 'speech',
          source_range: operation.source_range,
          owner: true,
          gain_envelope: [{ at_ms: 0, gain: 1 }, { at_ms: operation.source_range.out_ms - operation.source_range.in_ms, gain: 1 }],
          fade_in_ms: 100,
          fade_out_ms: 100,
          enabled: true,
        })
        if (!scene.source_ranges.some(range => range.source_id === operation.source_range!.source_id && range.in_ms === operation.source_range!.in_ms && range.out_ms === operation.source_range!.out_ms)) {
          scene.source_ranges.push(operation.source_range)
        }
        scene.edit_clock = 'dialogue'
        scene.audio_layers = applyAudioClock(scene.audio_layers, scene.edit_clock)
      } else {
        scene.needs_review.push('旁白文字已保存但尚未绑定音频，导出不会生成旁白声音')
      }
      return [scene.id]
    }
    case 'scene.remove_narration': {
      const scene = requireScene(project, operation.scene_id)
      if (scene.dialogue?.origin !== 'narration') throw new VideoProjectError('当前 Scene 没有可移除的短旁白', 'narration_missing', 409)
      const narrationRanges = scene.audio_layers.filter(layer => layer.role === 'speech' && layer.source_range).map(layer => layer.source_range!)
      scene.dialogue = undefined
      scene.audio_layers = scene.audio_layers.filter(layer => layer.role !== 'speech')
      scene.source_ranges = scene.source_ranges.filter(range => {
        const narrationOnly = narrationRanges.some(item => item.source_id === range.source_id && item.in_ms === range.in_ms && item.out_ms === range.out_ms)
        const stillVisual = scene.video_layers.some(layer => layer.source_range.source_id === range.source_id && layer.source_range.in_ms === range.in_ms && layer.source_range.out_ms === range.out_ms)
        return !narrationOnly || stillVisual
      })
      scene.edit_clock = project.music.enabled ? 'music' : 'action'
      scene.audio_layers = applyAudioClock(scene.audio_layers, scene.edit_clock)
      scene.needs_review = scene.needs_review.filter(item => !item.includes('旁白文字已保存'))
      return [scene.id]
    }
    case 'scene.set_graphics': {
      const scene = requireScene(project, operation.scene_id)
      const solved = solveGraphics(scene, operation.graphics)
      scene.graphics = solved.graphics
      scene.needs_review = [...new Set([...scene.needs_review.filter(item => !item.startsWith('图形约束:')), ...solved.warnings.map(item => `图形约束:${item}`)])]
      return [scene.id]
    }
    case 'dialogue.set_state': {
      const scene = requireScene(project, operation.scene_id)
      if (!scene.dialogue) throw new VideoProjectError('当前 Scene 没有文字稿', 'dialogue_missing', 409)
      scene.dialogue.state = operation.state
      if (scene.dialogue.origin === 'transcript') scene.deleted = operation.state === 'deleted'
      return [scene.id]
    }
    case 'dialogue.set_display': {
      const scene = requireScene(project, operation.scene_id)
      if (!scene.dialogue) throw new VideoProjectError('当前 Scene 没有文字稿', 'dialogue_missing', 409)
      scene.dialogue.display_text = operation.display_text
      return [scene.id]
    }
    case 'dialogue.set_semantic': {
      const scene = requireScene(project, operation.scene_id)
      if (!scene.dialogue) throw new VideoProjectError('当前 Scene 没有文字稿', 'dialogue_missing', 409)
      scene.dialogue.semantic_text = operation.semantic_text
      return [scene.id]
    }
    case 'dialogue.select_take': {
      const scene = requireScene(project, operation.scene_id)
      const take = scene.dialogue?.take_options.find(item => item.id === operation.take_id)
      if (!take || !scene.dialogue) throw new VideoProjectError('找不到这个 take', 'take_not_found', 404)
      scene.dialogue.take_id = take.id
      setPrimaryRange(scene, take.source_range)
      return [scene.id]
    }
    case 'source.set_role':
      requireSource(project, operation.source_id).role = operation.role
      return []
    case 'source.set_excluded':
      requireSource(project, operation.source_id).excluded = operation.excluded
      return []
    case 'source.set_favorite':
      requireSource(project, operation.source_id).favorite = operation.favorite
      return []
    case 'project.set_name':
      project.name = operation.name.trim()
      return []
    case 'project.set_view':
      project.goal = operation.goal
      return []
    case 'project.set_canvas':
      project.canvas = { ...project.canvas, ...canvasForRatio(operation.ratio) }
      return project.scenes.map(scene => scene.id)
    case 'project.set_audio_intent':
      project.music.energy = operation.energy
      if (operation.music_enabled != null) project.music.enabled = operation.music_enabled
      return project.scenes.map(scene => scene.id)
    case 'project.set_music':
      project.music = operation.music
      return project.scenes.map(scene => scene.id)
    case 'project.set_brand':
      project.brand = operation.brand
      return project.scenes.map(scene => scene.id)
    case 'source.relocate':
      throw new VideoProjectError('素材重新定位需要异步校验文件指纹', 'relocate_requires_store', 409)
  }
}

function refreshDerivedFacts(project: VideoProject) {
  if (project.creative_brief) {
    project.creative_brief.source_assets = project.sources.map(source => ({
      source_id: source.id,
      role: source.role,
      ...(source.role_confidence == null ? {} : { confidence: source.role_confidence }),
    }))
  }
  for (const scene of project.scenes) {
    const ranges = [
      ...scene.source_ranges,
      ...scene.video_layers.map(layer => layer.source_range),
      ...scene.audio_layers.flatMap(layer => layer.source_range ? [layer.source_range] : []),
    ]
    for (const range of ranges) {
      const source = requireSource(project, range.source_id)
      if (source.duration_ms > 0 && range.out_ms > source.duration_ms + 50) {
        throw new VideoProjectError(`Scene ${scene.order + 1} 超出素材可用时长`, 'source_range_out_of_bounds', 409, { scene_id: scene.id, source_id: source.id })
      }
    }
    const owners = scene.audio_layers.filter(layer => layer.enabled && layer.owner)
    if (owners.length > 1) throw new VideoProjectError(`Scene ${scene.order + 1} 同时存在多个音频主层`, 'multiple_audio_owners', 409, { scene_id: scene.id })
    videoSceneSchema.parse(scene)
  }
}

export class VideoProjectStore {
  private readonly root: string
  private readonly writeTails = new Map<string, Promise<void>>()
  private readonly usageHistory: VideoUsageHistory

  constructor(stateRoot: string) {
    this.root = join(stateRoot, 'uploads', 'edits')
    this.usageHistory = new VideoUsageHistory(stateRoot)
  }

  private async withProjectWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.writeTails.set(id, tail)
    await previous.catch(() => undefined)
    try {
      return await action()
    } finally {
      release()
      if (this.writeTails.get(id) === tail) this.writeTails.delete(id)
    }
  }

  private dir(id: string): string {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(id)) throw new VideoProjectError('项目 ID 不合法', 'invalid_project_id')
    return join(this.root, id)
  }

  private projectPath(id: string): string { return join(this.dir(id), 'project.json') }
  private historyPath(id: string): string { return join(this.dir(id), 'operations.jsonl') }

  projectDirectory(id: string): string { return this.dir(id) }

  hasV2Project(id: string): boolean {
    try { return existsSync(this.projectPath(id)) } catch { return false }
  }

  async list(): Promise<VideoProject[]> {
    let entries: string[] = []
    try { entries = await readdir(this.root) } catch { return [] }
    const projects: VideoProject[] = []
    for (const id of entries) {
      if (!this.hasV2Project(id)) continue
      try { projects.push(await this.load(id)) } catch { /* one broken project must not hide the rest */ }
    }
    return projects.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }

  async create(raw: VideoCreateProjectInput): Promise<VideoProject> {
    const input = videoCreateProjectRequestSchema.parse(raw)
    const id = projectId()
    const seen = new Set<string>()
    const sources: VideoSource[] = []
    for (const path of input.video_paths) {
      const source = await sourceFromPath(path)
      if (seen.has(source.fingerprint)) continue
      seen.add(source.fingerprint)
      source.role = input.source_roles?.[path] ?? input.source_roles?.[source.name] ?? source.role
      sources.push(source)
    }
    if (!sources.length) throw new VideoProjectError('没有可导入的视频素材', 'no_sources')
    const project = videoProjectSchema.parse({
      schema_version: 2,
      project_id: id,
      name: input.name?.trim() || `视频项目 ${new Date().toLocaleDateString('zh-CN')}`,
      revision: 0,
      updated_at: now(),
      goal: input.goal ?? 'ambient',
      canvas: canvasForRatio(input.ratio),
      sources,
      scenes: [],
      evidence: [],
      alternatives: [],
      status: { phase: 'preparing', save_state: 'saved' },
    })
    await this.atomicSave(project)
    return project
  }

  async load(id: string): Promise<VideoProject> {
    try {
      const project = videoProjectSchema.parse(repairProjectCompatibility(JSON.parse(await readFile(this.projectPath(id), 'utf8'))))
      return refreshSourceAvailability(project)
    } catch (error) {
      if (existsSync(join(this.dir(id), 'timeline.json'))) return await this.migrateV1(id)
      if (error instanceof VideoProjectError) throw error
      throw new VideoProjectError('找不到视频项目', 'project_not_found', 404, { project_id: id })
    }
  }

  async saveBrief(id: string, brief: VideoProject['creative_brief'], baseRevision?: number): Promise<VideoProject> {
    return await this.withProjectWrite(id, () => this.saveBriefUnlocked(id, brief, baseRevision))
  }

  private async saveBriefUnlocked(id: string, brief: VideoProject['creative_brief'], baseRevision?: number): Promise<VideoProject> {
    const project = await this.load(id)
    if (baseRevision != null && project.revision !== baseRevision) throw new VideoProjectError('项目已更新，请基于最新版本重新确认理解', 'revision_conflict', 409, { current_revision: project.revision })
    const before = cloneProject(project)
    project.creative_brief = brief
    project.goal = brief?.preferred_view ?? project.goal
    project.canvas = { ...project.canvas, ...canvasForRatio(brief?.target_ratio ?? project.canvas.ratio) }
    project.revision += 1
    project.updated_at = now()
    project.status.phase = project.scenes.length ? 'editing' : 'analyzing'
    await this.commit(id, 'operation', before, project, [])
    return project
  }

  async replaceAnalysis(id: string, patch: Pick<VideoProject, 'sources' | 'evidence' | 'status'>, baseRevision?: number): Promise<VideoProject> {
    return await this.withProjectWrite(id, () => this.replaceAnalysisUnlocked(id, patch, baseRevision))
  }

  private async replaceAnalysisUnlocked(id: string, patch: Pick<VideoProject, 'sources' | 'evidence' | 'status'>, baseRevision?: number): Promise<VideoProject> {
    const project = await this.load(id)
    if (baseRevision != null && project.revision !== baseRevision) throw new VideoProjectError('分析期间项目已被编辑，未覆盖用户版本', 'revision_conflict', 409, { current_revision: project.revision })
    const before = cloneProject(project)
    project.sources = patch.sources
    project.evidence = patch.evidence
    project.status = patch.status
    project.revision += 1
    project.updated_at = now()
    await this.commit(id, 'operation', before, project, [])
    return project
  }

  async replaceDrafts(id: string, scenes: VideoScene[], alternatives: VideoAlternative[], missingCoverage: string[] = [], baseRevision?: number): Promise<VideoProject> {
    return await this.withProjectWrite(id, () => this.replaceDraftsUnlocked(id, scenes, alternatives, missingCoverage, baseRevision))
  }

  private async replaceDraftsUnlocked(id: string, scenes: VideoScene[], alternatives: VideoAlternative[], missingCoverage: string[] = [], baseRevision?: number): Promise<VideoProject> {
    const project = await this.load(id)
    if (baseRevision != null && project.revision !== baseRevision) throw new VideoProjectError('草稿生成期间项目已被编辑，未覆盖用户版本', 'revision_conflict', 409, { current_revision: project.revision })
    const before = cloneProject(project)
    project.scenes = scenes
    project.alternatives = alternatives.slice(0, 3)
    project.status.phase = 'draft_ready'
    project.status.missing_coverage = missingCoverage
    project.revision += 1
    project.updated_at = now()
    normalizeSceneOutputRanges(project)
    await this.commit(id, 'operation', before, project, [])
    return project
  }

  async apply(id: string, baseRevision: number, rawOperations: unknown[]): Promise<{ project: VideoProject; affectedSceneIds: string[]; operationId: string }> {
    return await this.withProjectWrite(id, () => this.applyUnlocked(id, baseRevision, rawOperations))
  }

  private async applyUnlocked(id: string, baseRevision: number, rawOperations: unknown[]): Promise<{ project: VideoProject; affectedSceneIds: string[]; operationId: string }> {
    const operations = rawOperations.map(operation => videoOperationSchema.parse(operation))
    const project = await this.load(id)
    if (project.revision !== baseRevision) {
      throw new VideoProjectError('项目已在另一个视图更新，请刷新后重放本次操作', 'revision_conflict', 409, {
        current_revision: project.revision,
        replayable_operations: operations,
      })
    }
    const before = cloneProject(project)
    const affected = new Set<string>()
    for (const operation of operations) {
      if (operation.type === 'source.relocate') await this.relocateInProject(project, operation.source_id, operation.file_uri)
      else if (operation.type === 'project.set_music') await this.setMusicInProject(project, operation.music)
      else if (operation.type === 'project.set_brand') await this.setBrandInProject(project, operation.brand)
      else {
        const sceneIds = applyOperation(project, operation)
        for (const sceneId of sceneIds) affected.add(sceneId)
        if (operation.type !== 'scene.set_locked') {
          for (const sceneId of sceneIds) {
            const scene = project.scenes.find(item => item.id === sceneId)
            if (scene) scene.locked_by_user = true
          }
        }
      }
    }
    project.revision += 1
    project.updated_at = now()
    project.status.phase = 'editing'
    project.status.save_state = 'saved'
    normalizeSceneOutputRanges(project)
    refreshDerivedFacts(project)
    const operationId = randomUUID()
    await this.commit(id, 'operation', before, project, operations, operationId)
    return { project, affectedSceneIds: [...affected], operationId }
  }

  async undo(id: string, baseRevision: number): Promise<VideoProject> {
    return await this.withProjectWrite(id, () => this.undoUnlocked(id, baseRevision))
  }

  private async undoUnlocked(id: string, baseRevision: number): Promise<VideoProject> {
    const current = await this.load(id)
    if (current.revision !== baseRevision) throw new VideoProjectError('项目版本已变化，无法撤销', 'revision_conflict', 409, { current_revision: current.revision })
    const state = await this.historyState(id)
    const target = state.undo_stack.at(-1)
    if (!target) throw new VideoProjectError('没有可撤销的修改', 'nothing_to_undo', 409)
    const restored = cloneProject(target)
    restored.revision = current.revision + 1
    restored.updated_at = now()
    await this.commitWithStacks(id, 'undo', current, restored, state.undo_stack.slice(0, -1), [...state.redo_stack, current])
    return restored
  }

  async redo(id: string, baseRevision: number): Promise<VideoProject> {
    return await this.withProjectWrite(id, () => this.redoUnlocked(id, baseRevision))
  }

  private async redoUnlocked(id: string, baseRevision: number): Promise<VideoProject> {
    const current = await this.load(id)
    if (current.revision !== baseRevision) throw new VideoProjectError('项目版本已变化，无法重做', 'revision_conflict', 409, { current_revision: current.revision })
    const state = await this.historyState(id)
    const target = state.redo_stack.at(-1)
    if (!target) throw new VideoProjectError('没有可重做的修改', 'nothing_to_redo', 409)
    const restored = cloneProject(target)
    restored.revision = current.revision + 1
    restored.updated_at = now()
    await this.commitWithStacks(id, 'redo', current, restored, [...state.undo_stack, current], state.redo_stack.slice(0, -1))
    return restored
  }

  async applyAlternative(id: string, altId: string, baseRevision: number, scope: 'whole' | 'scene', sceneId?: string): Promise<VideoProject> {
    return await this.withProjectWrite(id, () => this.applyAlternativeUnlocked(id, altId, baseRevision, scope, sceneId))
  }

  private async applyAlternativeUnlocked(id: string, altId: string, baseRevision: number, scope: 'whole' | 'scene', sceneId?: string): Promise<VideoProject> {
    const project = await this.load(id)
    if (project.revision !== baseRevision) throw new VideoProjectError('项目版本已变化，请刷新候选', 'revision_conflict', 409, { current_revision: project.revision })
    const alternative = project.alternatives.find(item => item.id === altId)
    if (!alternative) throw new VideoProjectError('找不到这个候选', 'alternative_not_found', 404)
    const before = cloneProject(project)
    if (scope === 'whole') project.scenes = structuredClone(alternative.scenes)
    else {
      const replacement = alternative.scenes.find(scene => scene.id === sceneId)
      if (!replacement || !sceneId) throw new VideoProjectError('这个候选没有对应 Scene', 'alternative_scene_not_found', 404)
      const index = project.scenes.findIndex(scene => scene.id === sceneId)
      if (index < 0) throw new VideoProjectError('当前项目没有对应 Scene', 'scene_not_found', 404)
      project.scenes[index] = structuredClone(replacement)
    }
    project.revision += 1
    project.updated_at = now()
    project.status.phase = 'editing'
    normalizeSceneOutputRanges(project)
    await this.commit(id, 'alternative', before, project, [])
    return project
  }

  private async relocateInProject(project: VideoProject, sourceId: string, pathValue: string) {
    const source = requireSource(project, sourceId)
    const replacement = await sourceFromPath(pathValue, source.role)
    if (replacement.fingerprint !== source.fingerprint) {
      throw new VideoProjectError('新文件与原素材指纹不一致，未进行绑定', 'fingerprint_mismatch', 409, { source_id: sourceId })
    }
    source.file_uri = replacement.file_uri
    source.name = replacement.name
    source.missing = false
    source.warnings = source.warnings.filter(warning => warning !== SOURCE_OFFLINE_WARNING && !warning.includes('原素材已离线'))
  }

  private async setMusicInProject(project: VideoProject, music: VideoProject['music']) {
    project.status.warnings = project.status.warnings.filter(item => !item.startsWith('音乐提示:'))
    if (!music.path) {
      project.music = { ...music, source_id: undefined, fingerprint: undefined, enabled: false }
      return
    }
    const path = resolve(music.path)
    let info
    try { info = await stat(path) } catch { throw new VideoProjectError('找不到所选音乐文件', 'music_missing', 404) }
    if (!info.isFile() || !AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) throw new VideoProjectError('不支持的音乐文件格式', 'unsupported_music', 415)
    if (music.enabled && !music.license_id?.trim()) throw new VideoProjectError('使用音乐前需要填写授权 ID 或来源编号', 'music_license_required', 409)
    const fingerprint = await fingerprintFile(path)
    project.music = {
      ...music,
      path,
      source_id: `music-${fingerprint.slice(0, 12)}`,
      fingerprint,
      license_id: music.license_id?.trim(),
    }
    if (await this.usageHistory.hasMusicFingerprint(fingerprint, project.project_id)) {
      project.status.warnings.push('音乐提示:这首音乐近期已在其他成片中使用，可保留系列感或更换音乐')
    }
  }

  private async setBrandInProject(project: VideoProject, brand: VideoProject['brand']) {
    if (!brand.logo_path) {
      project.brand = brand
      this.applyBrandPreset(project)
      return
    }
    const path = resolve(brand.logo_path)
    let info
    try { info = await stat(path) } catch { throw new VideoProjectError('找不到所选 Logo 文件', 'logo_missing', 404) }
    if (!info.isFile() || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) throw new VideoProjectError('Logo 必须是 PNG、JPG 或 WebP 图片', 'unsupported_logo', 415)
    project.brand = { ...brand, logo_path: path }
    this.applyBrandPreset(project)
  }

  private applyBrandPreset(project: VideoProject) {
    const token = project.brand.preset === 'clean' ? 'clean-readable' : project.brand.preset === 'energetic' ? 'energetic-readable' : 'neutral-readable'
    for (const scene of project.scenes) {
      scene.graphics = scene.graphics.map(graphic => ({ ...graphic, style_token: token }))
    }
  }

  async recordExportUsage(project: VideoProject): Promise<void> {
    await this.usageHistory.record(videoProjectSchema.parse(project))
  }

  private async atomicSave(project: VideoProject) {
    const parsed = videoProjectSchema.parse(project)
    const dir = this.dir(parsed.project_id)
    await mkdir(dir, { recursive: true })
    const target = this.projectPath(parsed.project_id)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`)
    await rename(temporary, target)
  }

  private async commit(id: string, kind: HistoryEntry['kind'], before: VideoProject, after: VideoProject, operations: VideoOperation[], operationId = randomUUID()) {
    const state = await this.historyState(id)
    await this.commitWithStacks(id, kind, before, after, [...state.undo_stack, before].slice(-HISTORY_LIMIT), [], operations, operationId)
  }

  private async commitWithStacks(
    id: string,
    kind: HistoryEntry['kind'],
    before: VideoProject,
    after: VideoProject,
    undoStack: VideoProject[],
    redoStack: VideoProject[],
    operations: VideoOperation[] = [],
    operationId = randomUUID(),
  ) {
    await this.atomicSave(after)
    const entry: HistoryEntry = {
      id: operationId,
      kind,
      at: now(),
      before,
      after,
      operations,
      undo_stack: undoStack.slice(-HISTORY_LIMIT),
      redo_stack: redoStack.slice(-HISTORY_LIMIT),
    }
    await appendFile(this.historyPath(id), `${JSON.stringify(entry)}\n`)
  }

  private async historyState(id: string): Promise<Pick<HistoryEntry, 'undo_stack' | 'redo_stack'>> {
    try {
      const lines = (await readFile(this.historyPath(id), 'utf8')).trim().split('\n').filter(Boolean)
      const last = lines.length ? JSON.parse(lines.at(-1)!) as Partial<HistoryEntry> : undefined
      return {
        undo_stack: Array.isArray(last?.undo_stack) ? last.undo_stack.map(project => videoProjectSchema.parse(project)) : [],
        redo_stack: Array.isArray(last?.redo_stack) ? last.redo_stack.map(project => videoProjectSchema.parse(project)) : [],
      }
    } catch {
      return { undo_stack: [], redo_stack: [] }
    }
  }

  private async migrateV1(id: string): Promise<VideoProject> {
    const legacyPath = join(this.dir(id), 'timeline.json')
    const legacy = legacyTimelineV1Schema.parse(JSON.parse(await readFile(legacyPath, 'utf8')))
    const sources: VideoSource[] = []
    const mediaToSource = new Map<string, string>()
    for (const [mediaId, media] of Object.entries(legacy.media)) {
      if (!media.src || media.kind === 'audio') continue
      let source: VideoSource
      try {
        source = await sourceFromPath(media.src)
      } catch {
        source = videoProjectSchema.shape.sources.element.parse({
          id: `source-${mediaId}`,
          file_uri: resolve(media.src),
          name: basename(media.src),
          fingerprint: createHash('sha256').update(media.src).digest('hex'),
          duration_ms: Math.max(0, Math.round((media.duration ?? 0) * 1000)),
          has_audio: media.has_audio,
          missing: true,
          warnings: ['迁移时原素材已离线，请重新定位'],
        })
      }
      source.duration_ms = Math.max(source.duration_ms, Math.round((media.duration ?? 0) * 1000))
      source.has_audio = media.has_audio
      sources.push(source)
      mediaToSource.set(mediaId, source.id)
    }
    const captions = Object.entries(legacy.clips)
      .filter(([, clip]) => legacy.tracks[clip.track]?.kind === 'caption' && clip.text)
      .sort(([, a], [, b]) => (a.start ?? 0) - (b.start ?? 0))
    let cursor = 0
    const scenes: VideoScene[] = Object.entries(legacy.clips)
      .filter(([, clip]) => legacy.tracks[clip.track]?.kind === 'video' && clip.media && mediaToSource.has(clip.media))
      .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
      .map(([clipId, clip], index) => {
        const sourceId = mediaToSource.get(clip.media!)!
        const inMs = Math.max(0, Math.round((clip.src_in ?? 0) * 1000))
        const outMs = Math.max(inMs + 1, Math.round((clip.src_out ?? legacy.media[clip.media!]?.duration ?? 1) * 1000))
        const durationMs = outMs - inMs
        const caption = captions.find(([, item]) => {
          const start = Math.round((item.start ?? 0) * 1000)
          return start >= cursor && start < cursor + durationMs
        })?.[1]
        const range = { source_id: sourceId, in_ms: inMs, out_ms: outMs }
        const scene = videoSceneSchema.parse({
          id: `scene-${clipId}`,
          order: index,
          story_role: index === 0 ? 'hook' : 'proof',
          edit_clock: caption ? 'dialogue' : 'action',
          visual_role: caption ? 'talking_head' : 'broll',
          source_ranges: [range],
          output_range: { start_ms: cursor, end_ms: cursor + durationMs },
          ...(caption ? { dialogue: { original_text: caption.text, semantic_text: caption.text, display_text: caption.text } } : {}),
          video_layers: [{ id: `layer-${clipId}`, role: 'primary', source_range: range }],
          audio_layers: [{ id: `audio-${clipId}`, role: caption ? 'speech' : 'ambience', owner: true }],
          graphics: caption ? [{
            id: `subtitle-${clipId}`, intent: '显示原字幕', role: 'subtitle', text: caption.text ?? '', anchor: 'bottom',
            enter_ms: 0, hold_ms: durationMs, exit_ms: 0, priority: 80, exclusive_group: 'bottom-copy', safe_regions: ['bottom'],
          }] : [],
          attention_owner: caption ? 'person' : 'action',
          rationale: '从旧时间线迁移，保留原片段顺序',
          needs_review: ['旧项目迁移默认值，请检查 Scene 角色和裁切'],
        })
        cursor += durationMs
        return scene
      })
    const project = videoProjectSchema.parse({
      schema_version: 2,
      project_id: id,
      name: id,
      revision: 1,
      updated_at: now(),
      goal: scenes.some(scene => scene.dialogue) ? 'talking' : 'ambient',
      canvas: { width: legacy.width ?? 1080, height: legacy.height ?? 1920, fps: legacy.fps ?? 30, ratio: (legacy.width ?? 1080) > (legacy.height ?? 1920) ? '16:9' : '9:16' },
      sources,
      scenes,
      status: { phase: scenes.length ? 'editing' : 'empty', warnings: ['项目已从旧时间线迁移，请检查默认 Scene 角色'] },
      migrated_from_v1: true,
    })
    const backup = join(this.dir(id), 'timeline.v1.readonly.json')
    if (!existsSync(backup)) await copyFile(legacyPath, backup)
    await this.atomicSave(project)
    const empty = { undo_stack: [], redo_stack: [] }
    const entry: HistoryEntry = { id: randomUUID(), kind: 'migration', at: now(), before: project, after: project, ...empty }
    await appendFile(this.historyPath(id), `${JSON.stringify(entry)}\n`)
    return project
  }
}
