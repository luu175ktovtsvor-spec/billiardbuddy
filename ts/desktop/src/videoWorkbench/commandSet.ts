import type {
  ApplyDeliveryVariantCommandsInput,
  ApplyEditorialTimelineCommandsInput,
  DeliveryVariantCommand,
  EditorialTimelineCommand,
  TimelineDraft,
  VideoTimelineItem,
  VideoTimelineTrack,
} from '../../../shared/contracts/media.js'
import type { VideoWorkbenchSnapshot } from './contracts.js'

export type VideoWorkbenchCommandErrorCode =
  | 'WORKSPACE_NOT_READY'
  | 'TIMELINE_MISSING'
  | 'DRAFT_NOT_ACCEPTABLE'
  | 'DRAFT_ITEM_MISSING'
  | 'LOCKED_ITEM'
  | 'LOCKED_TRACK'
  | 'VARIANT_MISSING'
  | 'VARIANT_VERSION_MISSING'
  | 'DELIVERY_PLAN_MISSING'
  | 'CAPTION_REVISION_MISSING'
  | 'EXPORT_PROFILE_MISSING'

export class VideoWorkbenchCommandError extends Error {
  constructor(
    readonly code: VideoWorkbenchCommandErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VideoWorkbenchCommandError'
  }
}

function currentTimeline(snapshot: VideoWorkbenchSnapshot) {
  if (!snapshot.current_timeline) {
    throw new VideoWorkbenchCommandError('TIMELINE_MISSING', '当前项目尚无可编辑时间线。')
  }
  return snapshot.current_timeline
}

function tracksById(tracks: readonly VideoTimelineTrack[]): Map<string, VideoTimelineTrack> {
  return new Map(tracks.map(track => [track.id, track]))
}

function itemsById(items: readonly VideoTimelineItem[]): Map<string, VideoTimelineItem> {
  return new Map(items.map(item => [item.id, item]))
}

function assertEditableItem(
  itemId: string,
  items: ReadonlyMap<string, VideoTimelineItem>,
  tracks: ReadonlyMap<string, VideoTimelineTrack>,
): VideoTimelineItem {
  const item = items.get(itemId)
  if (!item) throw new VideoWorkbenchCommandError('DRAFT_ITEM_MISSING', '要编辑的时间线条目不存在。')
  if (item.locked) throw new VideoWorkbenchCommandError('LOCKED_ITEM', '该时间线条目已锁定。')
  if (tracks.get(item.track_id)?.locked) throw new VideoWorkbenchCommandError('LOCKED_TRACK', '目标轨道已锁定。')
  return item
}

function assertEditableTrack(trackId: string, tracks: ReadonlyMap<string, VideoTimelineTrack>): void {
  const track = tracks.get(trackId)
  if (!track) throw new VideoWorkbenchCommandError('DRAFT_ITEM_MISSING', '目标轨道不存在。')
  if (track.locked) throw new VideoWorkbenchCommandError('LOCKED_TRACK', '目标轨道已锁定。')
}

/**
 * A partial draft accept is still one normal Editorial CommandSet. The UI
 * does not use the convenience whole-draft endpoint, because that would make
 * partial accept a second write path.
 */
export function buildPartialDraftAcceptance(
  snapshot: VideoWorkbenchSnapshot,
  draftId: string,
  selectedItemIds: readonly string[],
): ApplyEditorialTimelineCommandsInput {
  const timeline = currentTimeline(snapshot)
  const draft = snapshot.timeline_drafts.find(candidate => candidate.id === draftId)
  if (!draft || draft.status !== 'proposed') {
    throw new VideoWorkbenchCommandError('DRAFT_NOT_ACCEPTABLE', '该草稿不能再被接受。')
  }
  if (draft.base_timeline_version_id && draft.base_timeline_version_id !== timeline.id) {
    throw new VideoWorkbenchCommandError('DRAFT_NOT_ACCEPTABLE', '草稿基于旧时间线，请重新生成。')
  }
  const uniqueIds = [...new Set(selectedItemIds)]
  if (!uniqueIds.length) throw new VideoWorkbenchCommandError('DRAFT_NOT_ACCEPTABLE', '请至少选择一个草稿条目。')
  const draftItems = itemsById(draft.items)
  const targetTracks = tracksById(timeline.tracks)
  const commands: EditorialTimelineCommand[] = uniqueIds.map(itemId => {
    const item = draftItems.get(itemId)
    if (!item) throw new VideoWorkbenchCommandError('DRAFT_ITEM_MISSING', '选中的草稿条目不存在。')
    assertEditableTrack(item.track_id, targetTracks)
    return { kind: 'insert', track_id: item.track_id, item }
  })
  return { base_timeline_version_id: timeline.id, commands }
}

/**
 * Validate commands before they cross IPC. The server remains authoritative;
 * this only avoids presenting a destructive-looking action that is already
 * blocked by an explicitly locked item or track in the loaded snapshot.
 */
export function buildEditorialCommandRequest(
  snapshot: VideoWorkbenchSnapshot,
  commands: readonly EditorialTimelineCommand[],
): ApplyEditorialTimelineCommandsInput {
  const timeline = currentTimeline(snapshot)
  if (!commands.length) throw new VideoWorkbenchCommandError('WORKSPACE_NOT_READY', '至少需要一个编辑命令。')
  const items = itemsById(timeline.items)
  const tracks = tracksById(timeline.tracks)
  for (const command of commands) {
    switch (command.kind) {
      case 'insert':
        assertEditableTrack(command.track_id, tracks)
        break
      case 'trim':
      case 'split':
      case 'replace':
        assertEditableItem(command.item_id, items, tracks)
        if (command.kind === 'replace') assertEditableTrack(command.replacement.track_id, tracks)
        break
      case 'reorder':
        assertEditableItem(command.item_id, items, tracks)
        assertEditableTrack(command.track_id, tracks)
        break
      case 'ripple_delete':
        for (const itemId of command.item_ids) assertEditableItem(itemId, items, tracks)
        break
      case 'set_track_state':
        // Locking/unlocking a track is itself the intentional operation.
        if (!tracks.has(command.track_id)) throw new VideoWorkbenchCommandError('DRAFT_ITEM_MISSING', '要设置的轨道不存在。')
        break
      case 'lock':
        // Locking/unlocking an item is itself the intentional operation.
        for (const itemId of command.item_ids) {
          if (!items.has(itemId)) throw new VideoWorkbenchCommandError('DRAFT_ITEM_MISSING', '要设置的条目不存在。')
        }
        break
    }
  }
  return { base_timeline_version_id: timeline.id, commands: [...commands] }
}

function assertKnownDeliveryCommand(snapshot: VideoWorkbenchSnapshot, command: DeliveryVariantCommand): void {
  const timeline = currentTimeline(snapshot)
  const itemIds = new Set(timeline.items.map(item => item.id))
  switch (command.kind) {
    case 'set_caption_revision': {
      const document = snapshot.caption_documents.find(item => item.id === command.caption_document_id)
      const revision = snapshot.caption_revisions.find(item => item.id === command.caption_revision_id)
      if (!document || !revision || document.current_revision_id !== revision.id) {
        throw new VideoWorkbenchCommandError('CAPTION_REVISION_MISSING', '所选字幕版本已不可用，请刷新后重试。')
      }
      break
    }
    case 'set_composition_plan':
      if (!snapshot.composition_plans.some(item => item.id === command.composition_plan_id)) {
        throw new VideoWorkbenchCommandError('DELIVERY_PLAN_MISSING', '所选构图计划已不可用，请刷新后重试。')
      }
      break
    case 'set_audio_finishing_plan':
      if (!snapshot.audio_finishing_plans.some(item => item.id === command.audio_finishing_plan_id)) {
        throw new VideoWorkbenchCommandError('DELIVERY_PLAN_MISSING', '所选音频完成计划已不可用，请刷新后重试。')
      }
      break
    case 'set_transform_keyframes':
    case 'set_volume_keyframes':
    case 'set_audio_denoise':
    case 'set_audio_fades':
    case 'set_caption_style':
      if (!itemIds.has(command.item_id)) {
        throw new VideoWorkbenchCommandError('DRAFT_ITEM_MISSING', '所选交付条目已不存在，请刷新后重试。')
      }
      break
    case 'set_export_profile':
      if (!snapshot.project.export_profile_revisions.some(item => item.id === command.export_profile_revision_id)) {
        throw new VideoWorkbenchCommandError('EXPORT_PROFILE_MISSING', '所选导出规格已不可用，请刷新后重试。')
      }
      break
  }
}

/** Delivery settings always create a new immutable Variant Version. */
export function buildDeliveryVariantCommandRequest(
  snapshot: VideoWorkbenchSnapshot,
  variantId: string,
  commands: readonly DeliveryVariantCommand[],
): ApplyDeliveryVariantCommandsInput {
  if (!commands.length) throw new VideoWorkbenchCommandError('WORKSPACE_NOT_READY', '至少需要一个交付命令。')
  const projection = snapshot.variants.find(candidate => candidate.variant.id === variantId)
  if (!projection) throw new VideoWorkbenchCommandError('VARIANT_MISSING', '所选交付变体不存在。')
  if (!projection.version.id) throw new VideoWorkbenchCommandError('VARIANT_VERSION_MISSING', '所选交付变体没有可用版本。')
  for (const command of commands) assertKnownDeliveryCommand(snapshot, command)
  return {
    base_variant_version_id: projection.version.id,
    commands: [...commands],
  }
}

export function draftIsPartiallyAcceptable(draft: TimelineDraft, currentTimelineId: string | undefined): boolean {
  return draft.status === 'proposed'
    && (!draft.base_timeline_version_id || draft.base_timeline_version_id === currentTimelineId)
    && draft.items.length > 0
}
