import { createHash, randomUUID } from 'node:crypto'
import {
  deliveryVariantVersionSchema,
  editorialTimelineVersionSchema,
  timelineDraftSchema,
  videoExecutionPlanSchema,
  videoExportProfileRevisionSchema,
  type DeliveryVariant,
  type DeliveryVariantCommand,
  type DeliveryVariantVersion,
  type EditorialTimelineCommand,
  type EditorialTimelineVersion,
  type TimelineCommandSet,
  type TimelineDraft,
  type VideoExecutionPlan,
  type VideoExportProfile,
  type VideoExportProfileRevision,
  type VideoScene,
  type VideoStudioProject,
  type VideoTimelineItem,
  type VideoTimelineTrack,
} from '../../../../../shared/contracts/media.js'
import { factBasisHash } from '../mediaFacts/model.js'

type Rational = { num: number; den: number }
type RationalTime = { ticks: string; tick_rate: Rational }
type TimeRange = { start: RationalTime; duration: RationalTime }

export type EditorialSourceTiming = {
  tick_rate: Rational
  start_ticks: string
}

export type EditorialSourceBounds = {
  start: RationalTime
  duration: RationalTime
}

export class EditorialValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'VIDEO_EDITORIAL_INVALID'
      | 'VIDEO_EDITORIAL_STALE'
      | 'VIDEO_EDITORIAL_LOCKED'
      | 'VIDEO_EDITORIAL_UNSUPPORTED'
      | 'VIDEO_EXPORT_PROFILE_UNSUPPORTED'
      | 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT'
      | 'VIDEO_SOURCE_FINGERPRINT_PENDING',
  ) {
    super(message)
    this.name = 'EditorialValidationError'
  }
}

const EDITORIAL_TICK_RATE: Rational = { num: 90_000, den: 1 }
const ALLOWED_FRAME_RATES = new Set(['24000/1001', '24/1', '25/1', '30000/1001', '30/1', '50/1', '60000/1001', '60/1'])

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function normalizeRate(rate: Rational): Rational {
  if (!Number.isSafeInteger(rate.num) || !Number.isSafeInteger(rate.den) || rate.num <= 0 || rate.den <= 0) {
    throw new EditorialValidationError('时间基无效', 'VIDEO_EDITORIAL_INVALID')
  }
  return { num: rate.num, den: rate.den }
}

function time(ticks: bigint, rate: Rational): RationalTime {
  return { ticks: ticks.toString(), tick_rate: normalizeRate(rate) }
}

function range(start: RationalTime, duration: RationalTime): TimeRange {
  if (start.tick_rate.num !== duration.tick_rate.num || start.tick_rate.den !== duration.tick_rate.den || BigInt(duration.ticks) <= 0n) {
    throw new EditorialValidationError('时间范围无效', 'VIDEO_EDITORIAL_INVALID')
  }
  return { start: clone(start), duration: clone(duration) }
}

function compare(left: RationalTime, right: RationalTime): -1 | 0 | 1 {
  const a = BigInt(left.ticks) * BigInt(left.tick_rate.den) * BigInt(right.tick_rate.num)
  const b = BigInt(right.ticks) * BigInt(right.tick_rate.den) * BigInt(left.tick_rate.num)
  return a === b ? 0 : a < b ? -1 : 1
}

function add(left: RationalTime, right: RationalTime): RationalTime {
  if (left.tick_rate.num !== right.tick_rate.num || left.tick_rate.den !== right.tick_rate.den) {
    throw new EditorialValidationError('时间基不一致', 'VIDEO_EDITORIAL_INVALID')
  }
  return time(BigInt(left.ticks) + BigInt(right.ticks), left.tick_rate)
}

function subtract(left: RationalTime, right: RationalTime): RationalTime {
  if (left.tick_rate.num !== right.tick_rate.num || left.tick_rate.den !== right.tick_rate.den) {
    throw new EditorialValidationError('时间基不一致', 'VIDEO_EDITORIAL_INVALID')
  }
  return time(BigInt(left.ticks) - BigInt(right.ticks), left.tick_rate)
}

function end(value: TimeRange): RationalTime {
  return add(value.start, value.duration)
}

function millisecondsToTime(milliseconds: number, rate: Rational, offset = 0n): RationalTime {
  const ticks = (BigInt(milliseconds) * BigInt(rate.num)) / (1000n * BigInt(rate.den))
  return time(offset + ticks, rate)
}

function durationMilliseconds(value: TimeRange): number {
  const ticks = BigInt(value.duration.ticks)
  const numerator = ticks * 1000n * BigInt(value.duration.tick_rate.den)
  const denominator = BigInt(value.duration.tick_rate.num)
  return Number(numerator / denominator)
}

function speedKey(speed: VideoTimelineItem['speed']): string {
  return speed ? `${speed.num}/${speed.den}` : '1/1'
}

function sourceDurationMatchesTimeline(item: VideoTimelineItem): boolean {
  if (item.binding.kind !== 'source') return item.speed === undefined
  const speed = item.speed ?? { num: 1, den: 1 }
  const source = item.binding.source_range.duration
  const timeline = item.timeline_range.duration
  // source seconds / timeline seconds must be exactly the declared speed.
  const left = BigInt(source.ticks) * BigInt(source.tick_rate.den) * BigInt(speed.den) * BigInt(timeline.tick_rate.num)
  const right = BigInt(timeline.ticks) * BigInt(timeline.tick_rate.den) * BigInt(speed.num) * BigInt(source.tick_rate.num)
  return left === right
}

function avPairKey(item: VideoTimelineItem): string | undefined {
  if (item.binding.kind !== 'source') return undefined
  return `${item.binding.source_id}:${item.binding.source_fingerprint}:${timelineRangeKey(item.binding.source_range)}:${timelineRangeKey(item.timeline_range)}:${speedKey(item.speed)}`
}

function timeWithin(value: RationalTime, target: TimeRange): boolean {
  return compare(value, target.start) >= 0 && compare(value, end(target)) <= 0
}

function sourceFingerprintSetHash(project: VideoStudioProject): `sha256:${string}` {
  const sources = project.sources.map(source => {
    if (!source.fingerprint) {
      throw new EditorialValidationError('素材完整指纹尚未就绪，请稍后再试', 'VIDEO_SOURCE_FINGERPRINT_PENDING')
    }
    if (source.missing || source.content_changed) {
      throw new EditorialValidationError('视频素材内容已变化，请重新添加该素材后再继续。', 'VIDEO_EDITORIAL_STALE')
    }
    return { id: source.id, fingerprint: source.fingerprint }
  }).sort((left, right) => left.id.localeCompare(right.id))
  return factBasisHash(sources)
}

export function editorialFactsBasisHash(project: VideoStudioProject): `sha256:${string}` {
  return factBasisHash({
    source_fingerprints: project.sources.map(source => ({ id: source.id, fingerprint: source.fingerprint, missing: source.missing, changed: source.content_changed })).sort((left, right) => left.id.localeCompare(right.id)),
    evidence_revision: project.evidence_revision ?? null,
  })
}

function profileHash(profile: Omit<VideoExportProfileRevision, 'content_hash'>): `sha256:${string}` {
  return hash(profile)
}

export function assertExportProfile(profile: VideoExportProfileRevision): void {
  if (profile.width % 2 || profile.height % 2 || profile.width * profile.height > 8_847_360) {
    throw new EditorialValidationError('导出尺寸必须为偶数且不能超过首版像素上限', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
  if (!ALLOWED_FRAME_RATES.has(`${profile.frame_rate.num}/${profile.frame_rate.den}`)) {
    throw new EditorialValidationError('导出帧率不在首版白名单中', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
  if (profile.encoding.container === 'mp4' && profile.encoding.video.codec !== 'h264') {
    throw new EditorialValidationError('MP4 仅支持 H.264', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
  if (profile.encoding.video.codec === 'prores_422' && (profile.encoding.container !== 'mov' || profile.encoding.audio.codec !== 'pcm_s16le')) {
    throw new EditorialValidationError('ProRes 仅支持 MOV 与 PCM 音频', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
  if (profile.caption_mode === 'sidecar' && !profile.sidecar_caption_format) {
    throw new EditorialValidationError('sidecar 字幕必须指定 SRT 或 VTT', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
  if (profile.caption_mode !== 'sidecar' && profile.sidecar_caption_format) {
    throw new EditorialValidationError('非 sidecar 字幕不能指定 sidecar 格式', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
  const { content_hash: _contentHash, ...withoutHash } = profile
  if (profile.content_hash !== profileHash(withoutHash)) {
    throw new EditorialValidationError('导出 Profile 哈希不匹配', 'VIDEO_EXPORT_PROFILE_UNSUPPORTED')
  }
}

function defaultProfile(project: VideoStudioProject, now: string): { profile: VideoExportProfile; revision: VideoExportProfileRevision } {
  const profileId = id('profile')
  const revisionId = id('profile_revision')
  const frameRate = project.output.fps === 24 || project.output.fps === 25 || project.output.fps === 30 || project.output.fps === 50 || project.output.fps === 60
    ? { num: project.output.fps, den: 1 }
    : { num: 30, den: 1 }
  const withoutHash = {
    id: revisionId,
    profile_id: profileId,
    revision: 1,
    target: project.output.width === project.output.height ? 'square_social' as const : project.output.width > project.output.height ? 'horizontal_video' as const : 'vertical_short' as const,
    width: project.output.width,
    height: project.output.height,
    frame_rate: frameRate,
    encoding: {
      container: 'mp4' as const,
      video: { codec: 'h264' as const, quality: { mode: 'crf' as const, value: 20, preset: 'medium' as const } },
      audio: { codec: 'aac_lc' as const, sample_rate: 48_000 as const, channels: 2 as const },
      output_color: { range: 'sdr_bt709' as const, pixel_format: 'yuv420p' as const },
    },
    hdr_input_policy: 'reject' as const,
    caption_mode: 'none' as const,
    audio_policy: 'source_only' as const,
    created_at: now,
  }
  const revision = videoExportProfileRevisionSchema.parse({ ...withoutHash, content_hash: profileHash(withoutHash) })
  assertExportProfile(revision)
  return {
    profile: { id: profileId, scope: 'project_custom', current_revision_id: revision.id, created_at: now },
    revision,
  }
}

function defaultTracks(): VideoTimelineTrack[] {
  // Keep the source-audio track even for a silent initial import: a later
  // authorised source can be inserted through the same CommandSet without a
  // hidden track-creation writer.
  return [
    { id: id('track'), kind: 'primary_video', order: 0, locked: false, muted: false },
    { id: id('track'), kind: 'source_audio', order: 1, locked: false, muted: false },
  ]
}

function legacyItems(
  project: VideoStudioProject,
  tracks: VideoTimelineTrack[],
  timing: Map<string, EditorialSourceTiming>,
): VideoTimelineItem[] {
  const videoTrack = tracks.find(track => track.kind === 'primary_video')!
  const audioTrack = tracks.find(track => track.kind === 'source_audio')
  let cursor = 0n
  const items: VideoTimelineItem[] = []
  for (const clip of project.timeline) {
    const source = project.sources.find(candidate => candidate.id === clip.source_id)
    if (!source?.fingerprint) throw new EditorialValidationError('素材完整指纹尚未就绪，请稍后再试', 'VIDEO_SOURCE_FINGERPRINT_PENDING')
    const sourceTiming = timing.get(source.id) ?? { tick_rate: { num: 1000, den: 1 }, start_ticks: '0' }
    const start = millisecondsToTime(clip.in_ms, sourceTiming.tick_rate, BigInt(sourceTiming.start_ticks))
    const duration = millisecondsToTime(clip.out_ms - clip.in_ms, sourceTiming.tick_rate)
    const sourceRange = range(start, duration)
    const timelineRange = range(time(cursor, EDITORIAL_TICK_RATE), millisecondsToTime(clip.out_ms - clip.in_ms, EDITORIAL_TICK_RATE))
    const binding = { kind: 'source' as const, source_id: source.id, source_fingerprint: source.fingerprint, source_range: sourceRange }
    items.push({
      id: id('item'),
      legacy_scene_id: clip.id,
      track_id: videoTrack.id,
      kind: 'video',
      timeline_range: timelineRange,
      binding,
      linked_camera_shot_ids: [],
      linked_content_segment_ids: [],
      locked: false,
      evidence_ids: project.evidence.filter(evidence => evidence.source_id === source.id && evidence.in_ms < clip.out_ms && evidence.out_ms > clip.in_ms).map(evidence => evidence.id),
    })
    if (audioTrack && source.has_audio) {
      items.push({
        id: id('item'),
        legacy_scene_id: clip.id,
        track_id: audioTrack.id,
        kind: 'audio',
        timeline_range: clone(timelineRange),
        binding: clone(binding),
        linked_camera_shot_ids: [],
        linked_content_segment_ids: [],
        locked: false,
        evidence_ids: [],
      })
    }
    cursor += BigInt(millisecondsToTime(clip.out_ms - clip.in_ms, EDITORIAL_TICK_RATE).ticks)
  }
  return items
}

function withLegacySceneMetadata(items: VideoTimelineItem[], scenes: VideoScene[]): VideoTimelineItem[] {
  const scenesById = new Map(scenes.map(scene => [scene.id, scene]))
  return items.map(item => {
    const scene = item.legacy_scene_id ? scenesById.get(item.legacy_scene_id) : undefined
    return scene
      ? { ...item, locked: scene.locked, evidence_ids: clone(scene.evidence_ids) }
      : item
  })
}

function itemTrackKindValid(item: VideoTimelineItem, track: VideoTimelineTrack): boolean {
  if (track.kind === 'primary_video' || track.kind === 'b_roll') return item.kind === 'video'
  if (track.kind === 'source_audio' || track.kind === 'music') return item.kind === 'audio'
  if (track.kind === 'caption') return item.kind === 'caption'
  return item.kind === 'overlay'
}

export function validateEditorialTimeline(
  project: VideoStudioProject,
  timeline: EditorialTimelineVersion,
  sourceBounds: Map<string, EditorialSourceBounds> = new Map(),
): void {
  const tracks = new Map(timeline.tracks.map(track => [track.id, track]))
  if (tracks.size !== timeline.tracks.length || new Set(timeline.tracks.map(track => track.order)).size !== timeline.tracks.length) {
    throw new EditorialValidationError('时间线轨道必须具有唯一 ID 和顺序', 'VIDEO_EDITORIAL_INVALID')
  }
  if (new Set(timeline.items.map(item => item.id)).size !== timeline.items.length) {
    throw new EditorialValidationError('时间线条目 ID 不能重复', 'VIDEO_EDITORIAL_INVALID')
  }
  const sourceById = new Map(project.sources.map(source => [source.id, source]))
  for (const item of timeline.items) {
    const track = tracks.get(item.track_id)
    if (!track || !itemTrackKindValid(item, track)) throw new EditorialValidationError('时间线条目与轨道类型不匹配', 'VIDEO_EDITORIAL_INVALID')
    if (item.timeline_range.start.tick_rate.num !== timeline.tick_rate.num || item.timeline_range.start.tick_rate.den !== timeline.tick_rate.den
      || item.timeline_range.duration.tick_rate.num !== timeline.tick_rate.num || item.timeline_range.duration.tick_rate.den !== timeline.tick_rate.den
      || BigInt(item.timeline_range.start.ticks) < 0n || BigInt(item.timeline_range.duration.ticks) <= 0n) {
      throw new EditorialValidationError('编辑时间范围无效', 'VIDEO_EDITORIAL_INVALID')
    }
    if (item.binding.kind === 'source') {
      const source = sourceById.get(item.binding.source_id)
      if (!source || source.missing || source.content_changed || source.fingerprint !== item.binding.source_fingerprint) {
        throw new EditorialValidationError('时间线引用的素材已变化或不可用', 'VIDEO_EDITORIAL_STALE')
      }
      if (BigInt(item.binding.source_range.duration.ticks) <= 0n || durationMilliseconds(item.binding.source_range) > source.duration_ms + 1) {
        throw new EditorialValidationError('素材剪辑范围无效', 'VIDEO_EDITORIAL_INVALID')
      }
      if (!sourceDurationMatchesTimeline(item)) {
        throw new EditorialValidationError(item.speed
          ? '素材时长与显式 speed 不一致'
          : '素材时长与时间线时长不一致，必须显式声明 speed', 'VIDEO_EDITORIAL_INVALID')
      }
      const bounds = sourceBounds.get(source.id)
      if (bounds && (
        compare(item.binding.source_range.start, bounds.start) < 0
        || compare(end(item.binding.source_range), end(bounds)) > 0
      )) {
        throw new EditorialValidationError('素材剪辑范围超出原始素材边界', 'VIDEO_EDITORIAL_INVALID')
      }
    } else if (item.speed) {
      throw new EditorialValidationError('只有素材条目可以设置 speed', 'VIDEO_EDITORIAL_INVALID')
    }
  }
  for (const track of timeline.tracks.filter(track => track.kind === 'primary_video' || track.kind === 'source_audio')) {
    const ordered = timeline.items.filter(item => item.track_id === track.id).sort((left, right) => compare(left.timeline_range.start, right.timeline_range.start))
    for (let index = 1; index < ordered.length; index += 1) {
      if (compare(ordered[index]!.timeline_range.start, end(ordered[index - 1]!.timeline_range)) < 0) {
        throw new EditorialValidationError('主视频或源音频轨不能重叠', 'VIDEO_EDITORIAL_INVALID')
      }
    }
  }
  const avItems = timeline.items.flatMap(item => {
    const track = tracks.get(item.track_id)
    return track?.kind === 'primary_video' || track?.kind === 'source_audio'
      ? [{ item, track }]
      : []
  })
  const avPairs = new Map<string, Array<{ item: VideoTimelineItem; track: VideoTimelineTrack }>>()
  for (const entry of avItems) {
    if (entry.item.binding.kind !== 'source') continue
    const source = sourceById.get(entry.item.binding.source_id)
    if (entry.track.kind === 'source_audio' && !source?.has_audio) {
      throw new EditorialValidationError('源音频轨不能引用无音频的素材', 'VIDEO_EDITORIAL_INVALID')
    }
    const key = avPairKey(entry.item)
    if (key) avPairs.set(key, [...(avPairs.get(key) ?? []), entry])
  }
  for (const entries of avPairs.values()) {
    const video = entries.filter(entry => entry.track.kind === 'primary_video')
    const audio = entries.filter(entry => entry.track.kind === 'source_audio')
    const source = video[0]?.item.binding.kind === 'source' ? sourceById.get(video[0].item.binding.source_id) : undefined
    if (video.length > 1 || audio.length > 1 || (video.length && source?.has_audio && audio.length !== 1) || (audio.length && video.length !== 1)) {
      throw new EditorialValidationError('主视频与源音频必须保持一对一 A/V link、范围和 speed 一致', 'VIDEO_EDITORIAL_INVALID')
    }
  }
}

function requestHash(commandSet: TimelineCommandSet): `sha256:${string}` {
  return hash({ target: commandSet.target, commands: commandSet.commands })
}

function findItem(items: VideoTimelineItem[], itemId: string): VideoTimelineItem {
  const item = items.find(candidate => candidate.id === itemId)
  if (!item) throw new EditorialValidationError('时间线条目不存在', 'VIDEO_EDITORIAL_INVALID')
  return item
}

function assertEditable(item: VideoTimelineItem, tracks: VideoTimelineTrack[]): void {
  if (item.locked || tracks.find(track => track.id === item.track_id)?.locked) {
    throw new EditorialValidationError('锁定的时间线条目不能被修改', 'VIDEO_EDITORIAL_LOCKED')
  }
}

function timelineRangeKey(value: TimeRange): string {
  return `${value.start.ticks}/${value.start.tick_rate.num}/${value.start.tick_rate.den}:${value.duration.ticks}/${value.duration.tick_rate.num}/${value.duration.tick_rate.den}`
}

function avLinkKey(item: VideoTimelineItem, tracks: VideoTimelineTrack[]): string | undefined {
  const track = tracks.find(candidate => candidate.id === item.track_id)
  if (!track || (track.kind !== 'primary_video' && track.kind !== 'source_audio') || item.binding.kind !== 'source') return undefined
  if (item.legacy_scene_id) return `legacy:${item.legacy_scene_id}:${timelineRangeKey(item.timeline_range)}:${timelineRangeKey(item.binding.source_range)}:${speedKey(item.speed)}`
  return `source:${item.binding.source_id}:${item.binding.source_fingerprint}:${timelineRangeKey(item.timeline_range)}:${timelineRangeKey(item.binding.source_range)}:${speedKey(item.speed)}`
}

function applyEditorialCommands(
  timeline: EditorialTimelineVersion,
  commands: EditorialTimelineCommand[],
): { tracks: VideoTimelineTrack[]; items: VideoTimelineItem[] } {
  const tracks = clone(timeline.tracks)
  const items = clone(timeline.items)
  for (const command of commands) {
    if (command.kind === 'insert') {
      const track = tracks.find(candidate => candidate.id === command.track_id)
      if (!track || command.item.track_id !== track.id || !itemTrackKindValid(command.item, track) || items.some(item => item.id === command.item.id)) {
        throw new EditorialValidationError('插入命令无效', 'VIDEO_EDITORIAL_INVALID')
      }
      if (track.locked) throw new EditorialValidationError('锁定的轨道不能插入条目', 'VIDEO_EDITORIAL_LOCKED')
      items.push(clone(command.item))
      continue
    }
    if (command.kind === 'set_track_state') {
      const track = tracks.find(candidate => candidate.id === command.track_id)
      if (!track) throw new EditorialValidationError('时间线轨道不存在', 'VIDEO_EDITORIAL_INVALID')
      if (command.locked !== undefined) track.locked = command.locked
      if (command.muted !== undefined) track.muted = command.muted
      continue
    }
    if (command.kind === 'lock') {
      for (const itemId of command.item_ids) findItem(items, itemId).locked = command.locked
      continue
    }
    if (command.kind === 'trim') {
      const item = findItem(items, command.item_id)
      assertEditable(item, tracks)
      if (item.binding.kind !== 'source') throw new EditorialValidationError('只有素材条目支持裁剪', 'VIDEO_EDITORIAL_INVALID')
      item.binding.source_range = clone(command.source_range)
      item.timeline_range = clone(command.timeline_range)
      if (command.speed) item.speed = clone(command.speed)
      continue
    }
    if (command.kind === 'reorder') {
      const item = findItem(items, command.item_id)
      assertEditable(item, tracks)
      const track = tracks.find(candidate => candidate.id === command.track_id)
      if (!track || !itemTrackKindValid(item, track)) throw new EditorialValidationError('移动目标轨道无效', 'VIDEO_EDITORIAL_INVALID')
      if (track.locked) throw new EditorialValidationError('锁定的轨道不能接收移动条目', 'VIDEO_EDITORIAL_LOCKED')
      item.track_id = track.id
      item.timeline_range.start = clone(command.timeline_start)
      continue
    }
    if (command.kind === 'replace') {
      const index = items.findIndex(item => item.id === command.item_id)
      if (index < 0) throw new EditorialValidationError('时间线条目不存在', 'VIDEO_EDITORIAL_INVALID')
      assertEditable(items[index]!, tracks)
      const track = tracks.find(candidate => candidate.id === command.replacement.track_id)
      if (!track || !itemTrackKindValid(command.replacement, track)) {
        throw new EditorialValidationError('替换条目的目标轨道无效', 'VIDEO_EDITORIAL_INVALID')
      }
      if (track.locked) throw new EditorialValidationError('锁定的轨道不能接收替换条目', 'VIDEO_EDITORIAL_LOCKED')
      if (command.replacement.id !== command.item_id && items.some(item => item.id === command.replacement.id)) {
        throw new EditorialValidationError('替换条目 ID 已存在', 'VIDEO_EDITORIAL_INVALID')
      }
      items[index] = clone(command.replacement)
      continue
    }
    if (command.kind === 'split') {
      const item = findItem(items, command.item_id)
      assertEditable(item, tracks)
      if (item.binding.kind !== 'source' || !timeWithin(command.at, item.timeline_range) || compare(command.at, item.timeline_range.start) === 0 || compare(command.at, end(item.timeline_range)) === 0) {
        throw new EditorialValidationError('切分点必须位于素材条目内部', 'VIDEO_EDITORIAL_INVALID')
      }
      if (item.speed) throw new EditorialValidationError('变速素材必须先还原为 1x 后再切分', 'VIDEO_EDITORIAL_INVALID')
      const timelineFirstDuration = subtract(command.at, item.timeline_range.start)
      const timelineSecondDuration = subtract(end(item.timeline_range), command.at)
      const sourceDuration = BigInt(item.binding.source_range.duration.ticks)
      const timelineDuration = BigInt(item.timeline_range.duration.ticks)
      const sourceFirstDuration = (sourceDuration * BigInt(timelineFirstDuration.ticks)) / timelineDuration
      if (sourceFirstDuration <= 0n || sourceFirstDuration >= sourceDuration) throw new EditorialValidationError('切分点不能产生空素材范围', 'VIDEO_EDITORIAL_INVALID')
      const secondSourceStart = add(item.binding.source_range.start, time(sourceFirstDuration, item.binding.source_range.start.tick_rate))
      const second = clone(item)
      if (second.binding.kind !== 'source') throw new EditorialValidationError('切分条目类型无效', 'VIDEO_EDITORIAL_INVALID')
      second.id = id('item')
      second.timeline_range = range(clone(command.at), timelineSecondDuration)
      second.binding.source_range = range(secondSourceStart, time(sourceDuration - sourceFirstDuration, item.binding.source_range.start.tick_rate))
      item.timeline_range.duration = timelineFirstDuration
      item.binding.source_range.duration = time(sourceFirstDuration, item.binding.source_range.start.tick_rate)
      items.push(second)
      continue
    }
    const deleted = new Set(command.item_ids)
    const selected = items.filter(item => deleted.has(item.id))
    if (selected.length !== deleted.size) throw new EditorialValidationError('删除命令引用了不存在的条目', 'VIDEO_EDITORIAL_INVALID')
    selected.forEach(item => assertEditable(item, tracks))
    const selectedIds = new Set(selected.map(item => item.id))
    for (const item of selected) {
      const linkKey = avLinkKey(item, tracks)
      if (!linkKey) continue
      const linked = items.filter(candidate => candidate.id !== item.id && avLinkKey(candidate, tracks) === linkKey)
      if (linked.some(candidate => !selectedIds.has(candidate.id))) {
        throw new EditorialValidationError('关联的视频和源音频必须一起执行 ripple delete', 'VIDEO_EDITORIAL_INVALID')
      }
    }
    const removed = [...new Map(selected.map(item => [timelineRangeKey(item.timeline_range), clone(item.timeline_range)])).values()]
      .sort((left, right) => compare(left.start, right.start))
    const remaining = items.filter(item => !deleted.has(item.id))
    if (command.close_gap) {
      for (const item of remaining) {
        let shift = 0n
        for (const deletedRange of removed) {
          if (compare(end(deletedRange), item.timeline_range.start) <= 0) shift += BigInt(deletedRange.duration.ticks)
        }
        if (shift > 0n) item.timeline_range.start = time(BigInt(item.timeline_range.start.ticks) - shift, item.timeline_range.start.tick_rate)
      }
    }
    items.splice(0, items.length, ...remaining)
  }
  return { tracks, items }
}

function overrideFor(overrides: DeliveryVariantVersion['item_overrides'], itemId: string) {
  let value = overrides.find(override => override.item_id === itemId)
  if (!value) {
    value = { item_id: itemId }
    overrides.push(value)
  }
  return value
}

function validateOverrides(timeline: EditorialTimelineVersion, overrides: DeliveryVariantVersion['item_overrides']): void {
  const items = new Map(timeline.items.map(item => [item.id, item]))
  for (const override of overrides) {
    const item = items.get(override.item_id)
    if (!item) throw new EditorialValidationError('交付覆盖引用了不存在的时间线条目', 'VIDEO_EDITORIAL_INVALID')
    for (const keyframe of [...(override.transform_keyframes ?? []), ...(override.volume_keyframes ?? [])]) {
      if (!timeWithin(keyframe.at, item.timeline_range)) throw new EditorialValidationError('关键帧必须位于时间线条目范围内', 'VIDEO_EDITORIAL_INVALID')
    }
    if ((override.fade_in || override.fade_out) && item.kind !== 'audio') {
      throw new EditorialValidationError('淡入淡出只能应用于音频条目', 'VIDEO_EDITORIAL_INVALID')
    }
    if (override.fade_in && (BigInt(override.fade_in.ticks) < 0n || compare(override.fade_in, item.timeline_range.duration) > 0)) {
      throw new EditorialValidationError('淡入时长无效', 'VIDEO_EDITORIAL_INVALID')
    }
    if (override.fade_out && (BigInt(override.fade_out.ticks) < 0n || compare(override.fade_out, item.timeline_range.duration) > 0)) {
      throw new EditorialValidationError('淡出时长无效', 'VIDEO_EDITORIAL_INVALID')
    }
  }
}

export class EditorialApplication {
  constructor(private readonly now: () => Date) {}

  private iso(): string {
    return this.now().toISOString()
  }

  ensureState(
    project: VideoStudioProject,
    timing: Map<string, EditorialSourceTiming>,
    sourceBounds: Map<string, EditorialSourceBounds> = new Map(),
  ): VideoStudioProject {
    const existing = project.current_editorial_timeline_version_id
      ? project.editorial_timeline_versions.find(version => version.id === project.current_editorial_timeline_version_id)
      : undefined
    if (existing && project.delivery_variants.length && project.export_profile_revisions.length) return project
    const now = this.iso()
    const timeline = existing ?? editorialTimelineVersionSchema.parse({
      schema_version: 2,
      id: id('editorial_timeline'),
      project_revision: project.revision + 1,
      source_fingerprint_set_hash: sourceFingerprintSetHash(project),
      facts_basis_hash: editorialFactsBasisHash(project),
      tick_rate: EDITORIAL_TICK_RATE,
      tracks: defaultTracks(),
      items: [],
      created_by_command_set_id: id('command'),
      created_at: now,
    })
    if (!existing) {
      const legacyCurrent = project.current_timeline_version_id
        ? project.timeline_versions.find(version => version.id === project.current_timeline_version_id)
        : undefined
      timeline.items = withLegacySceneMetadata(
        legacyItems(project, timeline.tracks, timing),
        legacyCurrent?.scenes ?? [],
      )
      validateEditorialTimeline(project, timeline, sourceBounds)
    }
    const defaults = project.export_profile_revisions.length ? undefined : defaultProfile(project, now)
    const profile = project.export_profile_revisions[0] ?? defaults!.revision
    const exportProfile = project.export_profiles.find(candidate => candidate.current_revision_id === profile.id) ?? defaults!.profile
    const variant = project.delivery_variants[0]
    const variantVersion = variant ? project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id) : undefined
    const createdVariant = variant ?? { id: id('variant'), project_id: project.id, name: '默认交付', current_version_id: id('variant_version'), created_at: now }
    const createdVariantVersion = variantVersion ?? deliveryVariantVersionSchema.parse({
      id: createdVariant.current_version_id,
      variant_id: createdVariant.id,
      editorial_timeline_version_id: timeline.id,
      export_profile_revision_id: profile.id,
      export_profile_hash: profile.content_hash,
      item_overrides: [],
      created_by_command_set_id: timeline.created_by_command_set_id,
      created_at: now,
    })
    return {
      ...project,
      editorial_timeline_versions: existing ? project.editorial_timeline_versions : [...project.editorial_timeline_versions, timeline],
      current_editorial_timeline_version_id: timeline.id,
      export_profiles: project.export_profiles.some(candidate => candidate.id === exportProfile.id) ? project.export_profiles : [...project.export_profiles, exportProfile],
      export_profile_revisions: project.export_profile_revisions.some(candidate => candidate.id === profile.id) ? project.export_profile_revisions : [...project.export_profile_revisions, profile],
      delivery_variants: variant ? project.delivery_variants : [...project.delivery_variants, createdVariant],
      delivery_variant_versions: variantVersion ? project.delivery_variant_versions : [...project.delivery_variant_versions, createdVariantVersion],
      revision: project.revision + (existing && variant && variantVersion && project.export_profile_revisions.length ? 0 : 1),
      updated_at: now,
    }
  }

  createDraft(
    project: VideoStudioProject,
    scenes: VideoScene[],
    timing: Map<string, EditorialSourceTiming>,
    planIds: string[] = [],
    sourceBounds: Map<string, EditorialSourceBounds> = new Map(),
  ): TimelineDraft {
    const current = this.currentTimeline(project)
    const clips = scenes.map(scene => ({ id: scene.id, source_id: scene.source_id, in_ms: scene.in_ms, out_ms: scene.out_ms }))
    const draftProject = { ...project, timeline: clips }
    const items = withLegacySceneMetadata(
      legacyItems(draftProject, current.tracks, timing),
      scenes,
    ).map(item => ({ ...item, id: id('draft_item') }))
    const draft = timelineDraftSchema.parse({
      id: id('draft'),
      project_id: project.id,
      facts_basis_hash: editorialFactsBasisHash(project),
      base_timeline_version_id: current.id,
      plan_ids: planIds,
      tracks: current.tracks,
      items,
      status: 'proposed',
      created_at: this.iso(),
    })
    validateEditorialTimeline(project, { ...current, tracks: draft.tracks, items: draft.items }, sourceBounds)
    return draft
  }

  itemsFromLegacyClips(
    project: VideoStudioProject,
    clips: Array<{ id: string; source_id: string; in_ms: number; out_ms: number }>,
    tracks: VideoTimelineTrack[],
    timing: Map<string, EditorialSourceTiming>,
  ): VideoTimelineItem[] {
    return legacyItems({ ...project, timeline: clips }, tracks, timing)
  }

  itemsFromLegacyScenes(
    project: VideoStudioProject,
    scenes: VideoScene[],
    tracks: VideoTimelineTrack[],
    timing: Map<string, EditorialSourceTiming>,
  ): VideoTimelineItem[] {
    return withLegacySceneMetadata(
      legacyItems({ ...project, timeline: scenes.map(scene => ({ id: scene.id, source_id: scene.source_id, in_ms: scene.in_ms, out_ms: scene.out_ms })) }, tracks, timing),
      scenes,
    )
  }

  applyCommandSet(
    project: VideoStudioProject,
    commandSet: TimelineCommandSet,
    sourceBounds: Map<string, EditorialSourceBounds> = new Map(),
  ): { project: VideoStudioProject; version: EditorialTimelineVersion | DeliveryVariantVersion; reused: boolean } {
    if (commandSet.project_id !== project.id) throw new EditorialValidationError('命令集不属于当前视频项目', 'VIDEO_EDITORIAL_INVALID')
    const existing = project.editorial_command_receipts.find(receipt => receipt.idempotency_key === commandSet.idempotency_key)
    const request = requestHash(commandSet)
    if (existing) {
      if (existing.request_hash !== request) throw new EditorialValidationError('同一幂等键不能提交不同命令集', 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
      const version = existing.target_kind === 'editorial'
        ? project.editorial_timeline_versions.find(candidate => candidate.id === existing.created_version_id)
        : project.delivery_variant_versions.find(candidate => candidate.id === existing.created_version_id)
      if (!version) throw new EditorialValidationError('幂等命令的版本记录损坏', 'VIDEO_EDITORIAL_INVALID')
      return { project, version, reused: true }
    }
    if (commandSet.target.kind === 'editorial') {
      const current = this.currentTimeline(project)
      if (current.id !== commandSet.target.base_timeline_version_id) throw new EditorialValidationError('编辑时间线已更新，请刷新后重试', 'VIDEO_EDITORIAL_STALE')
      const next = applyEditorialCommands(current, commandSet.commands as EditorialTimelineCommand[])
      const version = editorialTimelineVersionSchema.parse({
        schema_version: 2,
        id: id('editorial_timeline'),
        parent_version_id: current.id,
        project_revision: project.revision + 1,
        source_fingerprint_set_hash: sourceFingerprintSetHash(project),
        facts_basis_hash: editorialFactsBasisHash(project),
        tick_rate: current.tick_rate,
        tracks: next.tracks,
        items: next.items,
        created_by_command_set_id: commandSet.id,
        created_at: this.iso(),
      })
      validateEditorialTimeline(project, version, sourceBounds)
      return {
        project: {
          ...project,
          editorial_timeline_versions: [...project.editorial_timeline_versions, version],
          current_editorial_timeline_version_id: version.id,
          editorial_command_receipts: [...project.editorial_command_receipts, {
            idempotency_key: commandSet.idempotency_key,
            command_set_id: commandSet.id,
            request_hash: request,
            target_kind: 'editorial',
            created_version_id: version.id,
            created_at: this.iso(),
          }],
          revision: project.revision + 1,
          updated_at: this.iso(),
        },
        version,
        reused: false,
      }
    }
    const deliveryTarget = commandSet.target as { kind: 'delivery_variant'; variant_id: string; base_variant_version_id: string }
    const variant = project.delivery_variants.find(candidate => candidate.id === deliveryTarget.variant_id)
    if (!variant || variant.current_version_id !== deliveryTarget.base_variant_version_id) {
      throw new EditorialValidationError('交付变体已更新，请刷新后重试', 'VIDEO_EDITORIAL_STALE')
    }
    const current = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)
    if (!current) throw new EditorialValidationError('交付变体版本不存在', 'VIDEO_EDITORIAL_INVALID')
    const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === current.editorial_timeline_version_id)
    if (!timeline) throw new EditorialValidationError('交付变体引用的编辑版本不存在', 'VIDEO_EDITORIAL_INVALID')
    const overrides = clone(current.item_overrides)
    let profileId = current.export_profile_revision_id
    let profileHash = current.export_profile_hash
    for (const command of commandSet.commands as DeliveryVariantCommand[]) {
      if (command.kind === 'set_export_profile') {
        const profile = project.export_profile_revisions.find(candidate => candidate.id === command.export_profile_revision_id)
        if (!profile || profile.content_hash !== command.expected_profile_hash) throw new EditorialValidationError('导出 Profile 已变化或不存在', 'VIDEO_EDITORIAL_STALE')
        assertExportProfile(profile)
        profileId = profile.id
        profileHash = profile.content_hash
      } else if (command.kind === 'set_caption_revision') {
        throw new EditorialValidationError('字幕 Document 与编译器尚未就绪，不能写入未编译的字幕命令', 'VIDEO_EDITORIAL_INVALID')
      } else if (command.kind === 'set_transform_keyframes') {
        overrideFor(overrides, command.item_id).transform_keyframes = clone(command.keyframes)
      } else if (command.kind === 'set_volume_keyframes') {
        overrideFor(overrides, command.item_id).volume_keyframes = clone(command.keyframes)
      } else if (command.kind === 'set_audio_fades') {
        const override = overrideFor(overrides, command.item_id)
        override.fade_in = command.fade_in ? clone(command.fade_in) : undefined
        override.fade_out = command.fade_out ? clone(command.fade_out) : undefined
      } else if (command.kind === 'set_caption_style') {
        throw new EditorialValidationError('字幕样式尚未具备编译路径，不能写入交付版本', 'VIDEO_EDITORIAL_INVALID')
      }
    }
    validateOverrides(timeline, overrides)
    const version = deliveryVariantVersionSchema.parse({
      id: id('variant_version'),
      variant_id: variant.id,
      parent_version_id: current.id,
      editorial_timeline_version_id: timeline.id,
      export_profile_revision_id: profileId,
      export_profile_hash: profileHash,
      item_overrides: overrides,
      created_by_command_set_id: commandSet.id,
      created_at: this.iso(),
    })
    return {
      project: {
        ...project,
        delivery_variants: project.delivery_variants.map(candidate => candidate.id === variant.id ? { ...candidate, current_version_id: version.id } : candidate),
        delivery_variant_versions: [...project.delivery_variant_versions, version],
        editorial_command_receipts: [...project.editorial_command_receipts, {
          idempotency_key: commandSet.idempotency_key,
          command_set_id: commandSet.id,
          request_hash: request,
          target_kind: 'delivery_variant',
          created_version_id: version.id,
          created_at: this.iso(),
        }],
        revision: project.revision + 1,
        updated_at: this.iso(),
      },
      version,
      reused: false,
    }
  }

  createDeliveryVariant(project: VideoStudioProject, input: { name: string; editorial_timeline_version_id?: string; export_profile_revision_id?: string }, commandSetId: string): { project: VideoStudioProject; variant: DeliveryVariant; version: DeliveryVariantVersion } {
    const timeline = input.editorial_timeline_version_id
      ? project.editorial_timeline_versions.find(candidate => candidate.id === input.editorial_timeline_version_id)
      : this.currentTimeline(project)
    if (!timeline) throw new EditorialValidationError('编辑时间线版本不存在', 'VIDEO_EDITORIAL_INVALID')
    validateEditorialTimeline(project, timeline)
    const profile = input.export_profile_revision_id
      ? project.export_profile_revisions.find(candidate => candidate.id === input.export_profile_revision_id)
      : project.export_profile_revisions[0]
    if (!profile) throw new EditorialValidationError('导出 Profile 不存在', 'VIDEO_EDITORIAL_INVALID')
    assertExportProfile(profile)
    const now = this.iso()
    const variant: DeliveryVariant = { id: id('variant'), project_id: project.id, name: input.name, current_version_id: id('variant_version'), created_at: now }
    const version = deliveryVariantVersionSchema.parse({
      id: variant.current_version_id,
      variant_id: variant.id,
      editorial_timeline_version_id: timeline.id,
      export_profile_revision_id: profile.id,
      export_profile_hash: profile.content_hash,
      item_overrides: [],
      created_by_command_set_id: commandSetId,
      created_at: now,
    })
    return {
      project: {
        ...project,
        delivery_variants: [...project.delivery_variants, variant],
        delivery_variant_versions: [...project.delivery_variant_versions, version],
        revision: project.revision + 1,
        updated_at: now,
      },
      variant,
      version,
    }
  }

  compile(
    project: VideoStudioProject,
    variantId: string,
    sourceBounds: Map<string, EditorialSourceBounds> = new Map(),
  ): { project: VideoStudioProject; plan: VideoExecutionPlan } {
    const variant = project.delivery_variants.find(candidate => candidate.id === variantId)
    const version = variant && project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)
    if (!variant || !version) throw new EditorialValidationError('交付变体不存在', 'VIDEO_EDITORIAL_INVALID')
    const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)
    const profile = project.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)
    if (!timeline || !profile || version.export_profile_hash !== profile.content_hash) throw new EditorialValidationError('交付变体引用的版本已失效', 'VIDEO_EDITORIAL_STALE')
    validateEditorialTimeline(project, timeline, sourceBounds)
    validateOverrides(timeline, version.item_overrides)
    assertExportProfile(profile)
    // The legacy preview renderer cannot consume arbitrary keyframed filters.
    // Do not publish an execution plan that would silently drop a requested
    // fade, transform or gain curve; these commands must wait for a compiler
    // that can execute them byte-for-byte.
    if (version.item_overrides.some(override => (
      override.transform_keyframes?.length
      || override.volume_keyframes?.length
      || override.fade_in
      || override.fade_out
    ))) throw new EditorialValidationError('当前执行编译器尚不支持关键帧、音量或淡入淡出命令', 'VIDEO_EDITORIAL_UNSUPPORTED')
    const planId = id('execution_plan')
    const trackOrder = new Map(timeline.tracks.map(track => [track.id, track.order]))
    const trackKind = new Map(timeline.tracks.map(track => [track.id, track.kind]))
    const orderedItems = [...timeline.items].sort((left, right) => {
      const position = compare(left.timeline_range.start, right.timeline_range.start)
      if (position !== 0) return position
      const trackPosition = (trackOrder.get(left.track_id) ?? 0) - (trackOrder.get(right.track_id) ?? 0)
      return trackPosition || left.id.localeCompare(right.id)
    })
    const sourceItems = orderedItems.filter(item => item.binding.kind === 'source')
    const maps = timeline.tracks.filter(track => !track.muted && timeline.items.some(item => item.track_id === track.id)).map((track): { track_id: string; output: 'video' | 'audio' | 'caption' } => {
      if (track.kind === 'primary_video' || track.kind === 'b_roll' || track.kind === 'overlay') return { track_id: track.id, output: 'video' }
      if (track.kind === 'caption') return { track_id: track.id, output: 'caption' }
      return { track_id: track.id, output: 'audio' }
    })
    const plan = videoExecutionPlanSchema.parse({
      id: planId,
      editorial_timeline_version_id: timeline.id,
      delivery_variant_version_id: version.id,
      timeline_items: orderedItems.map((item, order) => ({
        order,
        item_id: item.id,
        track_id: item.track_id,
        track_kind: trackKind.get(item.track_id)!,
        kind: item.kind,
        timeline_range: item.timeline_range,
        binding: item.binding,
        ...(item.speed ? { speed: item.speed } : {}),
      })),
      inputs: sourceItems.map(item => {
        const binding = item.binding as Extract<typeof item.binding, { kind: 'source' }>
        const bounds = sourceBounds.get(binding.source_id)
        if (!bounds) throw new EditorialValidationError('缺少原始视频流时间边界，不能编译执行计划', 'VIDEO_EDITORIAL_INVALID')
        return {
          source_id: binding.source_id,
          source_fingerprint: binding.source_fingerprint,
          source_start: bounds.start,
          source_range: binding.source_range,
        }
      }),
      filters: [
        { kind: 'scale_pad', width: profile.width, height: profile.height },
        ...version.item_overrides.flatMap(override => [
          ...(override.transform_keyframes?.length ? [{ kind: 'transform' as const, item_id: override.item_id, keyframes: override.transform_keyframes }] : []),
          ...(override.volume_keyframes?.length ? [{ kind: 'volume' as const, item_id: override.item_id, keyframes: override.volume_keyframes }] : []),
          ...((override.fade_in || override.fade_out) ? [{ kind: 'audio_fade' as const, item_id: override.item_id, ...(override.fade_in ? { fade_in: override.fade_in } : {}), ...(override.fade_out ? { fade_out: override.fade_out } : {}) }] : []),
        ]),
      ],
      maps,
      encoder: profile,
      color_pipeline: { output: 'sdr_bt709', hdr_input_policy: profile.hdr_input_policy },
      audio_pipeline: { policy: profile.audio_policy, sample_rate: 48_000, channels: profile.encoding.audio.channels },
      output_target: { kind: 'managed', locator: `execution-plans/${planId}` },
      compiler_version: 'editorial-compiler-v1',
      basis_hash: factBasisHash({ timeline: timeline.id, variant: version.id, profile: profile.content_hash, facts: timeline.facts_basis_hash }),
      created_at: this.iso(),
    })
    return { project: { ...project, execution_plans: [...project.execution_plans, plan], updated_at: this.iso() }, plan }
  }

  currentTimeline(project: VideoStudioProject): EditorialTimelineVersion {
    const timeline = project.current_editorial_timeline_version_id
      ? project.editorial_timeline_versions.find(candidate => candidate.id === project.current_editorial_timeline_version_id)
      : undefined
    if (!timeline) throw new EditorialValidationError('编辑时间线尚未初始化', 'VIDEO_EDITORIAL_INVALID')
    return timeline
  }
}
