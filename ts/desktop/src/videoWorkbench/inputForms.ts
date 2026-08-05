import type {
  CreateRemoteAnalysisConsentInput,
  DeliveryVariantCommand,
  EditorialTimelineCommand,
  VideoCaptionCue,
} from '../../../shared/contracts/media.js'
import type { VideoWorkbenchProjectCreateInput } from './contracts.js'
import type {
  VideoWorkbenchActionInput,
  VideoWorkbenchActionInputRequest,
} from './product.js'

export type VideoWorkbenchFormOption = Readonly<{ value: string; label: string; disabled?: boolean }>

export type VideoWorkbenchFormField = Readonly<{
  name: string
  label: string
  kind: 'text' | 'textarea' | 'number' | 'select' | 'choices' | 'checkbox'
  required?: boolean
  defaultValue?: string | number | boolean | readonly string[]
  placeholder?: string
  min?: number
  max?: number
  step?: number
  options?: readonly VideoWorkbenchFormOption[]
  help?: string
}>

export type VideoWorkbenchFormSpec = Readonly<{
  title: string
  description?: string
  confirmLabel: string
  fields: readonly VideoWorkbenchFormField[]
  destructive?: boolean
}>

export type VideoWorkbenchFormValues = Readonly<Record<string, string | boolean | readonly string[] | undefined>>

export type VideoWorkbenchFormResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; message: string }>

const remotePurposes = [
  ['visual_evidence', '视觉证据'],
  ['planning', '剪辑规划'],
  ['caption_translation', '字幕翻译'],
  ['asr', '语音转写'],
  ['semantic_search', '语义检索'],
] as const

const remoteDataKinds = [
  ['audio_extract', '音频提取'],
  ['keyframes', '关键帧'],
  ['proxy_video', '低清代理视频'],
  ['transcript', '已有转写文本'],
] as const

const remotePurposeSet = new Set<CreateRemoteAnalysisConsentInput['purposes'][number]>(remotePurposes.map(([value]) => value))
const remoteDataKindSet = new Set<CreateRemoteAnalysisConsentInput['data_kinds'][number]>(remoteDataKinds.map(([value]) => value))

function value(values: VideoWorkbenchFormValues, name: string): string | undefined {
  const candidate = values[name]
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
}

function numeric(values: VideoWorkbenchFormValues, name: string): number | undefined {
  const raw = value(values, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function checked(values: VideoWorkbenchFormValues, name: string): boolean {
  return values[name] === true
}

function selected(values: VideoWorkbenchFormValues, name: string): readonly string[] {
  const candidate = values[name]
  if (Array.isArray(candidate)) return candidate.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
  const single = typeof candidate === 'string' && candidate.trim() ? [candidate.trim()] : []
  return single
}

function selectedSource(request: VideoWorkbenchActionInputRequest): string | undefined {
  return request.selection.source_id
    ?? (request.snapshot.project.sources.length === 1 ? request.snapshot.project.sources[0]?.id : undefined)
}

function selectedVariant(request: VideoWorkbenchActionInputRequest) {
  return request.snapshot.variants.find(item => item.variant.id === request.selection.variant_id)
    ?? (request.snapshot.variants.length === 1 ? request.snapshot.variants[0] : undefined)
}

function sourceOptions(request: VideoWorkbenchActionInputRequest): readonly VideoWorkbenchFormOption[] {
  return request.snapshot.project.sources.map(source => ({
    value: source.id,
    label: `${source.name} (${Math.round(source.duration_ms / 1000)} 秒)`,
    disabled: source.missing || source.content_changed,
  }))
}

function currentCaptionRevision(request: VideoWorkbenchActionInputRequest) {
  const document = request.snapshot.caption_documents[request.snapshot.caption_documents.length - 1]
  const revision = document
    ? request.snapshot.caption_revisions.find(candidate => candidate.id === document.current_revision_id)
    : undefined
  return document && revision ? { document, revision } : undefined
}

function currentTimeline(request: VideoWorkbenchActionInputRequest) {
  return request.snapshot.current_timeline
}

function rationalTime(ticks: number, tickRate: { num: number; den: number }) {
  return { ticks: String(Math.round(ticks)), tick_rate: tickRate }
}

function videoTimeToMilliseconds(time: { ticks: string; tick_rate: { num: number; den: number } }): number {
  const ticks = Number(time.ticks)
  if (!Number.isFinite(ticks) || time.tick_rate.num <= 0 || time.tick_rate.den <= 0) return 0
  return (ticks * time.tick_rate.den * 1000) / time.tick_rate.num
}

function choiceOptions(values: readonly (readonly [string, string])[]): readonly VideoWorkbenchFormOption[] {
  return values.map(([value, label]) => ({ value, label }))
}

function inputError(message: string): VideoWorkbenchFormResult<never> {
  return { ok: false, message }
}

export function createProjectForm(): VideoWorkbenchFormSpec {
  return {
    title: '新建视频项目',
    description: '项目名称只用于工作台显示，不会包含本机路径或远程凭据。',
    confirmLabel: '创建项目',
    fields: [{ name: 'title', label: '项目名称', kind: 'text', required: true, placeholder: '例如：8 月赛事集锦' }],
  }
}

export function createProjectInput(values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchProjectCreateInput> {
  const title = value(values, 'title')
  return title ? { ok: true, value: { title } } : inputError('请填写项目名称。')
}

/** Declares fields only. The dialog host remains ephemeral and the snapshot
 * remains authoritative while a form is visible. */
export function createVideoWorkbenchActionForm(request: VideoWorkbenchActionInputRequest): VideoWorkbenchFormSpec | undefined {
  const timeline = currentTimeline(request)
  const sourceId = selectedSource(request)
  const variant = selectedVariant(request)
  switch (request.action) {
    case 'estimate_budget': {
      const source = request.snapshot.project.sources.find(candidate => candidate.id === sourceId)
      return {
        title: '远程分析范围与预算',
        description: '仅在先完成估算、再明确确认后，才会向远端发送所选范围。取消或关闭不会产生远端调用。',
        confirmLabel: '估算预算',
        fields: [
          { name: 'source_id', label: '素材', kind: 'select', required: true, options: sourceOptions(request), defaultValue: source?.id },
          { name: 'start_ms', label: '起始时间（毫秒）', kind: 'number', required: true, defaultValue: 0, min: 0, step: 1 },
          { name: 'end_ms', label: '结束时间（毫秒）', kind: 'number', required: true, defaultValue: source?.duration_ms ?? 0, min: 1, step: 1 },
          { name: 'purposes', label: '远程用途', kind: 'choices', required: true, options: choiceOptions(remotePurposes), defaultValue: ['asr'] },
          { name: 'data_kinds', label: '发送的数据', kind: 'choices', required: true, options: choiceOptions(remoteDataKinds), defaultValue: ['audio_extract'] },
        ],
      }
    }
    case 'create_quick_draft':
      return {
        title: '创建剪辑草稿',
        description: '草稿只会基于当前素材事实生成，接受前仍可逐项选择。',
        confirmLabel: '创建草稿',
        fields: [{ name: 'user_goal', label: '剪辑目标', kind: 'textarea', required: true, placeholder: '说明受众、节奏和要保留的画面。' }],
      }
    case 'open_editor':
      return timeline ? {
        title: '编辑时间线',
        description: '本次操作会生成一个新的正式 Timeline Version。锁定条目和锁定轨道会被客户端和服务端共同拒绝。',
        confirmLabel: '应用 CommandSet',
        fields: [
          {
            name: 'editorial_kind',
            label: '编辑动作',
            kind: 'select',
            required: true,
            defaultValue: 'ripple_delete',
            options: [
              { value: 'ripple_delete', label: '删除所选条目并关闭空隙' },
              { value: 'lock', label: '锁定或解锁所选条目' },
              { value: 'set_track_state', label: '设置轨道锁定或静音' },
            ],
          },
          {
            name: 'item_ids',
            label: '时间线条目',
            kind: 'choices',
            options: timeline.items.map(item => ({ value: item.id, label: `${item.id.slice(0, 12)} · ${item.track_id.slice(0, 10)}${item.locked ? ' · 已锁定' : ''}`, disabled: item.locked || timeline.tracks.find(track => track.id === item.track_id)?.locked })),
            defaultValue: request.selection.timeline_item_ids,
            help: '删除或锁定动作需要至少选择一个未锁定条目。',
          },
          { name: 'lock_value', label: '设为锁定', kind: 'checkbox', defaultValue: true, help: '取消勾选表示解锁所选条目。' },
          {
            name: 'track_id',
            label: '轨道',
            kind: 'select',
            options: timeline.tracks.map(track => ({ value: track.id, label: `${track.id.slice(0, 12)}${track.locked ? ' · 已锁定' : ''}` })),
          },
          { name: 'track_locked', label: '轨道锁定', kind: 'checkbox', defaultValue: false },
          { name: 'track_muted', label: '轨道静音', kind: 'checkbox', defaultValue: false },
        ],
      } : undefined
    case 'open_variant_editor':
      return variant ? {
        title: '完成与交付设置',
        description: '每次应用都会生成新的 Delivery Variant Version，预览和导出只使用冻结版本。',
        confirmLabel: '应用 CommandSet',
        fields: [
          {
            name: 'delivery_kind',
            label: '交付动作',
            kind: 'select',
            required: true,
            defaultValue: 'set_caption_revision',
            options: [
              { value: 'set_caption_revision', label: '选择字幕修订' },
              { value: 'set_composition_plan', label: '选择构图计划' },
              { value: 'set_audio_finishing_plan', label: '选择音频完成计划' },
              { value: 'set_export_profile', label: '选择导出规格' },
            ],
          },
          { name: 'caption_revision_id', label: '字幕修订', kind: 'select', options: request.snapshot.caption_revisions.map(revision => ({ value: revision.id, label: `${revision.language} · ${revision.id.slice(0, 12)}` })) },
          { name: 'composition_plan_id', label: '构图计划', kind: 'select', options: request.snapshot.composition_plans.map(plan => ({ value: plan.id, label: plan.id.slice(0, 16) })) },
          { name: 'audio_finishing_plan_id', label: '音频完成计划', kind: 'select', options: request.snapshot.audio_finishing_plans.map(plan => ({ value: plan.id, label: plan.id.slice(0, 16) })) },
          { name: 'export_profile_revision_id', label: '导出规格', kind: 'select', options: request.snapshot.project.export_profile_revisions.map(profile => ({ value: profile.id, label: `${profile.target} · ${profile.width}x${profile.height}` })) },
        ],
      } : undefined
    case 'create_variant':
      return timeline ? {
        title: '新建交付变体',
        confirmLabel: '创建变体',
        fields: [{ name: 'name', label: '变体名称', kind: 'text', required: true, placeholder: '例如：竖版短视频' }],
      } : undefined
    case 'create_caption':
      return timeline ? {
        title: '生成字幕草稿',
        confirmLabel: '生成字幕',
        fields: [
          { name: 'language', label: '字幕语言', kind: 'text', required: true, defaultValue: 'zh', placeholder: 'zh' },
          { name: 'font_size', label: '字号', kind: 'number', defaultValue: 48, min: 12, max: 128, step: 1 },
        ],
      } : undefined
    case 'create_caption_revision': {
      const caption = currentCaptionRevision(request)
      return caption && timeline ? {
        title: '编辑字幕修订',
        description: '锚点和时间范围来自不可变的当前字幕修订；这里只允许修改文本和语言。',
        confirmLabel: '保存字幕修订',
        fields: [
          { name: 'language', label: '字幕语言', kind: 'text', required: true, defaultValue: caption.revision.language },
          ...caption.revision.cues.map(cue => ({ name: `cue:${cue.id}`, label: `${Math.round(videoTimeToMilliseconds(cue.timeline_range.start))} ms`, kind: 'textarea' as const, required: true, defaultValue: cue.text })),
        ],
      } : undefined
    }
    case 'create_caption_translation':
      return currentCaptionRevision(request) && timeline ? {
        title: '翻译字幕',
        description: '翻译请求仍受已确认范围、预算和远端授权约束。',
        confirmLabel: '创建翻译任务',
        fields: [{ name: 'language', label: '目标语言', kind: 'text', required: true, defaultValue: 'en', placeholder: 'en' }],
      } : undefined
    case 'create_composition_plan':
      return variant ? { title: '生成构图计划', confirmLabel: '生成计划', fields: [] } : undefined
    case 'create_audio_finishing_plan':
      return variant ? { title: '生成音频完成计划', confirmLabel: '生成计划', fields: [] } : undefined
    case 'analyze_beat':
      return {
        title: '分析节拍',
        confirmLabel: '开始分析',
        fields: [{ name: 'source_id', label: '素材', kind: 'select', required: true, options: sourceOptions(request), defaultValue: sourceId }],
      }
    case 'create_beat_sync_draft':
      return sourceId && timeline ? {
        title: '创建节拍同步草稿',
        confirmLabel: '创建草稿',
        fields: [{ name: 'beat_evidence_id', label: '节拍证据', kind: 'select', required: true, options: request.snapshot.facts.items.filter(item => item.source_id === sourceId).map(item => ({ value: item.id, label: `${item.kind} · ${item.id.slice(0, 12)} · ${item.state}` })) }],
      } : undefined
    case 'analyze_subject_track':
      return {
        title: '分析主体轨迹',
        confirmLabel: '开始分析',
        fields: [
          { name: 'source_id', label: '素材', kind: 'select', required: true, options: sourceOptions(request), defaultValue: sourceId },
          { name: 'subject_id', label: '主体名称或编号', kind: 'text', required: true, placeholder: '例如：选手 A' },
        ],
      }
    case 'create_review_note':
      return timeline ? {
        title: '新增版本化反馈',
        description: '反馈会固定关联到当前不可变 Timeline Version。后续处理只能追加新的处理事件，不能改写原反馈。',
        confirmLabel: '保存反馈',
        fields: [
          { name: 'actor_id', label: '反馈人', kind: 'text', required: true, defaultValue: 'local_creator' },
          { name: 'start_ms', label: '起始时间（毫秒）', kind: 'number', required: true, defaultValue: 0, min: 0, step: 1 },
          { name: 'end_ms', label: '结束时间（毫秒）', kind: 'number', required: true, defaultValue: 1_000, min: 1, step: 1 },
          { name: 'body', label: '反馈内容', kind: 'textarea', required: true, placeholder: '说明需要调整的内容和依据。' },
        ],
      } : undefined
    case 'resolve_review_note': {
      const review = request.snapshot.project.review_notes.find(note => note.id === request.target_id)
      return review?.status === 'open' ? {
        title: '处理版本化反馈',
        description: '已处理必须关联一个新的不可变 Timeline Version；驳回不会伪造替代版本。',
        confirmLabel: '追加处理事件',
        fields: [
          { name: 'actor_id', label: '处理人', kind: 'text', required: true, defaultValue: 'local_creator' },
          {
            name: 'state',
            label: '处理结果',
            kind: 'select',
            required: true,
            defaultValue: 'dismissed',
            options: [
              { value: 'addressed', label: '已处理（关联当前新版本）', disabled: timeline?.id === review.timeline_version_id },
              { value: 'dismissed', label: '驳回（保留原反馈）' },
            ],
          },
        ],
      } : undefined
    }
    case 'create_approval_decision':
      return timeline ? {
        title: '提交审批决定',
        description: '审批决定会追加到当前 Timeline Version；要求修改时必须明确关联尚未处理的反馈。',
        confirmLabel: '保存审批决定',
        fields: [
          { name: 'actor_id', label: '审批人', kind: 'text', required: true, defaultValue: 'local_creator' },
          {
            name: 'state',
            label: '审批决定',
            kind: 'select',
            required: true,
            defaultValue: 'approved',
            options: [
              { value: 'approved', label: '通过' },
              { value: 'changes_requested', label: '要求修改' },
            ],
          },
          {
            name: 'note_ids',
            label: '关联反馈',
            kind: 'choices',
            options: request.snapshot.project.review_notes
              .filter(note => note.timeline_version_id === timeline.id && note.status === 'open')
              .map(note => ({ value: note.id, label: `${note.body.slice(0, 72)} · ${note.actor_id}` })),
            help: '“要求修改”必须至少选择一条当前版本未处理的反馈。',
          },
        ],
      } : undefined
    case 'confirm_post_render_quality':
      return request.pending_quality ? {
        title: '确认后渲染质量报告',
        description: `将确认当前报告的 ${request.pending_quality.accepted_check_ids.length} 项人工决策，并发布与其绑定的输出。`,
        confirmLabel: '确认并发布',
        destructive: true,
        fields: [{ name: 'confirmed', label: '我已审阅全部待确认项', kind: 'checkbox', required: true }],
      } : undefined
  }
}

function selectedRemoteValues<Value extends string>(
  values: VideoWorkbenchFormValues,
  name: string,
  allowed: ReadonlySet<Value>,
): readonly Value[] | undefined {
  const entries = [...new Set(selected(values, name))]
  return entries.length && entries.every((item): item is Value => allowed.has(item as Value)) ? entries : undefined
}

function captionRevisionInput(request: VideoWorkbenchActionInputRequest, values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const caption = currentCaptionRevision(request)
  const timeline = currentTimeline(request)
  const language = value(values, 'language')
  if (!caption || !timeline || !language) return inputError('当前字幕修订已变化，请刷新后重新编辑。')
  const cues = caption.revision.cues.map(cue => {
    const text = value(values, `cue:${cue.id}`)
    if (!text) return undefined
    const { id: _id, ...inputCue } = cue
    return { ...inputCue, text }
  })
  if (cues.some(cue => !cue)) return inputError('每条字幕都必须保留文本。')
  return {
    ok: true,
    value: {
      action: 'create_caption_revision',
      caption_document_id: caption.document.id,
      input: {
        base_revision_id: caption.revision.id,
        editorial_timeline_version_id: timeline.id,
        language,
        style_id: caption.revision.style_id,
        cues: cues as Omit<VideoCaptionCue, 'id'>[],
      },
    },
  }
}

function editorialCommandInput(request: VideoWorkbenchActionInputRequest, values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const timeline = currentTimeline(request)
  const kind = value(values, 'editorial_kind')
  if (!timeline || !kind) return inputError('当前时间线已变化，请刷新后重新编辑。')
  let commands: readonly EditorialTimelineCommand[]
  if (kind === 'ripple_delete') {
    const itemIds = selected(values, 'item_ids')
    if (!itemIds.length) return inputError('请至少选择一个时间线条目。')
    commands = [{ kind: 'ripple_delete', item_ids: [...itemIds], close_gap: true }]
  } else if (kind === 'lock') {
    const itemIds = selected(values, 'item_ids')
    if (!itemIds.length) return inputError('请至少选择一个时间线条目。')
    commands = [{ kind: 'lock', item_ids: [...itemIds], locked: checked(values, 'lock_value') }]
  } else if (kind === 'set_track_state') {
    const trackId = value(values, 'track_id')
    if (!trackId) return inputError('请选择需要设置的轨道。')
    commands = [{ kind: 'set_track_state', track_id: trackId, locked: checked(values, 'track_locked'), muted: checked(values, 'track_muted') }]
  } else {
    return inputError('不支持该编辑动作。')
  }
  return { ok: true, value: { action: 'open_editor', commands } }
}

function deliveryCommandInput(request: VideoWorkbenchActionInputRequest, values: VideoWorkbenchFormValues): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const kind = value(values, 'delivery_kind')
  const variant = selectedVariant(request)
  if (!kind || !variant) return inputError('当前交付变体已变化，请刷新后重试。')
  let command: DeliveryVariantCommand
  if (kind === 'set_caption_revision') {
    const revisionId = value(values, 'caption_revision_id')
    const revision = request.snapshot.caption_revisions.find(candidate => candidate.id === revisionId)
    const document = revision ? request.snapshot.caption_documents.find(candidate => candidate.current_revision_id === revision.id) : undefined
    if (!revision || !document) return inputError('请选择当前可用的字幕修订。')
    command = { kind, caption_document_id: document.id, caption_revision_id: revision.id }
  } else if (kind === 'set_composition_plan') {
    const compositionPlanId = value(values, 'composition_plan_id')
    if (!compositionPlanId) return inputError('请选择构图计划。')
    command = { kind, composition_plan_id: compositionPlanId }
  } else if (kind === 'set_audio_finishing_plan') {
    const audioPlanId = value(values, 'audio_finishing_plan_id')
    if (!audioPlanId) return inputError('请选择音频完成计划。')
    command = { kind, audio_finishing_plan_id: audioPlanId }
  } else if (kind === 'set_export_profile') {
    const profileId = value(values, 'export_profile_revision_id')
    const profile = request.snapshot.project.export_profile_revisions.find(candidate => candidate.id === profileId)
    if (!profile) return inputError('请选择导出规格。')
    command = { kind, export_profile_revision_id: profile.id, expected_profile_hash: profile.content_hash }
  } else {
    return inputError('不支持该交付动作。')
  }
  return { ok: true, value: { action: 'open_variant_editor', commands: [command] } }
}

/** Converts only declared form values into typed UI input. It never accepts a
 * path, URL, capability, provider prompt, credential, or arbitrary JSON. */
export function createVideoWorkbenchActionInput(
  request: VideoWorkbenchActionInputRequest,
  values: VideoWorkbenchFormValues,
): VideoWorkbenchFormResult<VideoWorkbenchActionInput> {
  const timeline = currentTimeline(request)
  const variant = selectedVariant(request)
  switch (request.action) {
    case 'estimate_budget': {
      const sourceId = value(values, 'source_id')
      const source = request.snapshot.project.sources.find(candidate => candidate.id === sourceId)
      const purposes = selectedRemoteValues(values, 'purposes', remotePurposeSet)
      const dataKinds = selectedRemoteValues(values, 'data_kinds', remoteDataKindSet)
      const startMs = numeric(values, 'start_ms')
      const endMs = numeric(values, 'end_ms')
      if (!source || !purposes || !dataKinds || startMs === undefined || endMs === undefined || startMs < 0 || endMs <= startMs || endMs > source.duration_ms) {
        return inputError('请选择可用素材、范围、用途和发送数据。')
      }
      return {
        ok: true,
        value: {
          action: 'estimate_budget',
          purposes,
          source_ids: [source.id],
          data_kinds: dataKinds,
          coverage: [{
            source_id: source.id,
            ranges: [{
              start: rationalTime(startMs, { num: 1_000, den: 1 }),
              duration: rationalTime(endMs - startMs, { num: 1_000, den: 1 }),
            }],
          }],
        },
      }
    }
    case 'create_quick_draft': {
      const userGoal = value(values, 'user_goal')
      return userGoal ? { ok: true, value: { action: 'create_quick_draft', input: { base_revision: request.snapshot.project.revision, user_goal: userGoal } } } : inputError('请说明剪辑目标。')
    }
    case 'open_editor':
      return editorialCommandInput(request, values)
    case 'open_variant_editor':
      return deliveryCommandInput(request, values)
    case 'create_variant': {
      const name = value(values, 'name')
      return name && timeline ? { ok: true, value: { action: 'create_variant', input: { name, editorial_timeline_version_id: timeline.id } } } : inputError('请填写变体名称。')
    }
    case 'create_caption': {
      const language = value(values, 'language')
      const fontSize = numeric(values, 'font_size') ?? 48
      return language && timeline ? {
        ok: true,
        value: {
          action: 'create_caption',
          input: {
            editorial_timeline_version_id: timeline.id,
            language,
            style: { name: '默认字幕', font_family: 'Noto Sans CJK SC', font_size: fontSize, fill: '#FFFFFF', outline_fill: '#000000', outline_width: 2, bottom_safe_area: 0.08, max_width: 0.9 },
          },
        },
      } : inputError('当前时间线已变化，请刷新后重新生成字幕。')
    }
    case 'create_caption_revision':
      return captionRevisionInput(request, values)
    case 'create_caption_translation': {
      const caption = currentCaptionRevision(request)
      const language = value(values, 'language')
      return caption && timeline && language ? {
        ok: true,
        value: {
          action: 'create_caption_translation',
          caption_document_id: caption.document.id,
          input: { base_revision_id: caption.revision.id, editorial_timeline_version_id: timeline.id, language, style_id: caption.revision.style_id },
        },
      } : inputError('当前字幕修订已变化，请刷新后重试。')
    }
    case 'create_composition_plan':
      return variant ? { ok: true, value: { action: 'create_composition_plan', input: { variant_id: variant.variant.id, base_variant_version_id: variant.version.id } } } : inputError('请选择交付变体。')
    case 'create_audio_finishing_plan':
      return variant ? { ok: true, value: { action: 'create_audio_finishing_plan', input: { variant_id: variant.variant.id, base_variant_version_id: variant.version.id } } } : inputError('请选择交付变体。')
    case 'analyze_beat': {
      const sourceId = value(values, 'source_id')
      return sourceId ? { ok: true, value: { action: 'analyze_beat', input: { source_id: sourceId } } } : inputError('请选择素材。')
    }
    case 'create_beat_sync_draft': {
      const sourceId = selectedSource(request)
      const beatEvidenceId = value(values, 'beat_evidence_id')
      return sourceId && timeline && beatEvidenceId
        ? { ok: true, value: { action: 'create_beat_sync_draft', input: { source_id: sourceId, beat_evidence_id: beatEvidenceId, base_timeline_version_id: timeline.id } } }
        : inputError('请选择节拍证据。')
    }
    case 'analyze_subject_track': {
      const sourceId = value(values, 'source_id')
      const subjectId = value(values, 'subject_id')
      return sourceId && subjectId ? { ok: true, value: { action: 'analyze_subject_track', input: { source_id: sourceId, subject_id: subjectId } } } : inputError('请选择素材并填写主体。')
    }
    case 'create_review_note': {
      const actorId = value(values, 'actor_id')
      const body = value(values, 'body')
      const startMs = numeric(values, 'start_ms')
      const endMs = numeric(values, 'end_ms')
      if (!timeline || !actorId || !body || startMs === undefined || endMs === undefined || startMs < 0 || endMs <= startMs) {
        return inputError('请填写反馈人、有效时间范围和反馈内容。')
      }
      return {
        ok: true,
        value: {
          action: 'create_review_note',
          input: {
            actor_id: actorId,
            anchor: {
              kind: 'timeline_range',
              editorial_timeline_version_id: timeline.id,
              range: {
                start: rationalTime(startMs, { num: 1_000, den: 1 }),
                duration: rationalTime(endMs - startMs, { num: 1_000, den: 1 }),
              },
            },
            body,
          },
        },
      }
    }
    case 'resolve_review_note': {
      const review = request.snapshot.project.review_notes.find(note => note.id === request.target_id)
      const actorId = value(values, 'actor_id')
      const state = value(values, 'state')
      if (!review || review.status !== 'open' || !request.target_id || !actorId || (state !== 'addressed' && state !== 'dismissed')) {
        return inputError('当前反馈已变化，请刷新后重试。')
      }
      if (state === 'dismissed') {
        return { ok: true, value: { action: 'resolve_review_note', review_note_id: review.id, input: { actor_id: actorId, state } } }
      }
      if (!timeline || timeline.id === review.timeline_version_id) {
        return inputError('请先通过编辑 CommandSet 创建新的 Timeline Version，再标记反馈已处理。')
      }
      return {
        ok: true,
        value: {
          action: 'resolve_review_note',
          review_note_id: review.id,
          input: { actor_id: actorId, state, resolved_by_timeline_version_id: timeline.id },
        },
      }
    }
    case 'create_approval_decision': {
      const actorId = value(values, 'actor_id')
      const state = value(values, 'state')
      const noteIds = selected(values, 'note_ids')
      if (!timeline || !actorId || (state !== 'approved' && state !== 'changes_requested')) {
        return inputError('请填写审批人和审批决定。')
      }
      if (state === 'changes_requested' && !noteIds.length) return inputError('要求修改时必须关联至少一条反馈。')
      const validNoteIds = new Set(request.snapshot.project.review_notes
        .filter(note => note.timeline_version_id === timeline.id && note.status === 'open')
        .map(note => note.id))
      if (!noteIds.every(noteId => validNoteIds.has(noteId))) return inputError('只能关联当前版本尚未处理的反馈。')
      return { ok: true, value: { action: 'create_approval_decision', input: { actor_id: actorId, state, note_ids: [...noteIds] } } }
    }
    case 'confirm_post_render_quality':
      return checked(values, 'confirmed') ? { ok: true, value: { action: 'confirm_post_render_quality', confirmed: true } } : inputError('请明确确认全部待确认项。')
  }
}
