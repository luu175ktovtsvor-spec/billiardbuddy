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

function workspace(options: { lockedTrack?: boolean; preflight?: 'passed' | 'blocked' | 'needs_user_decision'; outputVerified?: boolean; revision?: number; pendingQuality?: boolean; reviewNote?: boolean } = {}): VideoWorkbenchSnapshot {
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
      sources: [{ id: 'source_00000001', name: 'fixture.mp4', duration_ms: 10_000, width: 1920, height: 1080, has_audio: true, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
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

test('项目表单与恢复提示提供受控下一步，不依赖 prompt 或 JSON 文本', () => {
  expect(createProjectForm()).toMatchObject({ title: '新建视频项目', fields: [{ name: 'title', kind: 'text' }] })
  expect(createProjectInput({ title: '  视频集锦  ' })).toEqual({ ok: true, value: { title: '视频集锦' } })
  expect(createProjectInput({ title: ' ' })).toMatchObject({ ok: false })

  const recovered = reduceVideoWorkbenchUiState(createVideoWorkbenchUiState(), { type: 'hydrate', snapshot: workspace() })
  const conflicted = reduceVideoWorkbenchUiState(recovered, { type: 'action_failed', error: { code: 'MEDIA_STATE_CONFLICT', message: '项目已更新' } })
  expect(createVideoWorkbenchViewModel(conflicted).failure_recovery).toEqual({ code: 'MEDIA_STATE_CONFLICT', label: '刷新项目状态', action: 'refresh' })
  const sourceFailed = reduceVideoWorkbenchUiState(recovered, { type: 'action_failed', error: { code: 'MEDIA_VIDEO_SOURCE_UNREADABLE', message: '素材不可读' } })
  expect(createVideoWorkbenchViewModel(sourceFailed).failure_recovery).toEqual({ code: 'MEDIA_VIDEO_SOURCE_UNREADABLE', label: '重新选择素材', action: 'choose_sources' })
})
