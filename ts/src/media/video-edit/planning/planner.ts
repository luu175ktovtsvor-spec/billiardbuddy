import { randomUUID } from 'node:crypto'
import {
  videoAlternativeSchema,
  videoSceneSchema,
  type VideoAlternative,
  type VideoCreativeBrief,
  type VideoGraphic,
  type VideoProject,
  type VideoScene,
  type VideoSource,
  type VideoSourceRange,
} from '../../../../shared/contracts/video-edit'
import type { VideoTranscript } from '../../transcribe'
import type { VideoEvidenceService } from '../evidence/analysisService'
import { missingCoverageForBrief } from '../briefCompiler'
import { applyAudioClock, audioLayersForScene } from './audio'
import { solveGraphics } from './graphics'

type TranscriptEvidence = { sourceId: string; transcript: VideoTranscript }
type PlannedShot = { start: number; end: number; keep: boolean; qualityScore: number; evidenceRef: string }
type ShotEvidence = { sourceId: string; shots: PlannedShot[] }
type RangeCandidate = { source: VideoSource; range: VideoSourceRange; score: number; evidenceRef: string; warning?: string }

const STORY_ROLES: VideoScene['story_role'][] = ['hook', 'explain', 'proof', 'atmosphere', 'offer', 'cta']

function primaryRange(source: VideoSource, inMs = 0, outMs = source.duration_ms): VideoSourceRange {
  return { source_id: source.id, in_ms: Math.max(0, inMs), out_ms: Math.max(inMs + 1, outMs || inMs + 1000) }
}

function fitCandidateDuration(candidate: RangeCandidate, maxDurationMs: number): RangeCandidate {
  const duration = candidate.range.out_ms - candidate.range.in_ms
  if (!Number.isFinite(maxDurationMs) || duration <= maxDurationMs) return candidate
  return {
    ...candidate,
    range: {
      ...candidate.range,
      out_ms: candidate.range.in_ms + Math.max(1, Math.floor(maxDurationMs)),
    },
  }
}

function visualRole(source: VideoSource): VideoScene['visual_role'] {
  if (source.role === 'talking_take' || source.role === 'live_longform') return 'talking_head'
  if (source.role === 'space_wide' || source.role === 'venue_entry') return 'wide'
  if (source.role === 'play_action' || source.role === 'event_moment') return 'action'
  if (source.role === 'brand_end') return 'brand'
  if (source.role === 'detail_product' || source.role === 'service_process') return 'detail'
  return 'broll'
}

function attentionOwner(source: VideoSource, brief: VideoCreativeBrief, role: VideoScene['story_role']): VideoScene['attention_owner'] {
  if (role === 'cta' || role === 'offer') return 'cta'
  if (source.role === 'talking_take' || source.role === 'people_interaction' || source.role === 'live_longform') return 'person'
  if (source.role === 'play_action' || source.role === 'event_moment') return 'action'
  if (brief.exact_copy.length) return 'information'
  return 'space'
}

function graphicsFor(brief: VideoCreativeBrief, role: VideoScene['story_role'], duration: number): VideoGraphic[] {
  const text = role === 'cta' ? brief.exact_copy.at(-1) : role === 'hook' ? brief.exact_copy[0] : undefined
  if (!text) return []
  return [{
    id: `graphic-${randomUUID().slice(0, 8)}`,
    intent: role === 'cta' ? '显示用户确认的行动信息' : '显示用户确认的标题',
    role: role === 'cta' ? 'cta' as const : 'title' as const,
    text,
    anchor: role === 'cta' ? 'lower' as const : 'top' as const,
    enter_ms: 120,
    hold_ms: Math.max(400, duration - 240),
    exit_ms: 120,
    priority: role === 'cta' ? 90 : 85,
    exclusive_group: role === 'cta' ? 'bottom-copy' : 'top-copy',
    safe_regions: role === 'cta' ? ['lower' as const] : ['top' as const],
    style_token: 'neutral-readable',
  }]
}

function makeScene(
  source: VideoSource,
  range: VideoSourceRange,
  index: number,
  total: number,
  brief: VideoCreativeBrief,
  transcriptText?: string,
  evidenceRefs: string[] = [],
  musicEnabled = false,
): VideoScene {
  const duration = range.out_ms - range.in_ms
  const storyRole = total === 1 ? 'proof' : index === 0 ? 'hook' : index === total - 1 ? 'cta' : STORY_ROLES[Math.min(index, STORY_ROLES.length - 2)]!
  const isTalkingSource = source.role === 'talking_take' || source.role === 'live_longform'
  const editClock: VideoScene['edit_clock'] = transcriptText || isTalkingSource
    ? 'dialogue'
    : source.role === 'play_action' || source.role === 'event_moment' || !musicEnabled
      ? 'action'
      : 'music'
  const provisional = {
    id: `scene-${randomUUID().slice(0, 12)}`,
    order: index,
    story_role: storyRole,
    edit_clock: editClock,
    visual_role: visualRole(source),
    source_ranges: [range],
    output_range: { start_ms: 0, end_ms: duration },
    ...(transcriptText ? { dialogue: { original_text: transcriptText, semantic_text: transcriptText, display_text: transcriptText } } : {}),
    video_layers: [{ id: `layer-${randomUUID().slice(0, 8)}`, role: 'primary' as const, source_range: range }],
    audio_layers: [] as VideoScene['audio_layers'],
    graphics: graphicsFor(brief, storyRole, duration),
    transition_in: { kind: 'cut' as const, duration_ms: 0 },
    attention_owner: attentionOwner(source, brief, storyRole),
    evidence_refs: evidenceRefs,
    rationale: transcriptText
      ? '保留完整语义段，并以原人声作为主时钟'
      : `使用真实素材承担${storyRole === 'hook' ? '开场' : storyRole === 'cta' ? '收束' : '故事推进'}职责`,
    needs_review: transcriptText ? [] : source.duration_ms === 0 ? ['素材时长尚未探测，请重试分析'] : [],
  }
  provisional.audio_layers = audioLayersForScene(provisional, range)
  const solved = solveGraphics(videoSceneSchema.parse(provisional), provisional.graphics)
  provisional.graphics = solved.graphics
  provisional.needs_review.push(...solved.warnings)
  return videoSceneSchema.parse(provisional)
}

function attachReplacementCandidates(scene: VideoScene, source: VideoSource, candidates: RangeCandidate[], preferBroll: boolean) {
  const filtered = candidates.filter(candidate => {
    if (candidate.source.id === source.id && candidate.range.in_ms === scene.source_ranges[0]?.in_ms) return false
    if (!preferBroll) return true
    return candidate.source.role !== 'talking_take' && candidate.source.role !== 'live_longform'
  })
  scene.replacement_candidates = filtered.slice(0, 3).map(candidate => ({
    id: `candidate-${candidate.source.id}-${candidate.range.in_ms}`,
    source_range: candidate.range,
    rationale: candidate.source.role === source.role
      ? '素材角色相近，可保持当前故事职责'
      : `可用${candidate.source.role === 'unclassified' ? '待确认镜头' : candidate.source.role}替换，采用前请预览确认`,
    score: candidate.score,
    evidence_refs: candidate.evidenceRef ? [candidate.evidenceRef] : [],
  }))
}

function talkingScenes(project: VideoProject, brief: VideoCreativeBrief, transcripts: TranscriptEvidence[]): VideoScene[] {
  const phrases: Array<{ source: VideoSource; range: VideoSourceRange; text: string; phraseIndex: number; transcriptRef: string }> = []
  for (const item of transcripts) {
    const source = project.sources.find(candidate => candidate.id === item.sourceId)
    if (!source || source.excluded) continue
    for (let phraseIndex = 0; phraseIndex < item.transcript.phrases.length; phraseIndex++) {
      const phrase = item.transcript.phrases[phraseIndex]!
      if (!phrase.text.trim()) continue
      phrases.push({
        source,
        range: primaryRange(source, Math.round(phrase.start * 1000), Math.round(phrase.end * 1000)),
        text: phrase.text.trim(),
        phraseIndex,
        transcriptRef: project.evidence.find(ref => ref.kind === 'transcript' && ref.source_id === source.id)?.id ?? '',
      })
    }
  }
  const scenes = phrases.map((phrase, index) => {
    const scene = makeScene(phrase.source, phrase.range, index, phrases.length, brief, phrase.text, phrase.transcriptRef ? [phrase.transcriptRef] : [], project.music.enabled)
    if (scene.dialogue) {
      const options = phrases.filter(candidate => candidate.phraseIndex === phrase.phraseIndex).map(candidate => ({
        id: `take-${candidate.source.id}-${candidate.range.in_ms}`,
        source_range: candidate.range,
        label: candidate.source.name,
      }))
      scene.dialogue.take_options = options
      scene.dialogue.take_id = options.find(option => option.source_range.source_id === phrase.source.id)?.id
      scene.dialogue.transcript_ref = phrase.transcriptRef || undefined
    }
    return scene
  })
  if (scenes.length) return scenes.map((scene, index) => ({ ...scene, order: index }))
  const fallback = project.sources.filter(source => !source.excluded && (source.role === 'talking_take' || source.role === 'live_longform'))
  return fallback.map((source, index) => {
    const scene = makeScene(source, primaryRange(source), index, fallback.length, brief, undefined, [], project.music.enabled)
    scene.needs_review.push('ASR 不可用或低置信，未生成假台词；可手动添加字幕或改用环境视角')
    return scene
  })
}

function ambientScenes(project: VideoProject, brief: VideoCreativeBrief, shotEvidence: ShotEvidence[]): VideoScene[] {
  const ranges: RangeCandidate[] = []
  for (const source of project.sources.filter(item => !item.excluded)) {
    const shots = shotEvidence.find(item => item.sourceId === source.id)?.shots ?? []
    const kept = shots.filter(item => item.keep)
    if (kept.length) {
      for (const shot of kept) ranges.push({ source, range: primaryRange(source, Math.round(shot.start * 1000), Math.round(shot.end * 1000)), score: shot.qualityScore, evidenceRef: shot.evidenceRef })
    } else if (shots.length) {
      ranges.push({ source, range: primaryRange(source), score: 0.2, evidenceRef: shots[0]?.evidenceRef ?? '', warning: '技术筛查未找到无明显风险的镜头，暂保留整段真实素材，请预览后决定保留、换镜头或排除' })
    } else ranges.push({ source, range: primaryRange(source), score: 0.5, evidenceRef: '' })
  }
  const rolePriority = new Map(['venue_entry', 'space_wide', 'people_interaction', 'service_process', 'detail_product', 'play_action', 'event_moment', 'brand_end'].map((role, index) => [role, index]))
  ranges.sort((a, b) => (rolePriority.get(a.source.role) ?? 99) - (rolePriority.get(b.source.role) ?? 99) || b.score - a.score)
  const target = brief.target_duration_ms ?? Number.POSITIVE_INFINITY
  const selected: RangeCandidate[] = []
  let duration = 0
  for (const candidate of ranges) {
    if (selected.length >= 12) break
    const remaining = target - duration
    if (remaining <= 0) break
    const fitted = fitCandidateDuration(candidate, remaining)
    selected.push(fitted)
    duration += fitted.range.out_ms - fitted.range.in_ms
  }
  const actual = selected.length ? selected : ranges.slice(0, 1)
  return actual.map((item, index, all) => {
    const scene = makeScene(item.source, item.range, index, all.length, brief, undefined, item.evidenceRef ? [item.evidenceRef] : [], project.music.enabled)
    if (item.warning) scene.needs_review.push(item.warning)
    attachReplacementCandidates(scene, item.source, ranges, false)
    return scene
  })
}

function withLockedScenes(generated: VideoScene[], existing: VideoScene[]): VideoScene[] {
  const locked = existing.filter(scene => scene.locked_by_user)
  if (!locked.length) return generated
  const lockedRanges = new Set(locked.flatMap(scene => scene.source_ranges.map(range => `${range.source_id}:${range.in_ms}:${range.out_ms}`)))
  const result = generated.filter(scene => !scene.source_ranges.some(range => lockedRanges.has(`${range.source_id}:${range.in_ms}:${range.out_ms}`)))
  for (const scene of locked) {
    const index = Math.min(scene.order, result.length)
    result.splice(index, 0, structuredClone(scene))
  }
  return result.map((scene, index) => ({ ...scene, order: index }))
}

function alternativesFor(base: VideoScene[], project: VideoProject): VideoAlternative[] {
  if (!base.length) return []
  const timestamp = new Date().toISOString()
  const complete = structuredClone(base)
  const concise = structuredClone(base).map(scene => {
    if (scene.locked_by_user) return scene
    const primary = scene.video_layers[0]!
    const duration = primary.source_range.out_ms - primary.source_range.in_ms
    if (duration > 2500) {
      primary.source_range.out_ms = primary.source_range.in_ms + Math.max(1800, Math.round(duration * 0.78))
      for (const layer of scene.audio_layers) {
        if (layer.source_range?.source_id === primary.source_range.source_id) layer.source_range.out_ms = primary.source_range.out_ms
      }
    }
    scene.source_ranges[0] = primary.source_range
    scene.rationale = `${scene.rationale}；候选取舍是缩短停留、保持信息完整`
    return scene
  })
  const live = structuredClone(base).map(scene => {
    if (!scene.dialogue && !scene.locked_by_user) {
      scene.edit_clock = scene.visual_role === 'action' || !project.music.enabled ? 'action' : 'music'
      scene.audio_layers = applyAudioClock(scene.audio_layers, scene.edit_clock)
    }
    scene.rationale = `${scene.rationale}；候选取舍是保留更多现场声和动作完整性`
    return scene
  })
  return [
    videoAlternativeSchema.parse({ id: `alt-${randomUUID().slice(0, 8)}`, name: '表达更完整', tradeoff: '保留更完整的语义和动作，成片可能稍长。', base_revision: project.revision, scenes: complete, changed_scene_ids: [], created_at: timestamp }),
    videoAlternativeSchema.parse({ id: `alt-${randomUUID().slice(0, 8)}`, name: '节奏更利落', tradeoff: '缩短可安全压缩的停留，不截断用户锁定内容。', base_revision: project.revision, scenes: concise, changed_scene_ids: concise.filter((scene, index) => JSON.stringify(scene) !== JSON.stringify(base[index])).map(scene => scene.id), created_at: timestamp }),
    videoAlternativeSchema.parse({ id: `alt-${randomUUID().slice(0, 8)}`, name: '现场感更强', tradeoff: '动作和环境声优先，音乐只做辅助。', base_revision: project.revision, scenes: live, changed_scene_ids: live.filter((scene, index) => JSON.stringify(scene) !== JSON.stringify(base[index])).map(scene => scene.id), created_at: timestamp }),
  ]
}

export class VideoDraftPlanner {
  constructor(private readonly evidence: VideoEvidenceService) {}

  async plan(project: VideoProject): Promise<{ scenes: VideoScene[]; alternatives: VideoAlternative[]; missingCoverage: string[] }> {
    const brief = project.creative_brief
    if (!brief) throw new Error('请先确认系统对视频目标的理解')
    const transcriptEvidence = (await this.evidence.readEvidence(project, 'transcript')).flatMap(item => {
      const value = item.value as Partial<VideoTranscript>
      return Array.isArray(value.phrases) ? [{ sourceId: item.ref.source_id, transcript: value as VideoTranscript }] : []
    })
    const shotEvidence = (await this.evidence.readEvidence(project, 'shot')).flatMap(item => {
      const value = item.value as { shots?: Array<{ start_ms?: unknown; end_ms?: unknown; keep?: unknown; quality_score?: unknown }> }
      if (!Array.isArray(value.shots)) return []
      return [{
        sourceId: item.ref.source_id,
        shots: value.shots.flatMap(shot => typeof shot.start_ms === 'number' && typeof shot.end_ms === 'number'
          ? [{ start: shot.start_ms / 1000, end: shot.end_ms / 1000, keep: shot.keep !== false, qualityScore: typeof shot.quality_score === 'number' ? shot.quality_score : 0.5, evidenceRef: item.ref.id }]
          : []),
      }]
    })
    const generated = brief.preferred_view === 'talking'
      ? talkingScenes(project, brief, transcriptEvidence)
      : ambientScenes(project, brief, shotEvidence)
    const scenes = withLockedScenes(generated, project.scenes)
    if (brief.preferred_view === 'talking') {
      const ambientCandidates: RangeCandidate[] = project.sources.filter(source => !source.excluded).flatMap(source => {
        const shots = shotEvidence.find(item => item.sourceId === source.id)?.shots ?? []
        if (shots.length) return shots.filter(shot => shot.keep).map(shot => ({ source, range: primaryRange(source, Math.round(shot.start * 1000), Math.round(shot.end * 1000)), score: shot.qualityScore, evidenceRef: shot.evidenceRef }))
        return [{ source, range: primaryRange(source), score: 0.5, evidenceRef: '' }]
      })
      for (const scene of scenes) {
        const source = project.sources.find(item => item.id === scene.source_ranges[0]?.source_id)
        if (source) attachReplacementCandidates(scene, source, ambientCandidates, true)
      }
    }
    const missingCoverage = missingCoverageForBrief({
      ...brief,
      source_assets: project.sources.map(source => ({ source_id: source.id, role: source.role, confidence: source.role_confidence })),
    })
    return { scenes, alternatives: alternativesFor(scenes, project), missingCoverage }
  }
}
