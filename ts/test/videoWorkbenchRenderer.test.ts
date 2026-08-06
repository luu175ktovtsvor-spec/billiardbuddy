import { expect, test } from 'bun:test'
import {
  VideoWorkbenchController,
  VideoWorkbenchProductController,
  buildDeliveryVariantCommandRequest,
  buildPartialDraftAcceptance,
  createProjectForm,
  createProjectInput,
  createVideoWorkbenchActionForm,
  createVideoWorkbenchActionInput,
  createVideoWorkbenchUiState,
  createVideoWorkbenchViewModel,
  reduceVideoWorkbenchUiState,
  videoDraftSelection,
  type VideoWorkbenchBridge,
  type VideoWorkbenchProjectCreateInput,
  type VideoWorkbenchSnapshot,
} from '../desktop/src/videoWorkbench/index.js'

type RetryOperationIsExposed = 'retryOperation' extends keyof VideoWorkbenchBridge ? true : false
const retryOperationIsExposed: RetryOperationIsExposed = false
type RendererCanSendWorkspaceRoot = 'workspace_root' extends keyof VideoWorkbenchProjectCreateInput ? true : false
const rendererCanSendWorkspaceRoot: RendererCanSendWorkspaceRoot = false

const at = '2026-08-05T00:00:00.000Z'
const hash = `sha256:${'a'.repeat(64)}`
const time = (ticks: string) => ({ ticks, tick_rate: { num: 1_000, den: 1 } })
const range = { start: time('0'), duration: time('10000') }

function task(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    id: 'task_00000001',
    project_id: 'video_00000001',
    kind: 'video.render',
    status: 'running',
    status_sequence: 1,
    progress: 20,
    stage: '正在渲染',
    created_at: at,
    updated_at: at,
    ...overrides,
  }
}

function workspace(options: { lockedTrack?: boolean; preflight?: 'passed' | 'blocked' | 'needs_user_decision'; outputVerified?: boolean; revision?: number; pendingQuality?: boolean; reviewNote?: boolean; preview?: boolean; sourceAvailability?: 'ready' | 'missing' | 'changed' } = {}): VideoWorkbenchSnapshot {
  const track = { id: 'track_00000001', kind: 'primary_video', order: 0, locked: options.lockedTrack ?? false, muted: false }
  const item = {
    id: 'item_00000001',
    track_id: track.id,
    kind: 'video',
    timeline_range: range,
    binding: { kind: 'source', source_id: 'source_00000001', source_fingerprint: hash, source_range: range },
    linked_camera_shot_ids: [],
    linked_content_segment_ids: [],
    locked: false,
    evidence_ids: [],
  }
  const draftItem = { ...item, id: 'item_00000002' }
  const profile = {
    id: 'profile_revision_00000001',
    profile_id: 'profile_00000001',
    revision: 1,
    target: 'vertical_short',
    width: 1080,
    height: 1920,
    frame_rate: { num: 30, den: 1 },
    encoding: {
      container: 'mp4',
      video: { codec: 'h264', quality: { mode: 'crf', value: 20, preset: 'medium' } },
      audio: { codec: 'aac_lc', sample_rate: 48_000, channels: 2 },
      output_color: { range: 'sdr_bt709', pixel_format: 'yuv420p' },
    },
    hdr_input_policy: 'tone_map_to_sdr',
    caption_mode: 'burn_in',
    audio_policy: 'source_only',
    content_hash: hash,
    created_at: at,
  }
  const variantVersion = {
    id: 'variant_version_00000001',
    variant_id: 'variant_00000001',
    editorial_timeline_version_id: 'timeline_00000001',
    export_profile_revision_id: profile.id,
    export_profile_hash: hash,
    item_overrides: [],
    created_by_command_set_id: 'command_00000001',
    created_at: at,
  }
  const preflight = options.preflight ? [{
    id: 'quality_00000001',
    project_id: 'video_00000001',
    kind: 'preflight',
    state: options.preflight,
    editorial_timeline_version_id: 'timeline_00000001',
    delivery_variant_version_id: variantVersion.id,
    export_profile_revision_id: profile.id,
    facts_basis_hash: hash,
    variant_basis_hash: hash,
    checks: [{ id: 'check_00000001', code: 'timeline', state: options.preflight === 'passed' ? 'passed' : 'blocked', severity: options.preflight === 'passed' ? 'info' : 'error', message: '预检结果' }],
    created_at: at,
  }] : []
  const verification = options.outputVerified === undefined ? undefined : {
    timeline_version_id: 'timeline_00000001',
    delivery_variant_version_id: variantVersion.id,
    execution_plan_id: 'plan_00000001',
    byte_size: 123,
    duration_ms: 10_000,
    video_stream_count: 1,
    audio_stream_count: 1,
    decoded: options.outputVerified,
    packet_timestamps_monotonic: options.outputVerified,
    duration_delta_ms: options.outputVerified ? 10 : undefined,
    audio_video_duration_delta_ms: options.outputVerified ? 10 : undefined,
    content_hash: hash,
    verified_at: at,
  }
  const postRender = options.pendingQuality ? {
    id: 'quality_00000002',
    project_id: 'video_00000001',
    kind: 'post_render',
    state: 'needs_user_decision',
    editorial_timeline_version_id: 'timeline_00000001',
    delivery_variant_version_id: variantVersion.id,
    export_profile_revision_id: profile.id,
    execution_plan_id: 'plan_00000001',
    facts_basis_hash: hash,
    variant_basis_hash: hash,
    checks: [{ id: 'check_00000002', code: 'visual_warning', state: 'needs_user_decision', severity: 'warning', message: '需要人工确认画面告警' }],
    created_at: at,
  } : undefined
  return {
    project: {
      id: 'video_00000001',
      kind: 'video',
      title: '测试项目',
      revision: options.revision ?? 1,
      state: 'ready',
      created_at: at,
      updated_at: at,
      sources: [{ id: 'source_00000001', name: 'fixture.mp4', duration_ms: 10_000, width: 1920, height: 1080, has_audio: true, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: options.sourceAvailability === 'missing', content_changed: options.sourceAvailability === 'changed' }],
      project_assets: [],
      timeline: [],
      output: { width: 1080, height: 1920, fps: 30 },
      evidence: [],
      timeline_versions: [],
      alternatives: [],
      remote_analysis_consents: [],
      remote_analysis_budgets: [],
      editorial_timeline_versions: [],
      timeline_drafts: [],
      delivery_variants: [{ id: 'variant_00000001', project_id: 'video_00000001', name: '竖版', current_version_id: variantVersion.id, created_at: at }],
      delivery_variant_versions: [],
      caption_styles: [],
      caption_documents: [],
      caption_document_revisions: [],
      composition_plans: [],
      audio_finishing_plans: [],
      quality_reports: [],
      review_notes: options.reviewNote ? [{
        id: 'review_note_00000001',
        project_id: 'video_00000001',
        timeline_version_id: 'timeline_00000001',
        anchor: { kind: 'timeline_range', editorial_timeline_version_id: 'timeline_00000001', range },
        body: '请在击球瞬间收紧画面。',
        status: 'open',
        actor_id: 'reviewer_0001',
        event_sequence: 1,
        created_at: at,
      }] : [],
      approval_decisions: [],
      export_profiles: [{ id: 'profile_00000001', scope: 'product_preset', current_revision_id: profile.id, created_at: at }],
      export_profile_revisions: [profile],
      execution_plans: [],
    },
    current_timeline: {
      schema_version: 2,
      id: 'timeline_00000001',
      project_revision: 1,
      source_fingerprint_set_hash: hash,
      facts_basis_hash: hash,
      tick_rate: { num: 1_000, den: 1 },
      tracks: [track],
      items: [item],
      created_by_command_set_id: 'command_00000001',
      created_at: at,
    },
    timeline_drafts: [{
      id: 'draft_00000001',
      project_id: 'video_00000001',
      facts_basis_hash: hash,
      base_timeline_version_id: 'timeline_00000001',
      planning_origin: 'local_conservative',
      plan_ids: [],
      tracks: [track],
      items: [draftItem],
      status: 'proposed',
      created_at: at,
    }],
    variants: [{ variant: { id: 'variant_00000001', project_id: 'video_00000001', name: '竖版', current_version_id: variantVersion.id, created_at: at }, version: variantVersion }],
    facts: {
      schema_version: 1,
      items: [{ id: 'fact_00000001', kind: 'evidence_window', source_id: 'source_00000001', range, state: 'ready', coverage: {
        generation: 1,
        request_budget: { max_windows: 1, max_visual_requests: 1, max_frames: 10, max_proxy_seconds: 10, max_input_tokens: 1_000, max_covered_ticks: '10000' },
        request_usage: { windows: 1, visual_requests: 1, frames: 10, proxy_seconds: 10, estimated_input_tokens: 800, covered_ticks: '9000' },
        uncovered: [{ range: { start: time('9000'), duration: time('1000') }, reason: 'max_frames' }],
      }, created_at: at }],
    },
    caption_documents: [],
    caption_revisions: [],
    composition_plans: [],
    audio_finishing_plans: [],
    execution_plans: [],
    quality_reports: [...preflight, ...(postRender ? [postRender] : [])],
    ...(verification ? { output_verification: verification } : {}),
    ...(options.preview ? { preview: {
      timeline_version_id: 'timeline_00000001',
      delivery_variant_version_id: variantVersion.id,
      execution_plan_id: 'plan_00000001',
      asset_id: 'preview_asset_00000001',
      asset_path: '/api/videos/projects/video_00000001/previews/preview_asset_00000001/content',
      content_hash: hash,
      created_at: at,
    } } : {}),
    operations: [options.pendingQuality ? task({
      status: 'committing',
      progress: 95,
      stage: '正在等待质量确认',
      result: {
        post_render_report_id: postRender!.id,
        output_content_hash: hash,
        awaiting_quality_confirmation: true,
      },
    }) : task()],
    events: { cursor: 4, next_cursor: 5, reset_required: false, events: [] },
  } as unknown as VideoWorkbenchSnapshot
}

test('局部接受草稿只生成当前 Editorial Timeline 的单一 CommandSet 写入', () => {
  expect(rendererCanSendWorkspaceRoot).toBeFalse()
  const snapshot = workspace()
  const request = buildPartialDraftAcceptance(snapshot, 'draft_00000001', ['item_00000002'])
  expect(request).toMatchObject({
    base_timeline_version_id: 'timeline_00000001',
    commands: [{ kind: 'insert', track_id: 'track_00000001', item: { id: 'item_00000002' } }],
  })
  expect(() => buildPartialDraftAcceptance(workspace({ lockedTrack: true }), 'draft_00000001', ['item_00000002'])).toThrow(/锁定/)
})

test('交付降噪命令在发送前校验冻结时间线中的目标条目', () => {
  const snapshot = workspace()
  expect(buildDeliveryVariantCommandRequest(snapshot, 'variant_00000001', [{
    kind: 'set_audio_denoise', item_id: 'item_00000001', noise_reduction_db: 6,
  }])).toMatchObject({
    base_variant_version_id: 'variant_version_00000001',
    commands: [{ kind: 'set_audio_denoise', item_id: 'item_00000001', noise_reduction_db: 6 }],
  })
  expect(() => buildDeliveryVariantCommandRequest(snapshot, 'variant_00000001', [{
    kind: 'set_audio_denoise', item_id: 'item_00000009', noise_reduction_db: 6,
  }])).toThrow(/交付条目已不存在/)
})

test('事件 cursor reset 不合并可能静默漏掉的 Operation，并要求权威刷新', () => {
  const snapshot = workspace()
  let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot })
  state = reduceVideoWorkbenchUiState(state, { type: 'operation_events', page: {
    cursor: 42,
    next_cursor: 43,
    reset_required: true,
    events: [{ schema_version: 1, cursor: 42, project_id: 'video_00000001', task_id: 'task_00000001', operation_id: 'task_00000001', status_sequence: 7, occurred_at: at, task: task({ status: 'succeeded', status_sequence: 7, progress: 100 }) }],
  } as never })
  expect(state.event_reset_required).toBeTrue()
  expect(state.requires_authoritative_refresh).toBeTrue()
  expect(state.snapshot?.operations[0]).toMatchObject({ status: 'running', status_sequence: 1 })
  state = reduceVideoWorkbenchUiState(state, { type: 'hydrate', snapshot })
  expect(state.event_reset_required).toBeFalse()
  expect(state.requires_authoritative_refresh).toBeFalse()
})

test('正常事件分页从当前页末尾续读，不会跳到全局 head', async () => {
  const snapshot = workspace()
  snapshot.events = { cursor: 100, next_cursor: 101, reset_required: false, events: [] }
  const seenCursors: number[] = []
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    loadOperationEvents: async (_projectId: string, cursor: number) => {
      seenCursors.push(cursor)
      return {
        ok: true,
        value: {
          cursor: cursor + 100,
          next_cursor: cursor + 101,
          reset_required: false,
          events: [],
        },
      }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  await controller.pollOperationEvents()
  await controller.pollOperationEvents()
  expect(seenCursors).toEqual([100, 200])
})

test('预检和输出验证决定 Preview/Render 状态，不能由本地乐观状态绕过', () => {
  let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: workspace({ preflight: 'blocked', outputVerified: false }) })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  let view = createVideoWorkbenchViewModel(state)
  expect(view.review_delivery.preflight).toMatchObject({ enabled: true })
  expect(view.review_delivery.preview).toMatchObject({ enabled: false })
  expect(view.review_delivery.render).toMatchObject({ enabled: false })
  expect(view.review_delivery.output_verification.state).toBe('blocked')

  state = reduceVideoWorkbenchUiState(state, { type: 'hydrate', snapshot: workspace({ preflight: 'passed', outputVerified: true }) })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  view = createVideoWorkbenchViewModel(state)
  expect(view.review_delivery.preview).toMatchObject({ enabled: true })
  expect(view.review_delivery.render).toMatchObject({ enabled: true })
  expect(view.review_delivery.output_verification.state).toBe('passed')
  expect(JSON.stringify(view)).not.toContain('output_path')
})

test('已生成的预览通过安全资产路径投影给播放器，且不暴露本机输出路径', () => {
  let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: workspace({ preflight: 'passed', outputVerified: true, preview: true }) })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  const view = createVideoWorkbenchViewModel(state)
  expect(view.review_delivery.preview_asset).toEqual({
    asset_id: 'preview_asset_00000001',
    asset_path: '/api/videos/projects/video_00000001/previews/preview_asset_00000001/content',
    content_hash: hash,
  })
  expect(JSON.stringify(view)).not.toContain('output_path')
})

test('素材丢失或内容变化时不再向用户显示可生成建议的假可用按钮', () => {
  for (const sourceAvailability of ['missing', 'changed'] as const) {
    let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: workspace({ sourceAvailability }) })
    state = reduceVideoWorkbenchUiState(state, { type: 'set_panel', panel: 'quick_create' })
    expect(createVideoWorkbenchViewModel(state).quick_create.can_create_draft).toMatchObject({ enabled: false })
  }
})

test('远程结果未知时不暴露重试入口，避免重复付费调用', () => {
  const snapshot = workspace()
  snapshot.operations = [task({ kind: 'video.analyze', status: 'failed', outcome_unknown: true })] as never
  const state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot })
  const operation = createVideoWorkbenchViewModel(state).operation_center.operations[0]
  expect(operation).toMatchObject({ outcome_unknown: true, can_retry: false })
})

test('控制器经注入式桥接发送局部接受，随后只以重新读取的项目快照更新界面', async () => {
  const first = workspace({ revision: 1 })
  const second = workspace({ revision: 2 })
  const received: unknown[] = []
  let loads = 0
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: loads++ === 0 ? first : second }),
    loadOperationEvents: async () => ({ ok: true, value: first.events }),
    applyEditorialCommandSet: async (_projectId: string, command: unknown) => {
      received.push(command)
      return { ok: true, value: second.current_timeline }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  controller.dispatch({ type: 'select', selection: { timeline_draft_id: 'draft_00000001', draft_item_ids: ['item_00000002'] } })
  const result = await controller.acceptSelectedDraft('accept-draft-key-0001')
  expect(result.ok).toBeTrue()
  expect(received).toMatchObject([{ idempotency_key: 'accept-draft-key-0001', input: { commands: [{ kind: 'insert', item: { id: 'item_00000002' } }] } }])
  expect(controller.getState().snapshot?.project.revision).toBe(2)
  expect(controller.getState().requires_authoritative_refresh).toBeFalse()
})

test('完成层桥接保留字幕翻译、节拍和主体任务的真实 Operation 返回，并且不伪造重试端口', async () => {
  const snapshot = workspace()
  const calls: { name: string; command: unknown }[] = []
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    createQuickDraft: async (_projectId: string, command: unknown) => {
      calls.push({ name: 'quick_draft', command })
      return { ok: true, value: task({ kind: 'video.analyze' }) }
    },
    createCaptionTranslation: async (_projectId: string, _documentId: string, command: unknown) => {
      calls.push({ name: 'caption_translation', command })
      return { ok: true, value: { revision: {} as never, task: task({ kind: 'video.caption_translation' }) } }
    },
    analyzeBeat: async (_projectId: string, command: unknown) => {
      calls.push({ name: 'beat_analysis', command })
      return { ok: true, value: task({ kind: 'video.beat_analyze' }) }
    },
    createBeatSyncDraft: async (_projectId: string, command: unknown) => {
      calls.push({ name: 'beat_sync_draft', command })
      return { ok: true, value: { draft: snapshot.timeline_drafts[0], task: task({ kind: 'video.beat_sync_draft' }) } }
    },
    analyzeSubjectTrack: async (_projectId: string, command: unknown) => {
      calls.push({ name: 'subject_track', command })
      return { ok: true, value: { evidence: snapshot.facts.items[0], task: task({ kind: 'video.subject_track' }) } }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  await controller.createQuickDraft('quick-draft-key-0001', { base_revision: 1, user_goal: '生成竖版草稿' })
  await controller.createCaptionTranslation('caption-translation-key-0001', 'caption_document_00000001', {
    base_revision_id: 'caption_revision_00000001', editorial_timeline_version_id: 'timeline_00000001', language: 'en',
  })
  await controller.analyzeBeat('beat-analysis-key-0001', { source_id: 'source_00000001' })
  await controller.createBeatSyncDraft('beat-sync-key-0001', {
    source_id: 'source_00000001', beat_evidence_id: 'evidence_00000001', base_timeline_version_id: 'timeline_00000001',
  })
  await controller.analyzeSubjectTrack('subject-track-key-0001', {
    source_id: 'source_00000001', subject_id: 'subject_00000001',
  })

  expect(calls.map(call => call.name)).toEqual(['quick_draft', 'caption_translation', 'beat_analysis', 'beat_sync_draft', 'subject_track'])
  expect(calls.every(call => Boolean((call.command as { idempotency_key?: string }).idempotency_key))).toBeTrue()
  expect(retryOperationIsExposed).toBeFalse()
})

test('后渲染质量告警只在显式确认后发布，并且确认绑定当前报告、哈希和全部告警', async () => {
  const snapshot = workspace({ pendingQuality: true })
  const confirmations: unknown[] = []
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    confirmPostRenderQuality: async (_projectId: string, operationId: string, input: unknown) => {
      confirmations.push({ operationId, input })
      return { ok: true, value: { acknowledgement: {} as never, task: task({ status: 'succeeded' }), reused: false } }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  const view = createVideoWorkbenchViewModel(controller.getState())
  expect(view.review_delivery.pending_quality_confirmations).toMatchObject([{
    operation_id: 'task_00000001',
    report_id: 'quality_00000002',
    checks: [{ id: 'check_00000002', code: 'visual_warning' }],
    confirm: { enabled: true },
  }])
  expect(confirmations).toEqual([])

  await controller.confirmPostRenderQuality('quality-confirm-key-0001', 'task_00000001')
  expect(confirmations).toEqual([{
    operationId: 'task_00000001',
    input: {
      idempotency_key: 'quality-confirm-key-0001',
      input: {
        report_id: 'quality_00000002',
        output_content_hash: hash,
        accepted_check_ids: ['check_00000002'],
      },
    },
  }])
})

test('产品控制器要求注入式结构化输入，支持项目选择、新建和局部条目选择', async () => {
  const existing = workspace({ pendingQuality: true })
  const created = { ...existing.project, id: 'video_00000002', title: '新建项目', sources: [] }
  const calls: { name: string; value?: unknown }[] = []
  const bridge = {
    listProjects: async () => ({ ok: true, value: [existing.project] }),
    createProject: async (input: unknown) => {
      calls.push({ name: 'create_project', value: input })
      return { ok: true, value: created }
    },
    loadWorkspace: async (projectId: string) => ({ ok: true, value: projectId === created.id ? { ...workspace(), project: created } : existing }),
    confirmPostRenderQuality: async (_projectId: string, operationId: string, input: unknown) => {
      calls.push({ name: 'confirm_quality', value: { operationId, input } })
      return { ok: true, value: { acknowledgement: {} as never, task: task({ status: 'succeeded' }), reused: false } }
    },
  } as unknown as VideoWorkbenchBridge
  const product = new VideoWorkbenchProductController(bridge, {
    requestProject: async context => {
      calls.push({ name: 'project_input', value: context.projects.map(project => project.id) })
      return { title: '新建项目' }
    },
    requestAction: async request => {
      calls.push({ name: request.action, value: request.pending_quality?.accepted_check_ids })
      return request.action === 'confirm_post_render_quality'
        ? { action: 'confirm_post_render_quality', confirmed: true }
        : undefined
    },
  }, () => 'video-ui-test-idempotency-key-0001')

  await product.start()
  expect(product.getState()).toMatchObject({ showing_project_picker: true, projects: [{ id: 'video_00000001' }] })
  await product.selectProject('video_00000001')
  expect(product.getState().workspace?.selection).toMatchObject({ draft_item_ids: [], timeline_item_ids: [] })

  product.toggleDraftItem('draft_00000001', 'item_00000002')
  expect(product.getState().workspace?.selection).toMatchObject({ timeline_draft_id: 'draft_00000001', draft_item_ids: ['item_00000002'] })
  await product.perform('confirm_post_render_quality', 'task_00000001')
  expect(calls).toContainEqual({ name: 'confirm_post_render_quality', value: ['check_00000002'] })
  expect(calls).toContainEqual({
    name: 'confirm_quality',
    value: {
      operationId: 'task_00000001',
      input: {
        idempotency_key: 'video-ui-test-idempotency-key-0001',
        input: {
          report_id: 'quality_00000002',
          output_content_hash: hash,
          accepted_check_ids: ['check_00000002'],
        },
      },
    },
  })

  await product.createProject()
  expect(calls).toContainEqual({ name: 'project_input', value: ['video_00000001'] })
  expect(calls).toContainEqual({ name: 'create_project', value: { title: '新建项目' } })
  expect(product.getState()).toMatchObject({ selected_project_id: 'video_00000002', showing_project_picker: false })
  product.dispose()
})

test('产品控制器在后台操作期间自动续读持久化事件，完成后停止轮询', async () => {
  const snapshot = workspace()
  const completedSnapshot = { ...workspace({ revision: 2 }), operations: [task({ status: 'succeeded', status_sequence: 2, progress: 100, stage: '分析完成' })] }
  const scheduled: Array<() => void> = []
  const cancelled: unknown[] = []
  let polls = 0
  let workspaceReads = 0
  const bridge = {
    listProjects: async () => ({ ok: true, value: [snapshot.project] }),
    loadWorkspace: async () => ({ ok: true, value: workspaceReads++ === 0 ? snapshot : completedSnapshot }),
    loadOperationEvents: async () => {
      polls += 1
      return { ok: true, value: {
        cursor: 5,
        next_cursor: 6,
        reset_required: false,
        events: [{
          schema_version: 1,
          cursor: 5,
          project_id: 'video_00000001',
          task_id: 'task_00000001',
          operation_id: 'task_00000001',
          status_sequence: 2,
          occurred_at: at,
          task: task({ status: 'succeeded', status_sequence: 2, progress: 100, stage: '分析完成' }),
        }],
      } }
    },
  } as unknown as VideoWorkbenchBridge
  const product = new VideoWorkbenchProductController(bridge, {
    requestProject: async () => undefined,
    requestAction: async () => undefined,
  }, () => 'video-ui-auto-poll-key-0001', {
    operation_poll_interval_ms: 1,
    set_timeout: callback => {
      scheduled.push(callback)
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
    },
    clear_timeout: timer => cancelled.push(timer),
  })

  await product.start()
  await product.selectProject('video_00000001')
  expect(scheduled).toHaveLength(1)
  scheduled.shift()!()
  await Promise.resolve()
  await Promise.resolve()
  expect(polls).toBe(1)
  expect(workspaceReads).toBe(2)
  expect(product.getState().workspace?.snapshot?.project.revision).toBe(2)
  expect(product.getState().workspace?.snapshot?.operations[0]).toMatchObject({ status: 'succeeded', progress: 100 })
  expect(scheduled).toHaveLength(0)
  expect(cancelled).toHaveLength(0)
  product.dispose()
})

test('事件 reset 后权威刷新失败会冻结旧快照的一切写入，直到重新读取成功', async () => {
  const snapshot = workspace()
  const writes: string[] = []
  let workspaceReads = 0
  const bridge = {
    loadWorkspace: async () => {
      workspaceReads += 1
      if (workspaceReads === 1) return { ok: true, value: snapshot }
      throw new Error('sidecar disconnected')
    },
    loadOperationEvents: async () => ({ ok: true, value: {
      cursor: 42,
      next_cursor: 43,
      reset_required: true,
      events: [{ schema_version: 1, cursor: 42, project_id: 'video_00000001', task_id: 'task_00000001', operation_id: 'task_00000001', status_sequence: 7, occurred_at: at, task: task({ status: 'succeeded', status_sequence: 7, progress: 100 }) }],
    } }),
    chooseSources: async () => {
      writes.push('choose_sources')
      return { ok: true, value: [] }
    },
    applyEditorialCommandSet: async () => {
      writes.push('apply_editorial')
      return { ok: true, value: snapshot.current_timeline }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  const poll = await controller.pollOperationEvents()
  expect(poll).toMatchObject({ ok: false, error: { code: 'MEDIA_TEMPORARILY_UNAVAILABLE' } })
  expect(controller.getState()).toMatchObject({ event_reset_required: true, requires_authoritative_refresh: true, pending_action: undefined })

  const view = createVideoWorkbenchViewModel(controller.getState())
  expect(view.project_home.can_import_sources.enabled).toBeFalse()
  expect(view.import_scope.estimate_budget.enabled).toBeFalse()
  expect(view.editorial.command_set.enabled).toBeFalse()
  expect(view.finishing.can_create_variant.enabled).toBeFalse()
  expect(view.review_delivery.preflight.enabled).toBeFalse()
  expect(view.operation_center.operations[0]?.can_cancel).toBeFalse()

  await expect(controller.chooseAndAddSources('stale-source-key-0001')).resolves.toMatchObject({ ok: false, error: { code: 'MEDIA_STATE_CONFLICT' } })
  await expect(controller.applyEditorialCommands('stale-editorial-key-0001', [{ kind: 'set_track_state', track_id: 'track_00000001', locked: false }])).resolves.toMatchObject({ ok: false, error: { code: 'MEDIA_STATE_CONFLICT' } })
  expect(writes).toEqual([])
})

test('素材选择会把活动项目传给 Main，IPC 拒绝不会留下 pending 状态', async () => {
  const snapshot = workspace()
  const selectedProjectIds: string[] = []
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    chooseSources: async (projectId: string) => {
      selectedProjectIds.push(projectId)
      return { ok: true, value: [] }
    },
    chooseExportDestination: async () => {
      throw new Error('native dialog failed')
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  await expect(controller.chooseAndAddSources('source-picker-key-0001')).resolves.toMatchObject({ ok: true, value: [] })
  expect(selectedProjectIds).toEqual(['video_00000001'])
  expect(controller.getState().pending_action).toBeUndefined()

  await expect(controller.render('destination-picker-key-0001', 'variant_00000001')).resolves.toMatchObject({ ok: false, error: { code: 'MEDIA_TEMPORARILY_UNAVAILABLE' } })
  expect(controller.getState().pending_action).toBeUndefined()
})

test('素材事实按服务端 cursor 续页，检索显示 Source、Segment、时间范围和 generation', async () => {
  const snapshot = workspace()
  const resultRange = { start: time('0'), duration: time('10000') }
  const firstFact = { ...snapshot.facts.items[0]!, id: 'fact_00000011', kind: 'content_segment', segment_id: 'segment_00000001' }
  const secondFact = { ...snapshot.facts.items[0]!, id: 'fact_00000012', kind: 'content_segment', segment_id: 'segment_00000002' }
  const firstSearch = {
    schema_version: 1,
    generation: 5,
    items: [{ id: 'fact_00000021', source_id: 'source_00000001', kind: 'content_segment', segment_id: 'segment_00000001', range: resultRange, text: '第一条检索结果' }],
    next_cursor: 'search-cursor-1',
  }
  const nextSearchDifferentGeneration = {
    schema_version: 1,
    generation: 6,
    items: [{ id: 'fact_00000022', source_id: 'source_00000001', kind: 'content_segment', segment_id: 'segment_00000002', range: resultRange, text: '新 generation 结果' }],
  }
  const factCalls: unknown[] = []
  const searchCalls: unknown[] = []
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    loadFacts: async (_projectId: string, kind: string, request: unknown) => {
      factCalls.push({ kind, request })
      return { ok: true, value: (request as { cursor?: string }).cursor
        ? { schema_version: 1, items: [secondFact] }
        : { schema_version: 1, items: [firstFact], next_cursor: 'fact-cursor-1' } }
    },
    searchFacts: async (_projectId: string, query: string, request: unknown) => {
      searchCalls.push({ query, request })
      return { ok: true, value: (request as { cursor?: string }).cursor ? nextSearchDifferentGeneration : firstSearch }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  await controller.loadFacts('content_segment', { source_id: 'source_00000001' })
  await controller.loadMoreFacts()
  expect(factCalls).toEqual([
    { kind: 'content_segment', request: { source_id: 'source_00000001' } },
    { kind: 'content_segment', request: { source_id: 'source_00000001', cursor: 'fact-cursor-1' } },
  ])
  expect(controller.getState().snapshot?.facts.items.map(item => item.id)).toEqual(['fact_00000011', 'fact_00000012'])

  await controller.searchFacts('  击球  ')
  await controller.loadMoreFactSearch()
  expect(resultRange).toEqual({ start: { ticks: '0', tick_rate: { num: 1_000, den: 1 } }, duration: { ticks: '10000', tick_rate: { num: 1_000, den: 1 } } })
  expect(controller.getState().snapshot?.fact_search?.items[0]?.range).toEqual(resultRange)
  const view = createVideoWorkbenchViewModel(controller.getState())
  expect(searchCalls).toEqual([
    { query: '击球', request: {} },
    { query: '击球', request: { cursor: 'search-cursor-1' } },
  ])
  expect(view.material_browser.search_generation).toBe(6)
  expect(view.material_browser.search_results).toEqual([expect.objectContaining({
    source_id: 'source_00000001',
    source_name: 'fixture.mp4',
    segment_id: 'segment_00000002',
    range: '0.0 秒 至 10.0 秒',
    text: '新 generation 结果',
  })])
})

test('失效的检索 cursor 会丢弃旧页并从同一查询首页重新读取', async () => {
  const snapshot = workspace()
  const calls: unknown[] = []
  const bridge = {
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    searchFacts: async (_projectId: string, query: string, request: { cursor?: string }) => {
      calls.push({ query, request })
      if (request.cursor) return { ok: false, error: { code: 'MEDIA_INVALID_REQUEST', message: 'cursor expired' } }
      return { ok: true, value: {
        schema_version: 1,
        generation: calls.length === 1 ? 1 : 2,
        items: [{ id: calls.length === 1 ? 'fact_00000031' : 'fact_00000032', source_id: 'source_00000001', kind: 'content_segment', range, text: '可重读结果' }],
        ...(calls.length === 1 ? { next_cursor: 'expired-search-cursor' } : {}),
      } }
    },
  } as unknown as VideoWorkbenchBridge
  const controller = new VideoWorkbenchController('video_00000001', bridge)
  await controller.refresh()
  await controller.searchFacts('连续检索')
  await expect(controller.loadMoreFactSearch()).resolves.toMatchObject({ ok: true })
  expect(calls).toEqual([
    { query: '连续检索', request: {} },
    { query: '连续检索', request: { cursor: 'expired-search-cursor' } },
    { query: '连续检索', request: {} },
  ])
  expect(controller.getState().snapshot?.fact_search).toMatchObject({ generation: 2, items: [{ id: 'fact_00000032' }] })
})

test('桌面输入表单只生成结构化视频请求，不接收路径、grant 或任意 JSON', () => {
  const snapshot = workspace()
  const request = {
    action: 'estimate_budget' as const,
    project: snapshot.project,
    snapshot,
    selection: { source_id: 'source_00000001', draft_item_ids: [], timeline_item_ids: [] },
  }
  const form = createVideoWorkbenchActionForm(request)
  expect(form).toMatchObject({ title: '远程分析范围与预算', confirmLabel: '估算预算' })
  expect(form?.fields.map(field => field.name)).toEqual(['source_id', 'start_ms', 'end_ms', 'purposes', 'data_kinds'])
  expect(JSON.stringify(form)).not.toContain('path')
  expect(JSON.stringify(form)).not.toContain('grant')
  expect(JSON.stringify(form)).not.toContain('JSON')

  const input = createVideoWorkbenchActionInput(request, {
    source_id: 'source_00000001',
    start_ms: '100',
    end_ms: '9000',
    purposes: ['asr', 'planning'],
    data_kinds: ['audio_extract'],
    ignored_path: '/Users/example/private.mp4',
    ignored_grant: 'grant_should_not_cross',
  })
  expect(input).toEqual({
    ok: true,
    value: {
      action: 'estimate_budget',
      purposes: ['asr', 'planning'],
      source_ids: ['source_00000001'],
      data_kinds: ['audio_extract'],
      coverage: [{
        source_id: 'source_00000001',
        ranges: [{
          start: { ticks: '100', tick_rate: { num: 1_000, den: 1 } },
          duration: { ticks: '8900', tick_rate: { num: 1_000, den: 1 } },
        }],
      }],
    },
  })
})

test('版本化 Review 与 Approval 表单固定不可变版本，且不会把路径或自由 JSON 带入请求', () => {
  const snapshot = workspace({ reviewNote: true })
  const base = {
    project: snapshot.project,
    snapshot,
    selection: { review_note_id: 'review_note_00000001', draft_item_ids: [], timeline_item_ids: [] },
  }
  const noteRequest = { ...base, action: 'create_review_note' as const }
  expect(createVideoWorkbenchActionForm(noteRequest)?.fields.map(field => field.name)).toEqual(['actor_id', 'start_ms', 'end_ms', 'body'])
  expect(createVideoWorkbenchActionInput(noteRequest, {
    actor_id: 'reviewer_0002', start_ms: '100', end_ms: '900', body: '  这里需要保留完整击球声  ', ignored_path: '/private/video.mp4', raw_json: '{}',
  })).toEqual({
    ok: true,
    value: {
      action: 'create_review_note',
      input: {
        actor_id: 'reviewer_0002',
        anchor: {
          kind: 'timeline_range',
          editorial_timeline_version_id: 'timeline_00000001',
          range: { start: time('100'), duration: time('800') },
        },
        body: '这里需要保留完整击球声',
      },
    },
  })

  const approvalRequest = { ...base, action: 'create_approval_decision' as const }
  expect(createVideoWorkbenchActionInput(approvalRequest, {
    actor_id: 'approver_0001', state: 'changes_requested', note_ids: ['review_note_00000001'], raw_json: '{}',
  })).toEqual({
    ok: true,
    value: {
      action: 'create_approval_decision',
      input: { actor_id: 'approver_0001', state: 'changes_requested', note_ids: ['review_note_00000001'] },
    },
  })

  const resolutionRequest = { ...base, action: 'resolve_review_note' as const, target_id: 'review_note_00000001' }
  expect(createVideoWorkbenchActionInput(resolutionRequest, { actor_id: 'editor_0001', state: 'addressed' })).toMatchObject({
    ok: false,
    message: expect.stringContaining('新的 Timeline Version'),
  })
  expect(createVideoWorkbenchActionInput(resolutionRequest, { actor_id: 'editor_0001', state: 'dismissed', ignored_path: '/private/video.mp4' })).toEqual({
    ok: true,
    value: { action: 'resolve_review_note', review_note_id: 'review_note_00000001', input: { actor_id: 'editor_0001', state: 'dismissed' } },
  })
})

test('真实桌面产品旅程把 Review、处理和审批经同一受控桥接提交，并在每步后重读权威快照', async () => {
  const snapshot = workspace({ reviewNote: true })
  const calls: { name: string; value: unknown }[] = []
  let key = 0
  const bridge = {
    listProjects: async () => ({ ok: true, value: [snapshot.project] }),
    loadWorkspace: async () => ({ ok: true, value: snapshot }),
    createReviewNote: async (projectId: string, timelineId: string, command: unknown) => {
      calls.push({ name: 'create_review', value: { projectId, timelineId, command } })
      return { ok: true, value: { note: snapshot.project.review_notes[0], reused: false } }
    },
    resolveReviewNote: async (projectId: string, timelineId: string, noteId: string, command: unknown) => {
      calls.push({ name: 'resolve_review', value: { projectId, timelineId, noteId, command } })
      return { ok: true, value: { note: snapshot.project.review_notes[0], reused: false } }
    },
    createApprovalDecision: async (projectId: string, timelineId: string, command: unknown) => {
      calls.push({ name: 'approval', value: { projectId, timelineId, command } })
      return { ok: true, value: { decision: { id: 'approval_00000001' }, reused: false } }
    },
  } as unknown as VideoWorkbenchBridge
  const product = new VideoWorkbenchProductController(bridge, {
    requestProject: async () => undefined,
    requestAction: async request => {
      if (request.action === 'create_review_note') return {
        action: 'create_review_note',
        input: {
          actor_id: 'reviewer_0002',
          anchor: { kind: 'timeline_range', editorial_timeline_version_id: 'timeline_00000001', range: { start: time('100'), duration: time('800') } },
          body: '请保留击球瞬间。',
        },
      }
      if (request.action === 'resolve_review_note') return {
        action: 'resolve_review_note',
        review_note_id: request.target_id!,
        input: { actor_id: 'editor_0001', state: 'dismissed' },
      }
      if (request.action === 'create_approval_decision') return {
        action: 'create_approval_decision',
        input: { actor_id: 'approver_0001', state: 'changes_requested', note_ids: ['review_note_00000001'] },
      }
      return undefined
    },
  }, () => `video-ui-review-key-${++key}`)

  await product.start()
  await product.selectProject('video_00000001')
  await product.perform('create_review_note')
  await product.perform('resolve_review_note', 'review_note_00000001')
  await product.perform('create_approval_decision')

  expect(calls).toEqual([
    {
      name: 'create_review',
      value: {
        projectId: 'video_00000001', timelineId: 'timeline_00000001',
        command: { idempotency_key: 'video-ui-review-key-1', input: expect.objectContaining({ actor_id: 'reviewer_0002', body: '请保留击球瞬间。' }) },
      },
    },
    {
      name: 'resolve_review',
      value: {
        projectId: 'video_00000001', timelineId: 'timeline_00000001', noteId: 'review_note_00000001',
        command: { idempotency_key: 'video-ui-review-key-2', input: { actor_id: 'editor_0001', state: 'dismissed' } },
      },
    },
    {
      name: 'approval',
      value: {
        projectId: 'video_00000001', timelineId: 'timeline_00000001',
        command: { idempotency_key: 'video-ui-review-key-3', input: { actor_id: 'approver_0001', state: 'changes_requested', note_ids: ['review_note_00000001'] } },
      },
    },
  ])
  expect(product.getState().workspace?.pending_action).toBeUndefined()
  product.dispose()
})

test('拒绝远程范围表单不会构造预算或授权写入，编辑动作始终是 CommandSet', () => {
  const snapshot = workspace()
  const estimateRequest = {
    action: 'estimate_budget' as const,
    project: snapshot.project,
    snapshot,
    selection: { source_id: 'source_00000001', draft_item_ids: [], timeline_item_ids: [] },
  }
  expect(createVideoWorkbenchActionInput(estimateRequest, {
    source_id: 'source_00000001', start_ms: '0', end_ms: '10000', purposes: [], data_kinds: [],
  })).toMatchObject({ ok: false })

  const editorRequest = {
    action: 'open_editor' as const,
    project: snapshot.project,
    snapshot,
    selection: { source_id: 'source_00000001', timeline_item_ids: ['item_00000001'], draft_item_ids: [] },
  }
  const command = createVideoWorkbenchActionInput(editorRequest, {
    editorial_kind: 'ripple_delete',
    item_ids: ['item_00000001'],
    legacy_timeline: 'not accepted',
  })
  expect(command).toEqual({
    ok: true,
    value: { action: 'open_editor', commands: [{ kind: 'ripple_delete', item_ids: ['item_00000001'], close_gap: true }] },
  })
})

test('时间线编辑表单暴露修剪、切分、移动、插入和替换，并保留用户可理解的范围信息', () => {
  const snapshot = workspace()
  const request = {
    action: 'open_editor' as const,
    project: snapshot.project,
    snapshot,
    selection: { source_id: 'source_00000001', timeline_item_ids: ['item_00000001'], draft_item_ids: [] },
  }
  const form = createVideoWorkbenchActionForm(request)
  expect(form?.fields.find(field => field.name === 'editorial_kind')?.options).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: 'trim', label: '修剪素材范围' }),
    expect.objectContaining({ value: 'split', label: '在时间线上切分' }),
    expect.objectContaining({ value: 'reorder', label: '移动到其他轨道或时间位置' }),
    expect.objectContaining({ value: 'insert', label: '插入已确认草稿片段' }),
    expect.objectContaining({ value: 'replace', label: '替换为已确认草稿片段' }),
  ]))
  expect(form?.fields.find(field => field.name === 'source_start_ms')).toMatchObject({ defaultValue: 0 })
  expect(form?.fields.find(field => field.name === 'source_end_ms')).toMatchObject({ defaultValue: 10_000 })
  expect(form?.fields.find(field => field.name === 'timeline_end_ms')).toMatchObject({ defaultValue: 10_000 })

  expect(createVideoWorkbenchActionInput(request, {
    editorial_kind: 'trim',
    edit_item_id: 'item_00000001',
    source_start_ms: '1000',
    source_end_ms: '6000',
    timeline_start_ms: '0',
    timeline_end_ms: '5000',
  })).toMatchObject({
    ok: true,
    value: { action: 'open_editor', commands: [{
      kind: 'trim',
      item_id: 'item_00000001',
      source_range: { start: time('1000'), duration: time('5000') },
      timeline_range: { start: time('0'), duration: time('5000') },
    }] },
  })
  expect(createVideoWorkbenchActionInput(request, {
    editorial_kind: 'split', edit_item_id: 'item_00000001', split_at_ms: '5000',
  })).toMatchObject({ ok: true, value: { commands: [{ kind: 'split', item_id: 'item_00000001', at: time('5000') }] } })
  expect(createVideoWorkbenchActionInput(request, {
    editorial_kind: 'reorder', edit_item_id: 'item_00000001', track_id: 'track_00000001', timeline_start_ms: '2500',
  })).toMatchObject({ ok: true, value: { commands: [{ kind: 'reorder', item_id: 'item_00000001', track_id: 'track_00000001', timeline_start: time('2500') }] } })
  expect(createVideoWorkbenchActionInput(request, {
    editorial_kind: 'insert', insert_item_id: 'item_00000002', track_id: 'track_00000001',
  })).toMatchObject({ ok: true, value: { commands: [{ kind: 'insert', track_id: 'track_00000001', item: { id: 'item_00000002', track_id: 'track_00000001' } }] } })
  expect(createVideoWorkbenchActionInput(request, {
    editorial_kind: 'replace', edit_item_id: 'item_00000001', replacement_item_id: 'item_00000002',
  })).toMatchObject({ ok: true, value: { commands: [{ kind: 'replace', item_id: 'item_00000001', replacement: { id: 'item_00000001', track_id: 'track_00000001', timeline_range: range } }] } })

  const view = createVideoWorkbenchViewModel(reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot }))
  expect(view.editorial.timeline_duration_ms).toBe(10_000)
  expect(view.editorial.items[0]).toMatchObject({
    source_id: 'source_00000001',
    source_name: 'fixture.mp4',
    source_range: '0.0 秒 至 10.0 秒',
    timeline_range: '0.0 秒 至 10.0 秒',
    timeline_left_percent: 0,
    timeline_width_percent: 100,
    linked_item_ids: [],
  })
})

test('视频表单和操作中心使用用户语言，内部 ID 只作为提交值保留', () => {
  const snapshot = workspace()
  const quickCreate = createVideoWorkbenchActionForm({
    action: 'create_quick_draft',
    project: snapshot.project,
    snapshot,
    selection: { draft_item_ids: [], timeline_item_ids: [] },
  })
  expect(quickCreate).toMatchObject({
    title: '让 AI 先给出剪辑建议',
    confirmLabel: '生成建议草稿',
    description: expect.stringContaining('逐项确认后'),
  })
  expect(quickCreate?.fields[0]).toMatchObject({ name: 'user_goal', label: '你想做成什么视频' })
  expect(quickCreate?.fields.find(field => field.name === 'audio_mode')).toMatchObject({ kind: 'select', defaultValue: 'preserve_source' })
  expect(quickCreate?.fields.find(field => field.name === 'voiceover_persona')).toMatchObject({ kind: 'select', defaultValue: 'none' })
  expect(quickCreate?.fields.find(field => field.name === 'caption_strategy')).toMatchObject({ kind: 'select', defaultValue: 'spoken_rhythm' })
  expect(createVideoWorkbenchActionInput({
    action: 'create_quick_draft',
    project: snapshot.project,
    snapshot,
    selection: { draft_item_ids: [], timeline_item_ids: [] },
  }, {
    user_goal: '保留现场声音，做一条有情绪起伏的短片。',
    narrative_voice: 'cinematic',
    emotional_arc: 'tension_release',
    audio_mode: 'narration_after_review',
    voiceover_persona: 'calm_guide',
    caption_strategy: 'minimal_emphasis',
    keep_natural_pauses: true,
    human_notes: '旁白必须先审核。',
  })).toEqual({
    ok: true,
    value: {
      action: 'create_quick_draft',
      input: {
        base_revision: 1,
        user_goal: '保留现场声音，做一条有情绪起伏的短片。',
        creative_direction: {
          narrative_voice: 'cinematic',
          emotional_arc: 'tension_release',
          audio_mode: 'narration_after_review',
          voiceover_persona: 'calm_guide',
          caption_strategy: 'minimal_emphasis',
          keep_natural_pauses: true,
          human_notes: '旁白必须先审核。',
        },
      },
    },
  })

  const structuredBrief = createVideoWorkbenchActionInput({
    action: 'create_quick_draft',
    project: snapshot.project,
    snapshot,
    selection: { draft_item_ids: [], timeline_item_ids: [] },
  }, {
    user_goal: '做一条 15 秒竖屏台球高光，开头直接进入关键进球。',
    use_case: 'sports_highlight',
    audience: '第一次看台球视频的观众',
    distribution: 'vertical_short',
    target_duration_seconds: '15',
    coverage_preference: 'highlights',
    editing_strategy: 'highlights',
    tone: 'energetic',
    pace: 'fast',
    caption_preference: 'burn_in',
    hook_strategy: 'strongest_moment',
    story_structure: 'highlight_reel',
    selection_focus: 'action',
    must_preserve: '关键进球\n现场击球声',
    narrative_voice: 'confident',
    emotional_arc: 'energy',
    audio_mode: 'preserve_source',
    voiceover_persona: 'none',
    caption_strategy: 'minimal_emphasis',
    keep_natural_pauses: true,
    human_notes: '',
  })
  expect(structuredBrief).toMatchObject({
    ok: true,
    value: {
      input: {
        brief: {
          use_case: 'sports_highlight',
          audience: '第一次看台球视频的观众',
          distribution: 'vertical_short',
          story_structure: 'highlight_reel',
          selection_focus: 'action',
          must_preserve: ['关键进球', '现场击球声'],
        },
        planning: { target_duration_seconds: 15, coverage_preference: 'highlights', editing_strategy: 'highlights' },
      },
    },
  })
  const tooManyPreservedItems = createVideoWorkbenchActionInput({
    action: 'create_quick_draft',
    project: snapshot.project,
    snapshot,
    selection: { draft_item_ids: [], timeline_item_ids: [] },
  }, {
    user_goal: '测试输入边界',
    must_preserve: Array.from({ length: 41 }, (_, index) => `重点${index + 1}`).join(','),
  })
  expect(tooManyPreservedItems).toMatchObject({ ok: false })

  const editor = createVideoWorkbenchActionForm({
    action: 'open_editor',
    project: snapshot.project,
    snapshot,
    selection: { timeline_item_ids: ['item_00000001'], draft_item_ids: [] },
  })
  const itemOptions = editor?.fields.find(field => field.name === 'item_ids')?.options ?? []
  const trackOptions = editor?.fields.find(field => field.name === 'track_id')?.options ?? []
  expect(itemOptions).toEqual([expect.objectContaining({ value: 'item_00000001', label: expect.stringContaining('视频 1') })])
  expect(trackOptions).toEqual([expect.objectContaining({ value: 'track_00000001', label: expect.stringContaining('主视频轨道 1') })])
  expect(itemOptions[0]?.label).not.toContain('item_00000001')
  expect(trackOptions[0]?.label).not.toContain('track_00000001')

  const state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot })
  const view = createVideoWorkbenchViewModel(state)
  expect(view.operation_center.operations[0]).toMatchObject({
    label: '渲染正式成片',
    status_label: '处理中',
    detail: '正在渲染',
  })
  expect(view.journey).toMatchObject({
    title: '正在渲染正式成片',
    description: expect.stringContaining('20%'),
  })
})

test('交付表单可选择原声、音乐和旁白组合，并显示真实项目资产状态', () => {
  const base = workspace()
  const snapshot = {
    ...base,
    project: {
      ...base.project,
      project_assets: [
        { id: 'asset_music_00000001', asset_kind: 'music', provenance: 'user_import', mime_type: 'audio/mpeg', byte_size: 10, content_hash: hash, created_at: at },
        { id: 'asset_voice_00000001', asset_kind: 'voice_over', provenance: 'generated', mime_type: 'audio/mpeg', byte_size: 10, content_hash: hash, created_at: at },
      ],
    },
  } as unknown as VideoWorkbenchSnapshot
  const request = {
    action: 'open_variant_editor' as const,
    project: snapshot.project,
    snapshot,
    selection: { variant_id: 'variant_00000001', draft_item_ids: [], timeline_item_ids: [] },
  }
  const form = createVideoWorkbenchActionForm(request)
  const deliveryKind = form?.fields.find(field => field.name === 'delivery_kind')
  expect(deliveryKind?.options).toEqual(expect.arrayContaining([expect.objectContaining({ value: 'set_audio_policy', label: '选择声音组合' })]))
  expect(form?.fields.find(field => field.name === 'audio_policy')).toMatchObject({ defaultValue: 'source_only' })
  expect(createVideoWorkbenchActionInput(request, {
    delivery_kind: 'set_audio_policy',
    audio_policy: 'source_music_with_voice_over',
  })).toMatchObject({
    ok: true,
    value: { action: 'open_variant_editor', commands: [{ kind: 'set_audio_policy', policy: 'source_music_with_voice_over' }] },
  })
  const view = createVideoWorkbenchViewModel(reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot }))
  expect(view.finishing).toMatchObject({
    audio_policy: '只保留原声',
    music_asset_count: 1,
    voiceover_asset_count: 1,
    voiceover_ready: false,
  })
})

test('分析与规划操作投影阶段进度、当前理解和用户下一步，而不是只有百分比', () => {
  const snapshot = {
    ...workspace(),
    current_timeline: undefined,
    timeline_drafts: [],
    operations: [task({
      kind: 'video.plan',
      progress: 60,
      stage: '正在编译剪辑方案',
      result: {
        workflow: {
          phase: 'drafting_candidates',
          completed_units: 2,
          total_units: 4,
          next_action: 'wait_for_analysis',
          interpreted_goal: '做一条节奏明快的短片',
          clarifications: ['请确认是否保留完整过程。'],
        },
      },
    })],
  } as unknown as VideoWorkbenchSnapshot
  const view = createVideoWorkbenchViewModel(reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot }))
  expect(view.operation_center.operations[0]).toMatchObject({
    workflow_phase: 'drafting_candidates',
    completed_units: 2,
    total_units: 4,
    next_action: 'wait_for_analysis',
    interpreted_goal: '做一条节奏明快的短片',
    clarifications: ['请确认是否保留完整过程。'],
  })
  expect(view.journey.description).toContain('阶段 2/4')
})

test('工作台投影显示已确认目标、候选理由、预计时长和取舍，而不是只显示草稿数量', () => {
  const base = workspace()
  const snapshot = {
    ...base,
    project: {
      ...base.project,
      creation_brief: {
        id: 'creation_brief_00000001',
        project_id: 'video_00000001',
        revision: 1,
        use_case: 'product_demo',
        user_request: '做一条短视频，开头直接展示关键功能。',
        audience: '新用户',
        distribution: 'vertical_short',
        tone: 'clear',
        pace: 'fast',
        caption_preference: 'auto',
        hook_strategy: 'strongest_moment',
        story_structure: 'hook_value_payoff',
        selection_focus: 'product',
        must_preserve: ['关键功能演示'],
        creative_direction: {
          narrative_voice: 'plainspoken',
          emotional_arc: 'clarity',
          audio_mode: 'preserve_source',
          voiceover_persona: 'none',
          caption_strategy: 'spoken_rhythm',
          keep_natural_pauses: true,
          human_notes: '',
        },
        created_at: at,
        updated_at: at,
      },
      brief: {
        schema_version: 1,
        user_goal: '做一条短视频，开头直接展示关键功能。',
        content_type: 'product_demo',
        output_channel: 'vertical_short',
        must_preserve_text: ['关键功能演示'],
        recommended_direction: '先展示结果，再补充过程。',
        rationale: ['关键功能的证据置信度最高。'],
        gaps: ['请确认是否需要保留完整操作过程。'],
        compiler_version: 'video-brief-v1',
      },
      quick_create_batches: [{
        id: 'quick_batch_00000001',
        project_id: 'video_00000001',
        idempotency_key: 'quick-create-suggestion-key-0001',
        base_revision: 1,
        max_candidates: 1,
        request_hash: hash,
        intent_revision: 1,
        facts_basis_hash: hash,
        editorial_plan_ids: ['plan_00000001'],
        candidates: [{
          id: 'quick_candidate_00000001',
          draft_id: 'draft_00000001',
          label: '先展示结果，再补充过程',
          explanation: '把最有辨识度的功能放在开头，避免用户先看铺垫。',
          estimated_duration: time('8000'),
          included_segment_ids: ['segment_00000001'],
          omissions: [{ target_id: 'segment_00000002', reason: '超出目标时长' }],
        }],
        explanation: '建议先确认开头，再进入正式时间线。',
        created_at: at,
      }],
    },
  } as unknown as VideoWorkbenchSnapshot
  const view = createVideoWorkbenchViewModel(reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot }))
  expect(view.project_home.creation_brief).toMatchObject({
    use_case: '产品演示',
    distribution: '竖屏短视频',
    pace: '快速',
    caption_preference: '自动',
    hook_strategy: '最强时刻开场',
    user_request: '做一条短视频，开头直接展示关键功能。',
  })
  expect(view.quick_create.clarifications).toEqual(['请确认是否需要保留完整操作过程。'])
  expect(view.quick_create.interpreted_goal).toBe('做一条短视频，开头直接展示关键功能。')
  expect(view.quick_create.rationale).toEqual(['关键功能的证据置信度最高。'])
  expect(view.quick_create.planning_source).toBe('local_conservative')
  expect(view.quick_create.suggestions).toEqual([expect.objectContaining({
    label: '先展示结果，再补充过程',
    explanation: '把最有辨识度的功能放在开头，避免用户先看铺垫。',
    estimated_duration: '8.0 秒',
    included_count: 1,
    omission_count: 1,
  })])
  expect(videoDraftSelection(view, 'draft_00000001')).toEqual({
    timeline_draft_id: 'draft_00000001',
    draft_item_ids: ['item_00000002'],
  })
})

test('项目表单与恢复提示提供受控下一步，不依赖 prompt 或 JSON 文本', () => {
  const projectForm = createProjectForm()
  expect(projectForm).toMatchObject({ title: '新建视频项目' })
  expect(projectForm.fields[0]).toMatchObject({ name: 'title', kind: 'text' })
  expect(projectForm.fields.find(field => field.name === 'output_preset')).toMatchObject({ kind: 'select' })
  expect(projectForm.fields.find(field => field.name === 'delivery_format')).toMatchObject({ kind: 'select' })
  expect(createProjectInput({ title: '  视频集锦  ' })).toEqual({ ok: true, value: { title: '视频集锦' } })
  expect(createProjectInput({ title: '  横屏 4K  ', output_preset: 'horizontal_4k', delivery_format: 'mov_prores_422_pcm' })).toEqual({ ok: true, value: { title: '横屏 4K', output_preset: 'horizontal_4k', delivery_format: 'mov_prores_422_pcm' } })
  expect(createProjectInput({ title: '无效规格', output_preset: '8k' })).toMatchObject({ ok: false })
  expect(createProjectInput({ title: '无效格式', delivery_format: 'webm_vp9' })).toMatchObject({ ok: false })
  expect(createProjectInput({ title: ' ' })).toMatchObject({ ok: false })

  const recovered = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: workspace() })
  const conflicted = reduceVideoWorkbenchUiState(recovered, { type: 'action_failed', error: { code: 'MEDIA_STATE_CONFLICT', message: '项目已更新' } })
  expect(createVideoWorkbenchViewModel(conflicted).failure_recovery).toEqual({ code: 'MEDIA_STATE_CONFLICT', label: '刷新项目状态', action: 'refresh' })
  const sourceFailed = reduceVideoWorkbenchUiState(recovered, { type: 'action_failed', error: { code: 'MEDIA_VIDEO_SOURCE_UNREADABLE', message: '素材不可读' } })
  expect(createVideoWorkbenchViewModel(sourceFailed).failure_recovery).toEqual({ code: 'MEDIA_VIDEO_SOURCE_UNREADABLE', label: '重新选择素材', action: 'choose_sources' })
})

test('项目首页把素材、方案、时间线和交付收束成一条下一步路径', () => {
  const base = workspace()
  const sourcesOnly = {
    ...base,
    current_timeline: undefined,
    timeline_drafts: [],
    variants: [],
    operations: [],
  }
  let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: sourcesOnly })
  let view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({
    current_step: 'plan',
    title: '告诉我你想剪成什么样',
    action: { panel: 'quick_create', action: 'create_quick_draft' },
  })

  const timelineOnly = { ...base, variants: [], operations: [] }
  state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: timelineOnly })
  view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({
    current_step: 'finish',
    action: { panel: 'finishing', action: 'create_variant' },
  })
})

test('素材缺失时下一步仍能重新选择素材，不被全局 stale/missing 门禁锁死', () => {
  const base = workspace()
  const source = base.project.sources[0]
  const snapshot = {
    ...base,
    project: { ...base.project, sources: [{ ...source, missing: true }] },
    operations: [],
  }
  const state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot })
  const view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({
    current_step: 'import',
    action: { panel: 'import_scope', action: 'choose_sources', availability: { enabled: true } },
  })
})

test('交付路径严格按当前版本推进：预检、预览、渲染、完成验证', () => {
  const passed = workspace({ preflight: 'passed' })
  let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: { ...passed, operations: [] } })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  let view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({ current_step: 'deliver', action: { action: 'preview' } })

  const preview = {
    timeline_version_id: 'timeline_00000001',
    delivery_variant_version_id: 'variant_version_00000001',
    execution_plan_id: 'plan_00000001',
    asset_id: 'asset_00000001',
    asset_path: '/api/media/assets/asset_00000001/content',
    content_hash: hash,
    created_at: at,
  }
  const withPreview = { ...passed, preview, operations: [] }
  state = reduceVideoWorkbenchUiState(state, { type: 'hydrate', snapshot: withPreview })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({ action: { action: 'render' } })

  const complete = workspace({ preflight: 'passed', outputVerified: true })
  state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: { ...complete, preview, operations: [] } })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({ completed: true, title: '已完成并验证' })
})

test('后台操作和后渲染质量确认各自提供唯一恢复入口', () => {
  let state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: workspace() })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  let view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({ title: '正在渲染正式成片', action: { panel: 'operation_center', action: 'poll_operations' } })

  const pendingQuality = workspace({ preflight: 'passed', outputVerified: true, pendingQuality: true })
  state = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: pendingQuality })
  state = reduceVideoWorkbenchUiState(state, { type: 'select', selection: { variant_id: 'variant_00000001' } })
  view = createVideoWorkbenchViewModel(state)
  expect(view.journey).toMatchObject({ title: '确认导出质量告警', action: { action: 'confirm_post_render_quality', target_id: 'task_00000001' } })
})
