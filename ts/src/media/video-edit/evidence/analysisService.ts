import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ffprobeBinFrom } from '../../mediaBinaries'
import type { Model } from '../../../types/model'
import {
  videoAudioEvidenceSchema,
  videoEvidenceRefSchema,
  videoMusicEvidenceSchema,
  videoProjectStatusSchema,
  videoShotEvidenceSchema,
  videoSourceSchema,
  videoSourceRoleEvidenceSchema,
  videoVisualEvidenceSchema,
  type VideoEvidenceRef,
  type VideoProject,
  type VideoSource,
  type VideoSourceRole,
} from '../../../../shared/contracts/video-edit'
import type { TaskRunnerContext } from '../../../tasks/taskService'
import type { VideoProjectStore } from '../projectStore'
import { detectScenes } from './shotDetection'
import { measureShot, selectAndRankShots, type CandidateShot } from './shotQuality'
import { WhisperCppAsrAdapter, asrWorkDirectory, type AsrAdapter } from './asr'
import { beatsForMusic } from './beatAnalysis'
import { classifyContent, type ClassifyResult } from './contentRouter'
import { buildVlmModel, extractKeyframeBase64, tagShots, type BrollPlan, type ShotForTag } from './visualTagger'

interface ProbeJson {
  format?: { duration?: string }
  streams?: Array<Record<string, unknown>>
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' ? value : Number(value) || 0
}

function parseFps(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const [a, b] = value.split('/').map(Number)
  const result = b ? a! / b : a
  return Number.isFinite(result) && result! > 0 ? result : undefined
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, signal })
    let stdout = ''
    let stderr = ''
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `ffprobe failed:${code}`)))
  })
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

const VISUAL_ROLE_RULES: Array<[RegExp, VideoSourceRole]> = [
  [/入口|门头|招牌|外景|entry|entrance|front/u, 'venue_entry'],
  [/全景|空间|大厅|环境|wide|room|interior/u, 'space_wide'],
  [/互动|合影|交谈|多人|人群|people|group|conversation/u, 'people_interaction'],
  [/击球|比赛|运动|动作|挥杆|action|sport|game/u, 'play_action'],
  [/欢呼|颁奖|高光|庆祝|event|award|celebration/u, 'event_moment'],
  [/细节|特写|器材|产品|detail|close.?up|product/u, 'detail_product'],
  [/服务|接待|准备|清洁|摆台|service|process/u, 'service_process'],
  [/品牌|标志|片尾|logo|brand|ending/u, 'brand_end'],
]

function roleFromVisualTag(tag: string | undefined): VideoSourceRole {
  if (!tag) return 'unclassified'
  for (const [pattern, role] of VISUAL_ROLE_RULES) if (pattern.test(tag)) return role
  return 'unclassified'
}

function visualRoleSuggestions(plan: BrollPlan | null): Array<{ role: VideoSourceRole; confidence: number; rationale: string }> {
  if (!plan?.usedVlm) return []
  const grouped = new Map<VideoSourceRole, string[]>()
  for (const tag of Object.values(plan.tags)) {
    const role = roleFromVisualTag(tag)
    if (role === 'unclassified') continue
    grouped.set(role, [...(grouped.get(role) ?? []), tag])
  }
  return [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([role, tags], index) => ({
      role,
      confidence: Math.max(0.62, 0.82 - index * 0.08),
      rationale: `代表帧可见:${[...new Set(tags)].slice(0, 3).join('、')}`,
    }))
}

function roleSuggestions(source: VideoSource, transcriptAvailable: boolean, shots: Array<{ avgMotion?: number }>, visualPlan: BrollPlan | null): Array<{ role: VideoSourceRole; confidence: number; rationale: string }> {
  if (source.role !== 'unclassified') return [{ role: source.role, confidence: source.role_confidence ?? 1, rationale: '用户已确认或项目已保存该素材角色' }]
  const name = source.name.toLowerCase()
  if (transcriptAvailable) return [{ role: source.duration_ms > 60_000 ? 'live_longform' : 'talking_take', confidence: 0.82, rationale: '本地 ASR 识别到连续真实语音' }]
  const observed = visualRoleSuggestions(visualPlan)
  if (observed.length) return observed
  const nameRules: Array<[RegExp, VideoSourceRole, string]> = [
    [/门头|入口|entry|front/u, 'venue_entry', '文件名提示这是入口或建立镜头'],
    [/全景|大厅|空间|wide|room/u, 'space_wide', '文件名提示这是空间全景'],
    [/互动|合影|people|group/u, 'people_interaction', '文件名提示这是人物互动'],
    [/动作|击球|比赛|action|sport|game/u, 'play_action', '文件名提示这是动作镜头'],
    [/颁奖|欢呼|高光|event|award/u, 'event_moment', '文件名提示这是事件高光'],
    [/细节|器材|产品|detail|product/u, 'detail_product', '文件名提示这是细节镜头'],
    [/服务|接待|准备|service|process/u, 'service_process', '文件名提示这是过程镜头'],
    [/品牌|片尾|logo|brand|ending/u, 'brand_end', '文件名提示这是品牌收束素材'],
  ]
  for (const [pattern, role, rationale] of nameRules) if (pattern.test(name)) return [{ role, confidence: 0.68, rationale }]
  const motion = shots.reduce((max, shot) => Math.max(max, shot.avgMotion ?? 0), 0)
  if (motion >= 10) return [{ role: 'play_action', confidence: 0.46, rationale: '本地帧间运动信号较强，仅作为待确认建议' }]
  return [{ role: 'unclassified', confidence: 0.2, rationale: '本地证据不足，保持待确认，不编造素材内容' }]
}

function evidenceRef(source: VideoSource, kind: VideoEvidenceRef['kind'], path: string, provider: string, providerVersion: string, warning?: string): VideoEvidenceRef {
  return videoEvidenceRefSchema.parse({
    id: `evidence-${randomUUID()}`,
    kind,
    source_id: source.id,
    path,
    provider,
    provider_version: providerVersion,
    source_fingerprint: source.fingerprint,
    created_at: new Date().toISOString(),
    ...(warning ? { status: 'warning', warning } : {}),
  })
}

export interface VideoAnalysisOptions {
  sourceIds?: string[]
  transcription?: 'required' | 'skip' | 'auto'
  onCheckpoint?: (checkpoint: Record<string, unknown>, affectedSourceIds: string[]) => Promise<void> | void
}

type ContentClassifier = (sources: Parameters<typeof classifyContent>[0], opts?: Parameters<typeof classifyContent>[1]) => Promise<ClassifyResult>
type KeyframeExtractor = typeof extractKeyframeBase64
type VisualTagger = typeof tagShots

interface VideoEvidenceServiceOptions {
  asr?: AsrAdapter
  env?: Record<string, string | undefined>
  classifyContent?: ContentClassifier
  visualModel?: Model | null
  extractKeyframe?: KeyframeExtractor
  tagVisualShots?: VisualTagger
  maxVisualShotsPerSource?: number
  maxVisualShotsPerAnalysis?: number
}

function progressInRange(start: number, end: number, progress: number): number {
  return Math.round(start + (end - start) * Math.max(0, Math.min(100, progress)) / 100)
}

export class VideoEvidenceService {
  private readonly asr: AsrAdapter
  private readonly env: Record<string, string | undefined>
  private readonly classify: ContentClassifier
  private readonly visualModel: Model | null
  private readonly extractKeyframe: KeyframeExtractor
  private readonly tagVisualShots: VisualTagger
  private readonly maxVisualShotsPerSource: number
  private readonly maxVisualShotsPerAnalysis: number

  constructor(private readonly store: VideoProjectStore, opts: VideoEvidenceServiceOptions = {}) {
    this.env = opts.env ?? process.env
    this.asr = opts.asr ?? new WhisperCppAsrAdapter(this.env)
    this.classify = opts.classifyContent ?? classifyContent
    this.visualModel = opts.visualModel !== undefined ? opts.visualModel : buildVlmModel(this.env)
    this.extractKeyframe = opts.extractKeyframe ?? extractKeyframeBase64
    this.tagVisualShots = opts.tagVisualShots ?? tagShots
    this.maxVisualShotsPerSource = Math.max(1, Math.min(8, opts.maxVisualShotsPerSource ?? 4))
    this.maxVisualShotsPerAnalysis = Math.max(1, Math.min(48, opts.maxVisualShotsPerAnalysis ?? 16))
  }

  async analyze(projectId: string, ctx?: TaskRunnerContext, options: VideoAnalysisOptions = {}): Promise<VideoProject> {
    const project = await this.store.load(projectId)
    const requested = options.sourceIds?.length ? new Set(options.sourceIds) : new Set(project.sources.map(source => source.id))
    const unknown = [...requested].filter(id => !project.sources.some(source => source.id === id))
    if (unknown.length) throw new Error(`找不到待分析素材:${unknown.join(',')}`)
    const sources: VideoSource[] = structuredClone(project.sources)
    const evidence: VideoEvidenceRef[] = project.evidence.filter(ref => !requested.has(ref.source_id))
    const evidenceDir = join(this.store.projectDirectory(projectId), 'evidence')
    await mkdir(evidenceDir, { recursive: true })
    let remainingVisualShots = this.maxVisualShotsPerAnalysis

    const targets = sources.filter(source => requested.has(source.id))
    for (let index = 0; index < targets.length; index++) {
      if (ctx?.signal.aborted) throw new DOMException('cancelled', 'AbortError')
      const source = await this.probe(targets[index]!)
      const sourceStart = Math.round((index / Math.max(1, targets.length)) * 88)
      const sourceEnd = Math.round(((index + 1) / Math.max(1, targets.length)) * 88)
      const transcriptionStart = progressInRange(sourceStart, sourceEnd, 6)
      const transcriptionEnd = progressInRange(sourceStart, sourceEnd, 45)
      await ctx?.progress(progressInRange(sourceStart, sourceEnd, 3), `正在读取素材 ${index + 1}/${targets.length}: ${source.name}`)
      await options.onCheckpoint?.({ phase: 'source_started', source_id: source.id, source_index: index }, [source.id])
      const sourceWarnings = [...source.warnings]
      let shouldTranscribe = options.transcription !== 'skip' && source.has_audio !== false
      if (options.transcription === 'auto' && source.has_audio !== false) {
        await ctx?.progress(progressInRange(sourceStart, sourceEnd, 5), `正在判断素材 ${index + 1}/${targets.length} 是否包含连续口播`)
        const classified = await this.classify([{
          src: source.file_uri,
          has_audio: true,
          duration: Math.max(0, source.duration_ms / 1000),
        }], { env: this.env, signal: ctx?.signal })
        shouldTranscribe = classified.route === 'speech'
      }
      const transcriptResult = source.has_audio === false
        ? { transcript: null, provider: this.asr.id, providerVersion: this.asr.version, warning: '素材没有音轨' }
        : !shouldTranscribe
          ? { transcript: null, provider: this.asr.id, providerVersion: this.asr.version }
          : await this.asr.transcribe(
            source.file_uri,
            asrWorkDirectory(this.store.projectDirectory(projectId), source.id),
            ctx?.signal,
            async (progress, stage) => {
              await ctx?.progress(progressInRange(transcriptionStart, transcriptionEnd, progress), stage ?? '正在识别说话内容')
            },
          )
      if (transcriptResult.transcript) {
        const path = join(evidenceDir, `${source.id}.transcript.json`)
        await atomicJson(path, transcriptResult.transcript)
        evidence.push(evidenceRef(source, 'transcript', path, transcriptResult.provider, transcriptResult.providerVersion))
      } else if (transcriptResult.warning) {
        sourceWarnings.push(transcriptResult.warning)
      }

      await ctx?.progress(progressInRange(sourceStart, sourceEnd, 50), `正在寻找可用画面 ${index + 1}/${targets.length}`)
      const shots = await detectScenes(source.file_uri, Math.max(0.1, source.duration_ms / 1000), { env: this.env, signal: ctx?.signal })
      const candidates: CandidateShot[] = []
      for (let shotIndex = 0; shotIndex < Math.min(shots.length, 80); shotIndex++) {
        const shot = shots[shotIndex]!
        await ctx?.progress(
          progressInRange(sourceStart, sourceEnd, 55 + (shotIndex / Math.max(1, Math.min(shots.length, 80))) * 38),
          `正在评估画面 ${shotIndex + 1}/${Math.min(shots.length, 80)}`,
        )
        candidates.push({
          id: `${source.id}-shot-${shotIndex}`,
          mediaId: source.id,
          index: shotIndex,
          start: shot.start,
          end: shot.end,
          metrics: await measureShot(source.file_uri, shot, { env: this.env, signal: ctx?.signal }),
        })
      }
      const ranked = selectAndRankShots(candidates, { maxShots: 60 })
      let visualPlan: BrollPlan | null = null
      if (this.visualModel && remainingVisualShots > 0) {
        const sample = ranked.filter(shot => shot.keep).slice(0, Math.min(this.maxVisualShotsPerSource, remainingVisualShots))
        const visualShots: ShotForTag[] = []
        for (const shot of sample) {
          const thumbBase64 = await this.extractKeyframe(source.file_uri, { start: shot.start, end: shot.end }, { env: this.env, signal: ctx?.signal })
          if (!thumbBase64) continue
          visualShots.push({
            index: shot.index,
            mediaId: source.id,
            start: shot.start,
            end: shot.end,
            durationSec: Math.max(0.001, shot.end - shot.start),
            avgLuma: shot.metrics?.avgLuma,
            avgMotion: shot.metrics?.avgMotion,
            thumbBase64,
          })
        }
        remainingVisualShots -= visualShots.length
        if (visualShots.length) {
          await ctx?.progress(progressInRange(sourceStart, sourceEnd, 94), `正在理解代表画面 ${index + 1}/${targets.length}`)
          visualPlan = await this.tagVisualShots(visualShots, { env: this.env, signal: ctx?.signal, model: this.visualModel })
        }
      }
      const shotValue = videoShotEvidenceSchema.parse({
        source_id: source.id,
        shots: ranked.slice().sort((a, b) => a.index - b.index).map(shot => ({
          index: shot.index,
          start_ms: Math.round(shot.start * 1000),
          end_ms: Math.max(Math.round(shot.start * 1000) + 1, Math.round(shot.end * 1000)),
          quality_score: shot.score,
          keep: shot.keep,
          avg_luma: shot.metrics?.avgLuma,
          avg_motion: shot.metrics?.avgMotion,
          warning: shot.reason,
        })),
      })
      const shotPath = join(evidenceDir, `${source.id}.shots.json`)
      await atomicJson(shotPath, shotValue)
      evidence.push(evidenceRef(source, 'shot', shotPath, 'ffmpeg-local-shot-analysis', 'v2', shots.length === 1 ? '未检测到明显镜头切换，按整段素材处理' : undefined))

      const suggestions = roleSuggestions(source, Boolean(transcriptResult.transcript), shotValue.shots.map(shot => ({ avgMotion: shot.avg_motion })), visualPlan)
      if (source.role === 'unclassified' && suggestions[0]?.role !== 'unclassified') {
        source.role = suggestions[0]!.role
        source.role_confidence = suggestions[0]!.confidence
      }
      const visualValue = videoVisualEvidenceSchema.parse({
        source_id: source.id,
        local_only: !visualPlan?.usedVlm,
        shots: shotValue.shots.map(shot => ({
          index: shot.index,
          suggested_role: roleFromVisualTag(visualPlan?.tags[shot.index]) !== 'unclassified'
            ? roleFromVisualTag(visualPlan?.tags[shot.index])
            : suggestions[0]?.role ?? 'unclassified',
          confidence: visualPlan?.tags[shot.index] ? 0.82 : suggestions[0]?.confidence ?? 0.2,
          rationale: visualPlan?.tags[shot.index]
            ? `代表帧可见:${visualPlan.tags[shot.index]}`
            : suggestions[0]?.rationale ?? '本地证据不足',
        })),
      })
      const visualPath = join(evidenceDir, `${source.id}.visual.json`)
      await atomicJson(visualPath, visualValue)
      evidence.push(evidenceRef(source, 'visual', visualPath, visualPlan?.usedVlm ? 'gateway-vlm-visual-evidence' : 'local-visual-evidence', visualPlan?.usedVlm ? 'v2' : 'v1'))

      const audioValue = videoAudioEvidenceSchema.parse({
        source_id: source.id,
        has_audio: source.has_audio,
        transcript_available: Boolean(transcriptResult.transcript),
        speech_ranges: transcriptResult.transcript?.phrases.map(phrase => ({ start_ms: Math.max(0, Math.round(phrase.start * 1000)), end_ms: Math.max(Math.round(phrase.start * 1000) + 1, Math.round(phrase.end * 1000)) })) ?? [],
        action_peaks_ms: [],
        warnings: source.has_audio === false ? ['没有音轨'] : transcriptResult.warning ? [transcriptResult.warning] : [],
      })
      const audioPath = join(evidenceDir, `${source.id}.audio.json`)
      await atomicJson(audioPath, audioValue)
      evidence.push(evidenceRef(source, 'audio', audioPath, `ffprobe-and-${this.asr.id}`, this.asr.version))

      const roleValue = videoSourceRoleEvidenceSchema.parse({ source_id: source.id, selected_role: source.role, suggestions })
      const rolePath = join(evidenceDir, `${source.id}.source-role.json`)
      await atomicJson(rolePath, roleValue)
      evidence.push(evidenceRef(source, 'source_role', rolePath, 'local-role-evidence', 'v1'))

      source.warnings = [...new Set(sourceWarnings)]
      const sourceIndex = sources.findIndex(item => item.id === source.id)
      sources[sourceIndex] = videoSourceSchema.parse(source)
      await ctx?.progress(progressInRange(sourceStart, sourceEnd, 98), `已完成素材 ${index + 1}/${targets.length}`)
      await options.onCheckpoint?.({ phase: 'source_done', source_id: source.id, source_index: index, evidence_count: evidence.filter(ref => ref.source_id === source.id).length }, [source.id])
    }
    await ctx?.progress(90, '正在保存素材证据')
    const warnings = sources.flatMap(source => source.warnings.map(warning => `${source.name}: ${warning}`))
    return await this.store.replaceAnalysis(projectId, {
      sources,
      evidence,
      status: videoProjectStatusSchema.parse({
        phase: project.scenes.length ? 'editing' : 'empty',
        save_state: 'saved',
        warnings: [...new Set(warnings)],
      }),
    }, project.revision)
  }

  async readEvidence(project: VideoProject, kind: VideoEvidenceRef['kind']): Promise<Array<{ ref: VideoEvidenceRef; value: unknown }>> {
    const out: Array<{ ref: VideoEvidenceRef; value: unknown }> = []
    for (const ref of project.evidence.filter(item => item.kind === kind)) {
      try {
        out.push({ ref, value: JSON.parse(await readFile(ref.path, 'utf8')) })
      } catch {
        // Evidence can be rebuilt; a missing cache never mutates confirmed scenes.
      }
    }
    return out
  }

  async analyzeMusic(projectId: string, ctx?: TaskRunnerContext): Promise<VideoProject> {
    const project = await this.store.load(projectId)
    const music = project.music
    if (!music.enabled || !music.path || !music.license_id || !music.fingerprint || !music.source_id) return project
    const current = project.evidence.find(ref => ref.kind === 'music' && ref.source_fingerprint === music.fingerprint)
    if (current) return project
    await ctx?.progress(10, '正在分析授权音乐的段落与节拍')
    const result = await beatsForMusic(music.path, { env: this.env, signal: ctx?.signal })
    const beatsMs = result?.beats.map(value => Math.max(0, Math.round(value * 1000))) ?? []
    const value = videoMusicEvidenceSchema.parse({
      source_id: music.source_id,
      license_id: music.license_id,
      fingerprint: music.fingerprint,
      tempo: result?.tempo || undefined,
      beats_ms: beatsMs,
      sections: [],
    })
    const dir = join(this.store.projectDirectory(projectId), 'evidence')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${music.source_id}.music.json`)
    await atomicJson(path, value)
    const musicSource = videoSourceSchema.parse({
      id: music.source_id,
      file_uri: music.path,
      name: music.path.split(/[\\/]/).at(-1) || 'music',
      fingerprint: music.fingerprint,
      has_video: false,
      has_audio: true,
    })
    const warning = result ? undefined : '本地节拍分析不可用；草稿继续按故事、动作和现场声组织，不做机械卡点'
    const evidence = [
      ...project.evidence.filter(ref => ref.kind !== 'music'),
      evidenceRef(musicSource, 'music', path, 'local-beat-analysis', 'v1', warning),
    ]
    return await this.store.replaceAnalysis(projectId, {
      sources: project.sources,
      evidence,
      status: {
        ...project.status,
        warnings: warning ? [...new Set([...project.status.warnings, warning])] : project.status.warnings,
      },
    }, project.revision)
  }

  private async probe(source: VideoSource): Promise<VideoSource> {
    const next = structuredClone(source)
    const bin = ffprobeBinFrom(this.env)
    try {
      const parsed = JSON.parse(await run(bin, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source.file_uri])) as ProbeJson
      const streams = parsed.streams ?? []
      const video = streams.find(stream => stringField(stream, 'codec_type') === 'video')
      const audio = streams.find(stream => stringField(stream, 'codec_type') === 'audio')
      next.duration_ms = Math.max(0, Math.round(Number(parsed.format?.duration ?? 0) * 1000))
      next.has_video = Boolean(video)
      next.has_audio = Boolean(audio)
      if (video) {
        next.width = Math.max(0, Math.round(numberField(video, 'width')))
        next.height = Math.max(0, Math.round(numberField(video, 'height')))
        next.fps = parseFps(video.avg_frame_rate)
        next.vfr = stringField(video, 'avg_frame_rate') !== stringField(video, 'r_frame_rate')
        next.color_space = stringField(video, 'color_space') || undefined
        const tags = video.tags && typeof video.tags === 'object' ? video.tags as Record<string, unknown> : undefined
        next.rotation = tags ? Math.round(Number(tags.rotate) || 0) : 0
      }
      if (!video) next.warnings.push('没有可用视频轨')
      if (!audio) next.warnings.push('没有音轨，仍可按环境素材剪辑')
    } catch {
      next.warnings.push('素材探测不可用，保留原文件并允许稍后重试')
    }
    return videoSourceSchema.parse(next)
  }
}
