import { VIDEO_WORKBENCH_FACT_KINDS, type VideoWorkbenchFactKind, type VideoWorkbenchPanel, type VideoWorkbenchProjectProjection, type VideoWorkbenchSelection } from './contracts.js'
import { installVideoWorkbenchStyles } from './styles.js'
import { videoMediaKindLabel, type VideoWorkbenchActionAvailability, type VideoWorkbenchViewModel } from './viewModel.js'

export type VideoWorkbenchSurfaceAction =
  | 'refresh'
  | 'switch_project'
  | 'create_project'
  | 'choose_sources'
  | 'estimate_budget'
  | 'confirm_budget'
  | 'create_quick_draft'
  | 'accept_draft'
  | 'open_editor'
  | 'open_variant_editor'
  | 'create_variant'
  | 'create_caption'
  | 'create_caption_revision'
  | 'create_caption_translation'
  | 'create_composition_plan'
  | 'create_audio_finishing_plan'
  | 'analyze_beat'
  | 'create_beat_sync_draft'
  | 'analyze_subject_track'
  | 'create_review_note'
  | 'resolve_review_note'
  | 'create_approval_decision'
  | 'preflight'
  | 'preview'
  | 'render'
  | 'confirm_post_render_quality'
  | 'retry_analysis'
  | 'poll_operations'
  | 'cancel_operation'

export type VideoWorkbenchSurfaceCallbacks = Readonly<{
  onPanel(panel: VideoWorkbenchPanel): void
  onAction(action: VideoWorkbenchSurfaceAction, targetId?: string): void
  onSelection(selection: Partial<VideoWorkbenchSelection>): void
  onToggleDraftItem(draftId: string, itemId: string): void
  onToggleTimelineItem(itemId: string): void
  onLoadFacts(kind: VideoWorkbenchFactKind, sourceId?: string): void
  onLoadMoreFacts(): void
  onSearchFacts(query: string): void
  onLoadMoreFactSearch(): void
}>

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className?: string): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag)
  if (className) value.className = className
  return value
}

function text(tag: keyof HTMLElementTagNameMap, value: string, className?: string): HTMLElement {
  const node = element(tag, className)
  node.textContent = value
  return node
}

function briefText(value: string): string {
  const normalized = value.trim()
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized
}

/** Selecting a candidate means selecting its whole Draft first. Individual
 * item toggles can then narrow the CommandSet before the user confirms it. */
export function videoDraftSelection(
  model: VideoWorkbenchViewModel,
  draftId: string,
): Pick<VideoWorkbenchSelection, 'timeline_draft_id' | 'draft_item_ids'> {
  const draft = model.quick_create.drafts.find(candidate => candidate.id === draftId)
  return {
    timeline_draft_id: draftId,
    draft_item_ids: draft?.items.map(item => item.id) ?? [],
  }
}

function actionButton(
  label: string,
  action: VideoWorkbenchSurfaceAction,
  availability: VideoWorkbenchActionAvailability,
  callbacks: VideoWorkbenchSurfaceCallbacks,
  targetId?: string,
): HTMLButtonElement {
  const button = element('button', 'bb-video-action')
  button.type = 'button'
  button.textContent = label
  button.disabled = !availability.enabled
  button.dataset.videoAction = action
  if (targetId) button.dataset.videoTarget = targetId
  if (availability.reason) button.title = availability.reason
  button.addEventListener('click', event => {
    event.stopPropagation()
    callbacks.onAction(action, targetId)
  })
  return button
}

function commandButton(
  label: string,
  availability: VideoWorkbenchActionAvailability,
  onClick: () => void,
): HTMLButtonElement {
  const button = element('button', 'bb-video-action')
  button.type = 'button'
  button.textContent = label
  button.disabled = !availability.enabled
  if (availability.reason) button.title = availability.reason
  button.addEventListener('click', event => {
    event.stopPropagation()
    onClick()
  })
  return button
}

function stateClass(state: string): string {
  return `is-${state.replaceAll('_', '-')}`
}

function section(title: string): HTMLElement {
  const value = element('section', 'bb-video-section')
  value.append(text('h2', title))
  return value
}

function list(items: readonly HTMLElement[], emptyText: string): HTMLElement {
  const value = element('ul', 'bb-video-list')
  if (!items.length) value.append(text('li', emptyText, 'bb-video-empty'))
  else for (const item of items) value.append(item)
  return value
}

function selectableRow(
  row: HTMLElement,
  selected: boolean,
  onSelect: () => void,
): HTMLElement {
  row.classList.toggle('is-selected', selected)
  row.tabIndex = 0
  row.setAttribute('role', 'button')
  row.setAttribute('aria-pressed', selected ? 'true' : 'false')
  row.addEventListener('click', onSelect)
  row.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect()
  })
  return row
}

function toggleButton(label: string, selected: boolean, onToggle: () => void): HTMLButtonElement {
  const button = element('button', `bb-video-selection ${selected ? 'is-selected' : ''}`)
  button.type = 'button'
  button.textContent = label
  button.setAttribute('aria-pressed', selected ? 'true' : 'false')
  button.addEventListener('click', event => {
    event.stopPropagation()
    onToggle()
  })
  return button
}

function timelineLane(
  model: VideoWorkbenchViewModel,
  track: VideoWorkbenchViewModel['editorial']['tracks'][number],
  callbacks: VideoWorkbenchSurfaceCallbacks,
): HTMLElement {
  const row = element('div', 'bb-video-timeline-row')
  const label = element('div', 'bb-video-timeline-track-label')
  label.append(
    text('strong', videoMediaKindLabel(track.kind)),
    text('span', track.locked ? '已锁定' : track.muted ? '已静音' : `${track.item_count} 个条目`),
  )
  const lane = element('div', 'bb-video-timeline-lane')
  lane.setAttribute('role', 'list')
  for (const item of model.editorial.items.filter(candidate => candidate.track_id === track.id)) {
    const bar = element('button', `bb-video-timeline-item ${item.selected ? 'is-selected' : ''} ${item.locked || track.locked ? 'is-locked' : ''}`)
    bar.type = 'button'
    bar.style.left = `${item.timeline_left_percent}%`
    bar.style.width = `${item.timeline_width_percent}%`
    bar.title = [
      videoMediaKindLabel(item.kind),
      item.source_name ?? item.source_id ?? '项目素材',
      item.timeline_range,
      item.source_range ? `素材 ${item.source_range}` : undefined,
      item.linked_item_ids.length > 1 ? '已关联 A/V' : undefined,
      item.locked || track.locked ? '已锁定' : undefined,
    ].filter(Boolean).join(' · ')
    bar.setAttribute('aria-label', bar.title)
    bar.setAttribute('aria-pressed', item.selected ? 'true' : 'false')
    bar.setAttribute('role', 'listitem')
    bar.append(text('span', videoMediaKindLabel(item.kind)), text('small', item.source_name ?? item.source_id ?? '素材'))
    bar.addEventListener('click', event => {
      event.stopPropagation()
      callbacks.onToggleTimelineItem(item.id)
    })
    lane.append(bar)
  }
  if (!track.item_count) lane.append(text('span', '暂无条目', 'bb-video-timeline-empty'))
  row.append(label, lane)
  return row
}

function previewPlayer(model: VideoWorkbenchViewModel): HTMLElement | undefined {
  const preview = model.review_delivery.preview_asset
  if (!preview) return undefined
  const sectionNode = section('当前预览')
  const video = element('video', 'bb-video-preview')
  video.controls = true
  video.preload = 'metadata'
  video.setAttribute('aria-label', '当前视频预览')
  video.src = preview.asset_path
  const status = text('p', `预览内容校验：${preview.content_hash}`, 'bb-video-summary bb-video-preview-status')
  video.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(video.duration) ? `${video.duration.toFixed(1)} 秒` : '时长待读取'
    status.textContent = `预览已加载 · ${duration} · 内容校验：${preview.content_hash}`
  })
  video.addEventListener('error', () => {
    status.textContent = '预览加载失败；请刷新工作台后重试，正式输出状态不受影响。'
    status.classList.add('is-failed')
  })
  sectionNode.append(video, status)
  return sectionNode
}

function journeyCard(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const card = element('div', `bb-video-journey ${model.journey.completed ? 'is-complete' : ''}`)
  card.append(text('h3', '下一步'))
  card.append(text('p', model.journey.title, 'bb-video-journey-title'))
  card.append(text('p', model.journey.description, 'bb-video-summary'))
  const steps = element('ol', 'bb-video-journey-steps')
  for (const step of model.journey.steps) {
    const item = element('li', `bb-video-journey-step ${stateClass(step.state)}`)
    item.append(text('span', step.label))
    steps.append(item)
  }
  card.append(steps)
  const action = model.journey.action
  if (action) {
    const controls = element('div', 'bb-video-actions')
    if (action.action) {
      controls.append(actionButton(action.label, action.action, action.availability, callbacks, action.target_id))
    } else {
      controls.append(commandButton(action.label, action.availability, () => callbacks.onPanel(action.panel)))
    }
    card.append(controls)
  }
  return card
}

function projectHome(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('项目')
  sectionNode.append(journeyCard(model, callbacks))
  const metrics = element('dl', 'bb-video-metrics')
  const values: [string, string][] = [
    ['素材', String(model.project_home.source_count)],
    ['交付变体', String(model.project_home.variant_count)],
    ['操作', String(model.project_home.operation_count)],
  ]
  if (model.project_home.missing_source_count) values.push(['待重新关联', String(model.project_home.missing_source_count)])
  for (const [label, value] of values) {
    metrics.append(text('dt', label), text('dd', value))
  }
  sectionNode.append(metrics)
  if (model.project_home.creation_brief) {
    const brief = section('已确认的剪辑目标')
    brief.classList.add('bb-video-subsection')
    brief.append(
      text('p', briefText(model.project_home.creation_brief.user_request), 'bb-video-summary'),
      text('p', `${model.project_home.creation_brief.use_case} · ${model.project_home.creation_brief.distribution} · ${model.project_home.creation_brief.pace} · 面向${model.project_home.creation_brief.audience}`, 'bb-video-summary'),
      text('p', `叙事：${model.project_home.creation_brief.story_structure}；取材重点：${model.project_home.creation_brief.selection_focus}；开场：${model.project_home.creation_brief.hook_strategy}`, 'bb-video-summary'),
      text('p', `字幕：${model.project_home.creation_brief.caption_preference}；语气：${model.project_home.creation_brief.tone}`, 'bb-video-summary'),
      text('p', `创作方向：${model.project_home.creation_brief.creative_direction.narrative_voice} · ${model.project_home.creation_brief.creative_direction.emotional_arc}；声音：${model.project_home.creation_brief.creative_direction.audio_mode}；字幕节奏：${model.project_home.creation_brief.creative_direction.caption_strategy}`, 'bb-video-summary'),
    )
    if (model.project_home.creation_brief.must_preserve.length) {
      brief.append(text('p', `必须保留：${model.project_home.creation_brief.must_preserve.join('、')}`, 'bb-video-summary'))
    }
    sectionNode.append(brief)
  }
  const controls = element('div', 'bb-video-actions')
  controls.append(actionButton('切换项目', 'switch_project', { enabled: true }, callbacks))
  controls.append(actionButton('刷新', 'refresh', { enabled: true }, callbacks))
  controls.append(actionButton('导入素材', 'choose_sources', model.project_home.can_import_sources, callbacks))
  sectionNode.append(controls)
  if (model.project_home.recovery_required) sectionNode.append(text('p', '需要重新读取操作记录后再继续。', 'bb-video-notice'))
  return sectionNode
}

function importScope(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('导入与分析范围')
  sectionNode.append(list(model.import_scope.sources.map(source => {
    const row = element('li', `bb-video-row ${stateClass(source.state)}`)
    row.append(text('strong', source.name), text('span', source.duration), text('span', source.state))
    return selectableRow(row, source.selected, () => callbacks.onSelection({ source_id: source.id }))
  }), '尚未导入素材。'))
  const budget = section('预算')
  budget.classList.add('bb-video-subsection')
  if (model.import_scope.active_budget) {
    const estimate = model.import_scope.active_budget
    budget.append(text('p', `预留 ${estimate.estimated_amount_micros} 微单位，${estimate.requests} 次请求。`))
  }
  budget.append(actionButton('估算预算', 'estimate_budget', model.import_scope.estimate_budget, callbacks))
  budget.append(actionButton('确认范围与预算', 'confirm_budget', model.import_scope.confirm_budget, callbacks))
  sectionNode.append(budget)
  if (model.import_scope.uncovered.length) {
    const uncovered = section('未覆盖范围')
    uncovered.classList.add('bb-video-subsection')
    uncovered.append(list(model.import_scope.uncovered.map(item => text('li', `${item.range} ${item.reason}`)), ''))
    sectionNode.append(uncovered)
  }
  return sectionNode
}

function materialBrowser(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('素材与事实')
  const filters = element('div', 'bb-video-actions')
  const kind = element('select', 'bb-video-select')
  kind.setAttribute('aria-label', '事实类型')
  for (const value of VIDEO_WORKBENCH_FACT_KINDS) {
    const option = element('option')
    option.value = value
    option.textContent = value
    option.selected = value === model.material_browser.fact_kind
    kind.append(option)
  }
  const source = element('select', 'bb-video-select')
  source.setAttribute('aria-label', '素材来源')
  const allSources = element('option')
  allSources.value = ''
  allSources.textContent = '全部素材'
  allSources.selected = !model.material_browser.source_id
  source.append(allSources)
  for (const item of model.material_browser.source_options) {
    const option = element('option')
    option.value = item.id
    option.textContent = item.name
    option.selected = item.id === model.material_browser.source_id
    source.append(option)
  }
  filters.append(
    kind,
    source,
    commandButton('读取事实', model.material_browser.read_facts, () => callbacks.onLoadFacts(kind.value as VideoWorkbenchFactKind, source.value || undefined)),
    commandButton('下一页', model.material_browser.load_more_facts, () => callbacks.onLoadMoreFacts()),
  )
  sectionNode.append(filters)
  sectionNode.append(list(model.material_browser.facts.map(fact => {
    const row = element('li', `bb-video-row ${stateClass(fact.state)}`)
    row.append(
      text('strong', videoMediaKindLabel(fact.kind)),
      text('span', fact.source_name ?? fact.source_id ?? '未关联素材'),
      ...(fact.segment_id ? [text('span', `片段 ${fact.segment_id}`)] : []),
      text('span', fact.range ?? '无时间范围'),
      text('span', fact.coverage_state ?? fact.state),
    )
    return selectableRow(row, fact.selected, () => callbacks.onSelection({ fact_id: fact.id }))
  }), '尚无可展示的素材事实。'))
  const searchControls = element('form', 'bb-video-actions')
  const query = element('input', 'bb-video-search')
  query.type = 'search'
  query.maxLength = 1_000
  query.placeholder = '检索转写与素材事实'
  query.value = model.material_browser.search_query ?? ''
  query.setAttribute('aria-label', '检索素材事实')
  searchControls.addEventListener('submit', event => {
    event.preventDefault()
    callbacks.onSearchFacts(query.value)
  })
  searchControls.append(
    query,
    commandButton('检索', model.material_browser.search, () => callbacks.onSearchFacts(query.value)),
    commandButton('更多结果', model.material_browser.load_more_search, () => callbacks.onLoadMoreFactSearch()),
  )
  sectionNode.append(searchControls)
  const searchSummary = model.material_browser.search_generation === undefined
    ? `搜索结果 ${model.material_browser.search_count} 项。`
    : `索引 generation ${model.material_browser.search_generation}，搜索结果 ${model.material_browser.search_count} 项。`
  sectionNode.append(text('p', searchSummary, 'bb-video-summary'))
  sectionNode.append(list(model.material_browser.search_results.map(result => {
    const row = element('li', 'bb-video-row')
    row.append(
      text('strong', videoMediaKindLabel(result.kind)),
      text('span', result.source_name ?? result.source_id),
      ...(result.segment_id ? [text('span', `片段 ${result.segment_id}`)] : []),
      text('span', result.range),
      text('span', result.text),
    )
    return selectableRow(row, result.selected, () => callbacks.onSelection({ fact_id: result.id }))
  }), '尚无检索结果。'))
  if (model.material_browser.uncovered_count) sectionNode.append(text('p', `仍有 ${model.material_browser.uncovered_count} 个范围未覆盖。`, 'bb-video-notice'))
  return sectionNode
}

function quickCreate(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('生成方案')
  sectionNode.append(text('p', 'AI 只提出候选方案，不会直接改写正式时间线；先比较理由，再确认要采用的条目。', 'bb-video-summary'))
  if (model.quick_create.interpreted_goal) {
    sectionNode.append(text('p', `当前理解：${model.quick_create.interpreted_goal}`, 'bb-video-summary'))
  }
  const planningSourceLabel = model.quick_create.planning_source === 'provider'
    ? '模型规划'
    : model.quick_create.planning_source === 'local_conservative'
      ? '本地保守回退'
      : model.quick_create.planning_source === 'mixed' ? '模型与本地方案混合' : '来源待确认'
  sectionNode.append(text('p', `建议来源：${planningSourceLabel}。无论来源是什么，都必须经过你的确认才会写入正式时间线。`, 'bb-video-summary'))
  if (model.quick_create.clarifications.length) {
    const clarification = section('需要你确认')
    clarification.classList.add('bb-video-subsection')
    clarification.append(list(model.quick_create.clarifications.map(item => text('li', item, 'bb-video-notice')), '暂无待确认问题。'))
    sectionNode.append(clarification)
  }
  if (model.quick_create.rationale.length) {
    const rationale = section('编排依据')
    rationale.classList.add('bb-video-subsection')
    rationale.append(list(model.quick_create.rationale.map(item => text('li', item, 'bb-video-summary')), '暂无编排依据。'))
    sectionNode.append(rationale)
  }
  if (model.quick_create.suggestions.length) {
    const suggestions = section('AI 建议')
    suggestions.classList.add('bb-video-subsection')
    suggestions.append(list(model.quick_create.suggestions.map(suggestion => {
      const row = element('li', `bb-video-row ${suggestion.selected ? 'is-selected' : ''}`)
      row.append(
        text('strong', suggestion.label),
        text('span', suggestion.estimated_duration ? `预计 ${suggestion.estimated_duration}` : '预计时长待确认'),
        text('span', `纳入 ${suggestion.included_count} 段`),
        text('span', suggestion.omission_count
          ? `取舍 ${suggestion.omission_count} 项${suggestion.omission_reasons.length ? `：${suggestion.omission_reasons[0]}` : ''}`
          : '无已知取舍'),
        text('p', suggestion.explanation, 'bb-video-summary bb-video-suggestion-explanation'),
      )
      return selectableRow(row, suggestion.selected, () => callbacks.onSelection(videoDraftSelection(model, suggestion.draft_id)))
    }), '尚无可解释的建议。'))
    sectionNode.append(suggestions)
  }
  if (model.quick_create.drafts.length) {
    sectionNode.append(text('p', '确认条目（默认全选；你可以逐项取消，再写入正式时间线）。', 'bb-video-summary'))
  }
  sectionNode.append(list(model.quick_create.drafts.map((draft, draftIndex) => {
    const suggestion = model.quick_create.suggestions.find(candidate => candidate.draft_id === draft.id)
    const row = element('li', `bb-video-row ${stateClass(draft.status)}`)
    row.append(text('strong', suggestion?.label ?? `方案 ${draftIndex + 1}`), text('span', `${draft.item_count} 个候选条目`), text('span', draft.partially_acceptable ? '可局部采用' : '需要重新生成'))
    const itemControls = element('div', 'bb-video-selection-list')
    for (const [itemIndex, item] of draft.items.entries()) {
      const location = [item.source_name, item.range].filter(Boolean).join(' · ')
      itemControls.append(toggleButton(`${videoMediaKindLabel(item.kind)} ${itemIndex + 1}${location ? ` · ${location}` : ''}`, item.selected, () => callbacks.onToggleDraftItem(draft.id, item.id)))
    }
    row.append(itemControls)
    return selectableRow(row, draft.selected, () => callbacks.onSelection(videoDraftSelection(model, draft.id)))
  }), '尚无草稿。'))
  sectionNode.append(actionButton('生成建议草稿', 'create_quick_draft', model.quick_create.can_create_draft, callbacks))
  sectionNode.append(actionButton('确认并写入时间线', 'accept_draft', model.quick_create.can_accept_selection, callbacks))
  return sectionNode
}

function editorial(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('时间线')
  const trackLabels = new Map(model.editorial.tracks.map((track, index) => [track.id, `${videoMediaKindLabel(track.kind)}轨道 ${index + 1}`]))
  if (model.editorial.timeline_id) sectionNode.append(text('p', '当前时间线已加载，可继续用 CommandSet 编辑。', 'bb-video-summary'))
  sectionNode.append(text('p', model.editorial.timeline_duration_ms > 0
    ? `总时长 ${model.editorial.timeline_duration_ms >= 60_000 ? `${Math.floor(model.editorial.timeline_duration_ms / 60_000)} 分 ${((model.editorial.timeline_duration_ms % 60_000) / 1000).toFixed(1)} 秒` : `${(model.editorial.timeline_duration_ms / 1000).toFixed(1)} 秒`}；点击条目可选择，条带位置代表它在时间线中的相对位置。`
    : '时间线尚无可定位的条目。', 'bb-video-summary'))
  if (model.editorial.tracks.length) {
    const timeline = element('div', 'bb-video-timeline')
    timeline.setAttribute('aria-label', '时间线轨道')
    for (const track of model.editorial.tracks) timeline.append(timelineLane(model, track, callbacks))
    sectionNode.append(timeline)
  }
  sectionNode.append(list(model.editorial.tracks.map(track => {
    const row = element('li', `bb-video-row ${track.locked ? 'is-locked' : ''}`)
    row.append(text('strong', trackLabels.get(track.id) ?? videoMediaKindLabel(track.kind)), text('span', `${track.item_count} 个条目`), text('span', track.locked ? '已锁定' : track.muted ? '已静音' : '可编辑'))
    return row
  }), '尚无编辑时间线。'))
  sectionNode.append(list(model.editorial.items.map(item => {
    const row = element('li', `bb-video-row ${item.locked ? 'is-locked' : ''}`)
    row.append(
      text('strong', videoMediaKindLabel(item.kind)),
      text('span', [item.source_name ?? item.source_id ?? '项目素材', trackLabels.get(item.track_id) ?? '未关联轨道'].join(' · ')),
      text('span', `${item.timeline_range}${item.source_range ? ` · 素材 ${item.source_range}` : ''}`),
      text('span', item.linked_item_ids.length > 1 ? '已关联 A/V' : item.locked ? '已锁定' : '可编辑'),
    )
    return selectableRow(row, item.selected, () => callbacks.onToggleTimelineItem(item.id))
  }), '尚无可选择的时间线条目。'))
  sectionNode.append(actionButton('编辑 CommandSet', 'open_editor', model.editorial.command_set, callbacks))
  return sectionNode
}

function finishing(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('字幕、声音与画面')
  const audio = element('div', 'bb-video-subsection')
  audio.append(text('h3', '声音编排'))
  audio.append(text('p', `当前输出：${model.finishing.audio_policy}；项目资产中有 ${model.finishing.music_asset_count} 个音乐、${model.finishing.voiceover_asset_count} 个旁白。`, 'bb-video-summary'))
  audio.append(text('p', model.finishing.voiceover_ready
    ? '当前时间线已有旁白音轨，可以在交付 CommandSet 中选择原声、音乐和旁白的组合。'
    : '旁白需要先作为已确认的 voice_over 项目资产插入时间线；当前版本不伪造 TTS 音色，创作方向里的“旁白人格”只影响叙事建议。', 'bb-video-summary'))
  sectionNode.append(audio)
  sectionNode.append(list(model.finishing.variants.map(variant => {
    const row = element('li', `bb-video-row ${stateClass(variant.preflight)}`)
    row.append(text('strong', variant.name), text('span', variant.caption_mode), text('span', variant.preflight))
    return selectableRow(row, variant.selected, () => callbacks.onSelection({ variant_id: variant.id }))
  }), '尚无交付变体。'))
  const controls = element('div', 'bb-video-actions')
  controls.append(actionButton('新建变体', 'create_variant', model.finishing.can_create_variant, callbacks))
  controls.append(actionButton('编辑交付 CommandSet', 'open_variant_editor', model.finishing.can_apply_variant_commands, callbacks))
  controls.append(actionButton('生成字幕', 'create_caption', model.finishing.can_create_caption, callbacks))
  controls.append(actionButton('修订字幕', 'create_caption_revision', model.finishing.can_create_caption, callbacks))
  controls.append(actionButton('翻译字幕', 'create_caption_translation', model.finishing.can_translate_captions, callbacks))
  controls.append(actionButton('生成构图计划', 'create_composition_plan', model.finishing.can_create_caption, callbacks))
  controls.append(actionButton('跟踪主体', 'analyze_subject_track', model.finishing.can_track_subject, callbacks))
  controls.append(actionButton('生成音频计划', 'create_audio_finishing_plan', model.finishing.can_create_caption, callbacks))
  controls.append(actionButton('分析节拍', 'analyze_beat', model.finishing.can_analyze_beat, callbacks))
  controls.append(actionButton('创建节拍草稿', 'create_beat_sync_draft', model.finishing.can_create_beat_sync_draft, callbacks))
  sectionNode.append(controls)
  return sectionNode
}

function reviewDelivery(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('预览与导出')
  const player = previewPlayer(model)
  if (player) sectionNode.append(player)
  const reviews = section('版本化反馈')
  reviews.classList.add('bb-video-subsection')
  reviews.append(list(model.review_delivery.review_notes.map(note => {
    const row = element('li', `bb-video-row ${stateClass(note.status)}`)
    row.append(text('strong', note.status), text('span', note.actor_id), text('span', note.body))
    row.append(actionButton('处理反馈', 'resolve_review_note', note.resolve, callbacks, note.id))
    return selectableRow(row, note.selected, () => callbacks.onSelection({ review_note_id: note.id }))
  }), '当前版本尚无 Review Note。'))
  const reviewControls = element('div', 'bb-video-actions')
  reviewControls.append(actionButton('新增反馈', 'create_review_note', model.review_delivery.create_review_note, callbacks))
  reviewControls.append(actionButton('提交审批决定', 'create_approval_decision', model.review_delivery.create_approval_decision, callbacks))
  reviews.append(reviewControls)
  sectionNode.append(reviews)
  if (model.review_delivery.approval_decisions.length) {
    sectionNode.append(list(model.review_delivery.approval_decisions.map(decision =>
      text('li', `${decision.state} · ${decision.actor_id} · ${decision.note_count} 条反馈`),
    ), ''))
  }
  sectionNode.append(list(model.review_delivery.quality_reports.map(report => {
    const row = element('li', `bb-video-row ${stateClass(report.state)}`)
    row.append(text('strong', report.kind), text('span', report.state), text('span', `${report.check_count} 项检查`))
    return selectableRow(row, report.selected, () => callbacks.onSelection({ quality_report_id: report.id }))
  }), '尚无质量报告。'))
  if (model.review_delivery.pending_quality_confirmations.length) {
    const pending = section('待人工确认的质量告警')
    pending.classList.add('bb-video-subsection')
    for (const confirmation of model.review_delivery.pending_quality_confirmations) {
      const warningList = list(confirmation.checks.map(check => text('li', `${check.code}: ${check.message}`)), '')
      pending.append(text('p', `导出操作 ${confirmation.operation_id} 正在等待确认。`, 'bb-video-notice'), warningList)
      pending.append(actionButton('确认全部告警并发布', 'confirm_post_render_quality', confirmation.confirm, callbacks, confirmation.operation_id))
    }
    sectionNode.append(pending)
  }
  sectionNode.append(text('p', model.review_delivery.output_verification.detail ?? '尚无输出验证。', `bb-video-summary ${stateClass(model.review_delivery.output_verification.state)}`))
  const controls = element('div', 'bb-video-actions')
  controls.append(actionButton('预检', 'preflight', model.review_delivery.preflight, callbacks))
  controls.append(actionButton('预览', 'preview', model.review_delivery.preview, callbacks))
  controls.append(actionButton('渲染', 'render', model.review_delivery.render, callbacks))
  sectionNode.append(controls)
  return sectionNode
}

function operationCenter(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  const sectionNode = section('后台任务')
  sectionNode.append(text('p', `事件游标 ${model.operation_center.event_cursor}`, 'bb-video-summary'))
  sectionNode.append(actionButton('续读操作', 'poll_operations', model.operation_center.poll_operations, callbacks))
  if (model.operation_center.reset_required) sectionNode.append(text('p', '事件游标不可续读，必须重新加载项目快照。', 'bb-video-notice'))
  sectionNode.append(list(model.operation_center.operations.map(operation => {
    const row = element('li', `bb-video-operation ${stateClass(operation.status)}`)
    row.title = operation.kind
    row.append(
      text('strong', operation.label),
      text('span', operation.detail),
      text('span', operation.status_label),
      text('span', `${operation.progress}%`),
      ...(operation.total_units ? [text('span', `阶段 ${operation.completed_units ?? 0}/${operation.total_units}`)] : []),
      ...(operation.next_action ? [text('span', {
        wait_for_analysis: '等待后台分析',
        review_suggestions: '等待你查看建议',
        accept_draft: '等待你确认方案',
        retry_analysis: '可重新分析',
        refresh_project: '先刷新项目状态',
      }[operation.next_action])] : []),
    )
    const controls = element('div', 'bb-video-actions')
    controls.append(actionButton('取消', 'cancel_operation', { enabled: operation.can_cancel }, callbacks, operation.id))
    const canRetryAnalysis = operation.can_retry && (operation.kind === 'video.analyze' || operation.kind === 'video.plan')
    if (canRetryAnalysis) controls.append(actionButton('重新生成建议', 'retry_analysis', { enabled: true }, callbacks, operation.id))
    else if (operation.outcome_unknown) controls.append(text('span', '结果未知，需先对账。', 'bb-video-notice'))
    else if (operation.can_retry) controls.append(text('span', '该操作暂不支持直接重试。', 'bb-video-notice'))
    row.append(controls)
    return selectableRow(row, operation.selected, () => callbacks.onSelection({ operation_id: operation.id }))
  }), '没有操作记录。'))
  return sectionNode
}

function content(model: VideoWorkbenchViewModel, callbacks: VideoWorkbenchSurfaceCallbacks): HTMLElement {
  switch (model.active_panel) {
    case 'project_home': return projectHome(model, callbacks)
    case 'import_scope': return importScope(model, callbacks)
    case 'material_browser': return materialBrowser(model, callbacks)
    case 'quick_create': return quickCreate(model, callbacks)
    case 'editorial': return editorial(model, callbacks)
    case 'finishing': return finishing(model, callbacks)
    case 'review_delivery': return reviewDelivery(model, callbacks)
    case 'operation_center': return operationCenter(model, callbacks)
  }
}

export type VideoWorkbenchProjectPickerModel = Readonly<{
  projects: readonly VideoWorkbenchProjectProjection[]
  selected_project_id?: string
  loading: boolean
  error_message?: string
}>

export type VideoWorkbenchProjectPickerCallbacks = Readonly<{
  onSelectProject(projectId: string): void
  onCreateProject(): void
  onRefreshProjects(): void
}>

/**
 * Project selection intentionally lives outside the eight workspace panels.
 * It receives only public project projections and delegates creation to an
 * injected structured-input provider; it never gathers workspace paths here.
 */
export function renderVideoWorkbenchProjectPicker(
  root: HTMLElement,
  model: VideoWorkbenchProjectPickerModel,
  callbacks: VideoWorkbenchProjectPickerCallbacks,
): void {
  installVideoWorkbenchStyles(root.ownerDocument)
  const shell = element('div', 'bb-video-workbench bb-video-project-picker')
  shell.dataset.videoWorkbench = 'true'
  const main = element('main', 'bb-video-main')
  const header = element('header', 'bb-video-header')
  header.append(text('h1', '视频工作台'), text('p', model.loading ? '正在读取项目列表' : '选择一个视频项目，或创建新项目。', 'bb-video-status'))
  main.append(header)
  if (model.error_message) main.append(text('p', model.error_message, 'bb-video-notice'))
  const controls = element('div', 'bb-video-actions')
  controls.append(actionButton('新建视频项目', 'create_project', { enabled: !model.loading }, {
    onPanel: () => undefined,
    onAction: () => callbacks.onCreateProject(),
    onSelection: () => undefined,
    onToggleDraftItem: () => undefined,
    onToggleTimelineItem: () => undefined,
    onLoadFacts: () => undefined,
    onLoadMoreFacts: () => undefined,
    onSearchFacts: () => undefined,
    onLoadMoreFactSearch: () => undefined,
  }))
  controls.append(actionButton('刷新项目列表', 'refresh', { enabled: !model.loading }, {
    onPanel: () => undefined,
    onAction: () => callbacks.onRefreshProjects(),
    onSelection: () => undefined,
    onToggleDraftItem: () => undefined,
    onToggleTimelineItem: () => undefined,
    onLoadFacts: () => undefined,
    onLoadMoreFacts: () => undefined,
    onSearchFacts: () => undefined,
    onLoadMoreFactSearch: () => undefined,
  }))
  main.append(controls)
  main.append(list(model.projects.map(project => {
    const row = element('li', `bb-video-row ${stateClass(project.state)}`)
    row.append(text('strong', project.title), text('span', `${project.sources.length} 个素材`), text('span', project.state))
    return selectableRow(row, model.selected_project_id === project.id, () => callbacks.onSelectProject(project.id))
  }), model.loading ? '正在读取项目。' : '尚无视频项目。'))
  shell.append(main)
  root.replaceChildren(shell)
}

/**
 * Pure DOM surface. It can be mounted by a future Renderer entrypoint but
 * owns no IPC, network access, process lifecycle, or persistent project data.
 */
export function renderVideoWorkbenchSurface(
  root: HTMLElement,
  model: VideoWorkbenchViewModel,
  callbacks: VideoWorkbenchSurfaceCallbacks,
): void {
  installVideoWorkbenchStyles(root.ownerDocument)
  const shell = element('div', `bb-video-workbench ${stateClass(model.phase)}`)
  shell.dataset.videoWorkbench = 'true'
  const nav = element('nav', 'bb-video-nav')
  nav.setAttribute('aria-label', '视频工作台')
  for (const panel of model.panels) {
    const button = element('button', `bb-video-nav-item ${panel.id === model.active_panel ? 'is-active' : ''} ${stateClass(panel.state)}`)
    button.type = 'button'
    button.textContent = panel.count === undefined ? panel.label : `${panel.label} ${panel.count}`
    button.setAttribute('aria-current', panel.id === model.active_panel ? 'page' : 'false')
    button.addEventListener('click', () => callbacks.onPanel(panel.id))
    nav.append(button)
  }
  const main = element('main', 'bb-video-main')
  const header = element('header', 'bb-video-header')
  header.append(text('h1', model.title), text('p', model.status_message, `bb-video-status ${stateClass(model.phase)}`))
  main.append(header)
  if (model.failure_recovery) {
    const recovery = element('div', 'bb-video-recovery')
    recovery.append(text('span', model.failure_recovery.code, 'bb-video-recovery-code'))
    recovery.append(actionButton(model.failure_recovery.label, model.failure_recovery.action, { enabled: !model.action_pending }, callbacks))
    main.append(recovery)
  }
  main.append(content(model, callbacks))
  shell.append(nav, main)
  if (model.action_pending) {
    for (const button of shell.querySelectorAll<HTMLButtonElement>('[data-video-action]')) {
      button.disabled = true
      button.title = '当前操作仍在提交或等待服务端确认。'
    }
  }
  root.replaceChildren(shell)
}
