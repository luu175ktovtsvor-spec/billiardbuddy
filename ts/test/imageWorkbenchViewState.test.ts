import { describe, expect, test } from 'bun:test'
import { ImageWorkbenchShell, renderImageWorkbenchShell } from '../desktop/src/image-workbench/app/imageWorkbenchShell.js'
import type { ImageWorkbenchClient, ImageWorkbenchProjectProjection } from '../desktop/src/image-workbench/api/imageWorkbenchClient.js'
import { imageCandidatePreviewResponseSchema, type ImageQuickCreateInput } from '../shared/contracts/imageWorkflow.js'
import {
  createImageWorkbenchViewState,
  parseImageWorkbenchViewState,
  planImageWorkbenchRestore,
  reconcileImageWorkbenchViewState,
  reduceImageWorkbenchViewState,
  serializeImageWorkbenchViewState,
  type ImageWorkbenchSelectionIndex,
} from '../desktop/src/image-workbench/state/imageWorkbenchViewState.js'

const projectId = 'project_001'
const candidateId = 'candidate_001'
const canvasId = 'canvas_001'
const artboardId = 'artboard_001'
const layerId = 'layer_001'

function selectedViewState() {
  let state = createImageWorkbenchViewState()
  state = reduceImageWorkbenchViewState(state, { kind: 'select-project', project_id: projectId })
  state = reduceImageWorkbenchViewState(state, { kind: 'select-candidate', candidate_id: candidateId })
  state = reduceImageWorkbenchViewState(state, { kind: 'select-canvas', canvas_id: canvasId })
  state = reduceImageWorkbenchViewState(state, { kind: 'select-artboard', artboard_id: artboardId })
  state = reduceImageWorkbenchViewState(state, {
    kind: 'begin-drag',
    draft: {
      kind: 'canvas-layer',
      project_id: projectId,
      canvas_id: canvasId,
      layer_id: layerId,
      origin: { x: 20, y: 30 },
      current: { x: 24, y: 37 },
    },
  })
  return state
}

const completeIndex: ImageWorkbenchSelectionIndex = {
  project_id: projectId,
  candidate_ids: [candidateId],
  canvas_ids: [canvasId],
  artboard_ids: [artboardId],
  canvas_layer_ids: { [canvasId]: [layerId] },
}

describe('image workbench transient view state', () => {
  test('serializes only local selections, panel state, drag draft, and event cursor', () => {
    let state = selectedViewState()
    state = reduceImageWorkbenchViewState(state, { kind: 'open-panel', panel: 'canvas-editor' })
    state = reduceImageWorkbenchViewState(state, { kind: 'advance-event-cursor', project_id: projectId, cursor: 9 })
    const serialized = serializeImageWorkbenchViewState(state)
    const persisted = JSON.parse(serialized) as Record<string, unknown>

    expect(Object.keys(persisted).sort()).toEqual([
      'active_panel',
      'drag_draft',
      'event_cursors',
      'expanded_panels',
      'schema_version',
      'selected_artboard_id',
      'selected_candidate_id',
      'selected_canvas_id',
      'selected_project_id',
    ])
    expect(persisted).not.toHaveProperty('project')
    expect(persisted).not.toHaveProperty('operations')
    expect(persisted).not.toHaveProperty('candidates')
    expect(parseImageWorkbenchViewState(serialized)).toEqual(state)
  })

  test('drops malformed persistence and business facts outside the allowlist', () => {
    const parsed = parseImageWorkbenchViewState(JSON.stringify({
      schema_version: 1,
      active_panel: 'operation-center',
      expanded_panels: ['operation-center', 'not-a-panel'],
      selected_project_id: projectId,
      selected_candidate_id: 'bad',
      event_cursors: { [projectId]: 14, malformed: -1 },
      project: { id: projectId, prompt: 'must not persist' },
      operations: [{ id: 'operation_001' }],
    }))

    expect(parsed.active_panel).toBe('operation-center')
    expect(parsed.expanded_panels).toEqual(['operation-center'])
    expect(parsed.selected_project_id).toBe(projectId)
    expect(parsed.selected_candidate_id).toBeUndefined()
    expect(parsed.event_cursors).toEqual({ [projectId]: 14 })
    expect(JSON.parse(serializeImageWorkbenchViewState(parsed))).not.toHaveProperty('project')
  })

  test('reconciles stale local selection and dragging against a fresh public projection index', () => {
    const stale = selectedViewState()
    const reconciled = reconcileImageWorkbenchViewState(stale, {
      ...completeIndex,
      candidate_ids: [],
      canvas_ids: [],
      artboard_ids: [],
      canvas_layer_ids: {},
    })

    expect(reconciled.selected_project_id).toBe(projectId)
    expect(reconciled.selected_candidate_id).toBeUndefined()
    expect(reconciled.selected_canvas_id).toBeUndefined()
    expect(reconciled.selected_artboard_id).toBeUndefined()
    expect(reconciled.drag_draft).toBeUndefined()
  })

  test('advances only the event cursor and requests projection reload on reset', () => {
    let state = selectedViewState()
    state = reduceImageWorkbenchViewState(state, { kind: 'advance-event-cursor', project_id: projectId, cursor: 4 })
    const incremental = planImageWorkbenchRestore(state, projectId, {
      events: [],
      cursor: 8,
      reset_required: false,
    })
    const reset = planImageWorkbenchRestore(incremental.view_state, projectId, {
      events: [],
      cursor: 9,
      reset_required: true,
    })

    expect(incremental.event_cursor).toBe(8)
    expect(incremental.reload_projection).toBeFalse()
    expect(incremental.view_state.event_cursors[projectId]).toBe(8)
    expect(reset.event_cursor).toBe(9)
    expect(reset.reload_projection).toBeTrue()
  })
})

test('image workbench shell switches to exactly one active 15.5 workflow panel', () => {
  const panels = [
    ['quick-create', 'quick-create', 'data-quick-create-form'],
    ['creative-intake', 'creative-intake', 'data-brief-overrides-form'],
    ['inspiration-board', 'inspiration-board', 'data-inspiration-upsert-form'],
    ['reference-tray', 'reference-tray', 'data-reference-form'],
    ['candidate-review', 'candidate-review', 'data-feature="candidate-review"'],
    ['canvas-editor', 'canvas-editor', 'data-feature="canvas-editor"'],
    ['delivery-panel', 'delivery-panel', 'data-delivery-spec-form'],
    ['project-library', 'project-library', 'data-library-reuse-form'],
    ['campaign', 'campaign', 'data-campaign-create-form'],
    ['operation-center', 'operation-center', 'data-feature="operation-center"'],
  ] as const

  for (const [panel, content, commandSelector] of panels) {
    const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
      kind: 'open-panel',
      panel,
    })
    const html = renderImageWorkbenchShell({ view_state: state, campaigns: [] })
    expect(html).toContain(`data-panel-content="${content}"`)
    expect(html.match(/data-panel-content=/gu)?.length).toBe(1)
    expect(html).toContain(commandSelector)
  }
})

test('quick-create form exposes an optional first-round reference with only accepted roles', () => {
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
    kind: 'open-panel',
    panel: 'quick-create',
  })
  const html = renderImageWorkbenchShell({ view_state: state, campaigns: [] })

  expect(html).toContain('data-quick-reference-file')
  expect(html).toContain('accept="image/png,image/jpeg,image/webp"')
  expect(html).toContain('data-quick-reference-role')
  expect(html).toContain('data-quick-brief-confirmed-facts')
  expect(html).toContain('data-quick-brief-must-preserve')
  expect(html).toContain('data-quick-brief-may-change')
  expect(html).toContain('data-quick-brief-exact-text')
  for (const role of ['subject', 'product', 'character', 'style', 'composition', 'environment', 'brand', 'logo', 'qrcode']) {
    expect(html).toContain(`value="${role}"`)
  }
  expect(html).not.toContain('value="unclassified"')
})

test('quick-create compiles optional complete Brief before its first paid Round', async () => {
  const submissions: ImageQuickCreateInput[] = []
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({
    root,
    client: {} as ImageWorkbenchClient,
    idempotency_key_factory: () => 'image_ui_0123456789abcdef',
  })
  const internals = shell as unknown as {
    quickCreate: (input: ImageQuickCreateInput) => Promise<void>
    quickCreateFromForm: (form: HTMLFormElement) => Promise<void>
  }
  internals.quickCreate = async input => {
    submissions.push(input)
  }
  const form = {
    querySelector: (selector: string) => ({
      '[data-quick-prompt]': { value: '为台球赛事制作门店宣传图' },
      '[data-quick-preset]': { value: 'square' },
      '[data-quick-reference-file]': { files: [] },
      '[data-quick-reference-role]': { value: '' },
      '[data-quick-brief-confirmed-facts]': { value: '门店主题是夏季联赛\n活动时间已确认' },
      '[data-quick-brief-must-preserve]': { value: '品牌主色\n活动标题' },
      '[data-quick-brief-may-change]': { value: '背景装饰' },
      '[data-quick-brief-exact-text]': { value: '夏季联赛' },
    }[selector] ?? null),
  } as unknown as HTMLFormElement

  await internals.quickCreateFromForm(form)

  expect(submissions).toEqual([expect.objectContaining({
    brief_overrides: {
      confirmed_facts: ['门店主题是夏季联赛', '活动时间已确认'],
      must_preserve: ['品牌主色', '活动标题'],
      may_change: ['背景装饰'],
      exact_text: ['夏季联赛'],
    },
  })])
})

test('quick-create maps an optional first-round file to its typed input and stops invalid role or file reads', async () => {
  const submissions: ImageQuickCreateInput[] = []
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({
    root,
    client: {} as ImageWorkbenchClient,
    idempotency_key_factory: () => 'image_ui_0123456789abcdef',
  })
  const internals = shell as unknown as {
    quickCreate: (input: ImageQuickCreateInput) => Promise<void>
    quickCreateFromForm: (form: HTMLFormElement) => Promise<void>
  }
  internals.quickCreate = async input => {
    submissions.push(input)
  }
  const form = (file: File | undefined, role = '') => ({
    querySelector: (selector: string) => ({
      '[data-quick-prompt]': { value: '为台球赛事制作门店宣传图' },
      '[data-quick-preset]': { value: 'square' },
      '[data-quick-reference-file]': { files: file ? [file] : [] },
      '[data-quick-reference-role]': { value: role },
    }[selector] ?? null),
  }) as unknown as HTMLFormElement
  const globalWithFileReader = globalThis as unknown as { FileReader?: unknown }
  const previousFileReader = globalWithFileReader.FileReader
  class FakeFileReader {
    result: string | null = null
    error: Error | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    readAsDataURL(file: File): void {
      const fixture = file as unknown as { data_url?: string; fail?: boolean }
      if (fixture.fail) {
        this.error = new Error('IMAGE_FILE_READ_FAILED')
        this.onerror?.()
        return
      }
      this.result = fixture.data_url ?? null
      this.onload?.()
    }
  }
  globalWithFileReader.FileReader = FakeFileReader
  try {
    await internals.quickCreateFromForm(form(undefined))
    expect(submissions).toEqual([expect.objectContaining({
      idempotency_key: 'image_ui_0123456789abcdef',
      output_preset: 'square',
      reference_inputs: [],
    })])

    const validFile = {
      type: 'image/png',
      data_url: 'data:image/png;base64,AA==',
    } as unknown as File
    await internals.quickCreateFromForm(form(validFile, 'product'))
    expect(submissions[1]).toMatchObject({
      reference_inputs: [{ data_url: 'data:image/png;base64,AA==', role: 'product' }],
    })

    await internals.quickCreateFromForm(form(validFile, 'unclassified'))
    expect(submissions).toHaveLength(2)
    expect(shell.snapshot().notice).toBe('请选择有效的首轮参考角色。')

    const unreadableFile = { type: 'image/png', fail: true } as unknown as File
    await expect(internals.quickCreateFromForm(form(unreadableFile, 'product'))).rejects.toThrow('IMAGE_FILE_READ_FAILED')
    expect(submissions).toHaveLength(2)
  } finally {
    if (previousFileReader === undefined) delete globalWithFileReader.FileReader
    else globalWithFileReader.FileReader = previousFileReader
  }
})

test('shell lists existing image projects without persisting project facts locally', () => {
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
    kind: 'select-project',
    project_id: 'project_002',
  })
  const html = renderImageWorkbenchShell({
    view_state: state,
    campaigns: [],
    projects: [
      { id: projectId, title: '第一张海报' },
      { id: 'project_002', title: '第二张海报' },
    ] as never,
  })

  expect(html).toContain('data-project-select-form')
  expect(html).toContain('第一张海报')
  expect(html).toContain('value="project_002" selected')
  expect(serializeImageWorkbenchViewState(state)).not.toContain('第一张海报')
})

test('candidate review only renders trusted bridge preview bytes, never the protected media path', () => {
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
    kind: 'open-panel',
    panel: 'candidate-review',
  })
  const protectedPath = `/api/images/${projectId}/candidates/${candidateId}/content`
  const projection = {
    project: { id: projectId, revision: 1 },
    candidate_groups: [{
      candidates: [{ id: candidateId, candidate_index: 0, image_path: protectedPath }],
    }],
  } as unknown as ImageWorkbenchProjectProjection
  const html = renderImageWorkbenchShell({
    view_state: state,
    projection,
    campaigns: [],
    candidate_previews: { [candidateId]: 'data:image/png;base64,AA==' },
  })

  expect(html).toContain('src="data:image/png;base64,AA=="')
  expect(html).not.toContain(protectedPath)

  const unsafeHtml = renderImageWorkbenchShell({
    view_state: state,
    projection,
    campaigns: [],
    candidate_previews: { [candidateId]: 'https://untrusted.example/candidate.png' },
  })
  expect(unsafeHtml).not.toContain('https://untrusted.example/candidate.png')
  expect(unsafeHtml).toContain('image-workbench-candidate-preview-unavailable')
})

test('candidate preview bridge response is a bounded shared image-data contract', () => {
  expect(imageCandidatePreviewResponseSchema.safeParse({
    candidate_id: candidateId,
    data_url: 'data:image/jpeg;base64,AA==',
  }).success).toBeTrue()
  expect(imageCandidatePreviewResponseSchema.safeParse({
    candidate_id: candidateId,
    data_url: 'https://untrusted.example/candidate.jpg',
  }).success).toBeFalse()
})

test('creative intake exposes only typed command forms and no renderer bridge', () => {
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
    kind: 'open-panel',
    panel: 'creative-intake',
  })
  const html = renderImageWorkbenchShell({ view_state: state, campaigns: [] })

  for (const selector of [
    'data-create-plan-form',
    'data-brand-create-form',
    'data-brand-revise-form',
    'data-template-create-form',
    'data-template-revise-form',
  ]) expect(html).toContain(selector)
  expect(html).not.toContain('billiardBuddyNative')
})

test('creative intake lists active reusable grants and exposes a typed revoke command', () => {
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
    kind: 'open-panel',
    panel: 'creative-intake',
  })
  const html = renderImageWorkbenchShell({
    view_state: state,
    campaigns: [],
    asset_grants: [{
      id: 'grant_view_0001', asset_id: 'asset_view_0001',
      from_owner: { kind: 'project', id: projectId },
      to_owner: { kind: 'template', id: 'template_view_0001' },
      purpose: 'template_use',
      granted_by: { kind: 'standalone', owner_id: 'local' },
      created_at: '2026-08-05T00:00:00.000Z',
    }] as never,
  })

  expect(html).toContain('data-asset-grant-list')
  expect(html).toContain('data-action="revoke-asset-grant"')
  expect(html).toContain('data-grant-id="grant_view_0001"')
})

test('creative plan exposes the persisted estimate before generation confirmation', () => {
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), {
    kind: 'open-panel',
    panel: 'creative-intake',
  })
  const projection = {
    project: { id: projectId, revision: 3 },
    creative_plans: [{
      id: 'creative_plan_001',
      directions: [{ id: 'direction_001', label: '主视觉' }],
    }],
  } as unknown as ImageWorkbenchProjectProjection
  const html = renderImageWorkbenchShell({
    view_state: state,
    projection,
    campaigns: [],
    generation_quote: {
      project_id: projectId,
      creative_plan_id: 'creative_plan_001',
      direction_ids: ['direction_001'],
      estimate_hash: 'a'.repeat(64),
      project_revision: 3,
      paid_operation_count: 1,
      candidate_count_per_operation: 3,
      concurrency: 1,
      price_upper_bound: {
        currency: 'USD', amount_minor: 42, per_operation_amount_minor: 42, pricing_revision: 'fixture',
        usage_upper_bound: { requests: 1, input_bytes: 0, output_images: 3 },
      },
      expires_at: '2099-08-05T12:00:00.000Z',
    },
  })

  expect(html).toContain('data-generation-estimate-form')
  expect(html).toContain('data-generation-confirm-form')
  expect(html).toContain('data-generation-confirm-plan-id')
  expect(html).toContain('付费操作')
  expect(html).toContain('USD 42')
})

test('project-owned library assets add directly while cross-project assets request a grant', async () => {
  const commands: string[] = []
  const projection = (entryProjectId: string): ImageWorkbenchProjectProjection => ({
    project: { id: projectId, revision: 3 },
    candidate_groups: [],
    canvases: [{
      canvas_id: canvasId,
      revision: 2,
      document: { artboard_id: artboardId, width: 100, height: 100, layers: [] },
    }],
    delivery_spec: undefined,
    operations: [],
    library: { project_id: projectId, entries: [{ asset_id: 'asset_001', project_id: entryProjectId }] },
    creative_plans: [],
    generation_rounds: [],
    inspiration_board: undefined,
    campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection)
  let currentProjection = projection(projectId)
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    applyCanvasCommand: async (command: { input: { command: { kind: string } } }) => {
      commands.push(command.input.command.kind)
      return ok({})
    },
    createAssetGrant: async () => {
      commands.push('grant')
      return ok({})
    },
    getProjectProjection: async () => ok(currentProjection),
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    projection?: ImageWorkbenchProjectProjection
    reuseAssetInSelectedCanvas: (assetId: string) => Promise<void>
  }
  internals.state = { ...internals.state, selected_project_id: projectId }
  internals.projection = currentProjection

  await internals.reuseAssetInSelectedCanvas('asset_001')
  expect(commands).toEqual(['add_layer'])

  commands.length = 0
  currentProjection = projection('other_project_001')
  internals.projection = currentProjection
  await internals.reuseAssetInSelectedCanvas('asset_001')
  expect(commands).toEqual(['grant', 'add_layer'])
})

test('refreshing campaigns rebuilds pending retry receipts without a DOM runtime', async () => {
  const campaign = {
    id: 'campaign_001',
    revision: 4,
    name: '恢复批量制作',
    state: 'running',
    planned_item_count: 1,
  }
  const pending = {
    item_id: 'campaign_item_001',
    attempt: 2,
    estimate_hash: 'a'.repeat(64),
    confirmation_receipt_id: 'confirmation_001',
    expires_at: '2026-08-05T12:00:00.000Z',
  }
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    listCampaigns: async () => ok({ campaigns: [campaign] }),
    getCampaign: async () => ok({ campaign, items: [], pending_retry_confirmations: [pending] }),
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })

  await shell.refreshCampaigns()

  expect(shell.snapshot().campaign_retry_receipts).toEqual([{
    campaign_id: campaign.id,
    item_id: pending.item_id,
    confirmation_receipt_id: pending.confirmation_receipt_id,
    estimate_hash: pending.estimate_hash,
  }])
})

test('candidate previews are fetched through the typed bridge and malformed preview bytes stay hidden', async () => {
  const protectedPath = `/api/images/${projectId}/candidates/${candidateId}/content`
  const projection = {
    project: { id: projectId, revision: 1 },
    candidate_groups: [{ candidates: [{ id: candidateId, candidate_index: 0, image_path: protectedPath }] }],
    canvases: [],
    operations: [],
    library: { project_id: projectId, entries: [] },
    creative_plans: [],
    generation_rounds: [],
    inspiration_board: undefined,
    campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const requested: unknown[] = []
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    getCandidatePreview: async (input: unknown) => {
      requested.push(input)
      return ok({ candidate_id: candidateId, data_url: 'data:image/webp;base64,AA==' })
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })
  const internals = shell as unknown as { state: ReturnType<typeof createImageWorkbenchViewState> }
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'select-project', project_id: projectId })
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'open-panel', panel: 'candidate-review' })

  await shell.refreshSelectedProject()

  expect(requested).toEqual([{ project_id: projectId, candidate_id: candidateId }])
  expect(root.innerHTML).toContain('src="data:image/webp;base64,AA=="')
  expect(root.innerHTML).not.toContain(protectedPath)
})

test('candidate preview bridge uses a visible-panel concurrency and count budget', async () => {
  const candidates = Array.from({ length: 20 }, (_, index) => ({
    id: `candidate_${String(index).padStart(8, '0')}`,
    candidate_index: index,
  }))
  const projection = {
    project: { id: projectId, revision: 1 },
    candidate_groups: [{ candidates }],
    canvases: [], operations: [], creative_plans: [], generation_rounds: [],
    library: { project_id: projectId, entries: [] }, inspiration_board: undefined, campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const requested: string[] = []
  let active = 0
  let maxActive = 0
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    getCandidatePreview: async (input: { candidate_id: string }) => {
      requested.push(input.candidate_id)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => queueMicrotask(resolve))
      active -= 1
      return ok({ candidate_id: input.candidate_id, data_url: 'data:image/png;base64,AA==' })
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })
  const internals = shell as unknown as { state: ReturnType<typeof createImageWorkbenchViewState> }
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'select-project', project_id: projectId })
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'open-panel', panel: 'candidate-review' })

  await shell.refreshSelectedProject()

  expect(requested).toHaveLength(12)
  expect(maxActive).toBe(3)
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'open-panel', panel: 'operation-center' })
  await shell.refreshSelectedProject()
  expect(requested).toHaveLength(12)
})

test('operation center exposes cancellation only for queued work and surfaces cancellation races', async () => {
  const queuedId = 'operation_queued'
  const runningId = 'operation_running'
  const queuedProjection = {
    project: { id: projectId, revision: 3 },
    candidate_groups: [], canvases: [], creative_plans: [], generation_rounds: [],
    library: { project_id: projectId, entries: [] }, inspiration_board: undefined, campaign_intent: null,
    operations: [{ id: queuedId, kind: 'generate', status: 'queued' }, { id: runningId, kind: 'generate', status: 'running' }],
  } as unknown as ImageWorkbenchProjectProjection
  const state = reduceImageWorkbenchViewState(createImageWorkbenchViewState(), { kind: 'open-panel', panel: 'operation-center' })
  const html = renderImageWorkbenchShell({ view_state: state, projection: queuedProjection, campaigns: [] })
  expect(html).toContain(`data-operation-id="${queuedId}"`)
  expect(html).not.toContain(`data-operation-id="${runningId}"`)

  const cancellations: unknown[] = []
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(queuedProjection),
    cancelOperation: async (input: unknown) => {
      cancellations.push(input)
      return { ok: false as const, error: { code: 'MEDIA_STATE_CONFLICT', message: '任务已开始，无法取消。' } }
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    projection?: ImageWorkbenchProjectProjection
    cancelQueuedOperation: (operationId: string) => Promise<void>
  }
  internals.state = { ...internals.state, selected_project_id: projectId }
  internals.projection = queuedProjection

  await expect(internals.cancelQueuedOperation(queuedId)).rejects.toThrow('任务已开始，无法取消。')
  expect(cancellations).toEqual([{ project_id: projectId, operation_id: queuedId }])
  await expect(internals.cancelQueuedOperation(runningId)).rejects.toThrow('IMAGE_WORKBENCH_OPERATION_CANCEL_NOT_QUEUED')
  expect(cancellations).toHaveLength(1)
})

test('shell drains paged operation events from the durable cursor and reloads projection on reset', async () => {
  const calls: Array<{ cursor: number; limit?: number; wait_ms?: number }> = []
  let projectionReads = 0
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const firstProjection = {
    project: { id: projectId, revision: 1 },
    candidate_groups: [{ candidates: [{ id: candidateId }] }],
    canvases: [],
    delivery_spec: null,
  } as unknown as ImageWorkbenchProjectProjection
  const replacementProjection = {
    project: { id: projectId, revision: 2 },
    candidate_groups: [],
    canvases: [],
    delivery_spec: null,
  } as unknown as ImageWorkbenchProjectProjection
  const client = {
    getProjectProjection: async () => ok(projectionReads++ === 0 ? firstProjection : replacementProjection),
    listOperationEvents: async (input: { cursor: number; limit?: number; wait_ms?: number }) => {
      calls.push(input)
      return ok(calls.length === 1
        ? { events: Array.from({ length: 200 }, () => ({})), cursor: 200, reset_required: false }
        : { events: [], cursor: 201, reset_required: true })
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    resumeSelectedProject: () => Promise<ImageWorkbenchProjectProjection>
  }
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'select-project', project_id: projectId })
  internals.state = reduceImageWorkbenchViewState(internals.state, { kind: 'select-candidate', candidate_id: candidateId })

  const projection = await internals.resumeSelectedProject()

  expect(calls).toEqual([
    { project_id: projectId, cursor: 0, limit: 200, wait_ms: 0 },
    { project_id: projectId, cursor: 200, limit: 200, wait_ms: 0 },
  ])
  expect(projection.project.revision).toBe(2)
  expect(shell.snapshot().view_state.event_cursors[projectId]).toBe(201)
  expect(shell.snapshot().view_state.selected_candidate_id).toBeUndefined()
  expect(projectionReads).toBe(2)
})

test('shell sends multi-artboard adoption, PNG inpaint, and canvas text through typed commands', async () => {
  const secondArtboardId = 'artboard_002'
  const calls: Array<{ kind: string; value: unknown }> = []
  const projection = {
    project: { id: projectId, revision: 7 },
    candidate_groups: [{ candidates: [{ id: candidateId }] }],
    delivery_spec: {
      id: 'delivery_001',
      revision: 1,
      artboards: [{ id: artboardId }, { id: secondArtboardId }],
    },
    canvases: [{
      canvas_id: canvasId,
      revision: 4,
      document: { artboard_id: artboardId, width: 1024, height: 768, layers: [] },
    }],
    library: { project_id: projectId, entries: [] },
    creative_plans: [],
    generation_rounds: [],
    operations: [],
    inspiration_board: undefined,
    campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    adoptCandidate: async (command: unknown) => {
      calls.push({ kind: 'adopt', value: command })
      return ok({})
    },
    estimateCandidateDerivation: async (command: unknown) => {
      calls.push({ kind: 'estimate-derive', value: command })
      return ok({
        estimate_hash: 'b'.repeat(64),
        paid_operation_count: 1,
        candidate_count_per_operation: 3,
        concurrency: 1,
        price_upper_bound: {
          currency: 'USD', amount_minor: 42, per_operation_amount_minor: 42, pricing_revision: 'fixture',
          usage_upper_bound: { requests: 1, input_bytes: 0, output_images: 3 },
        },
        expires_at: '2099-08-05T12:00:00.000Z',
      })
    },
    deriveCandidate: async (command: unknown) => {
      calls.push({ kind: 'derive', value: command })
      return ok({})
    },
    applyCanvasCommand: async (command: unknown) => {
      calls.push({ kind: 'canvas', value: command })
      return ok({})
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({
    root,
    client,
    idempotency_key_factory: () => 'image_ui_0123456789abcdef',
  })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    projection?: ImageWorkbenchProjectProjection
    adoptSelectedCandidate: (id: string, artboards: readonly string[]) => Promise<void>
    deriveSelectedCandidate: (id: string, instruction: string, kind: 'edit' | 'inpaint', mask?: string) => Promise<void>
    confirmDerivedCandidate: (id: string) => Promise<void>
    addCanvasTextLayer: (id: string, input: { text: string; x: number; y: number; font_size: number; fill: string }) => Promise<void>
  }
  internals.state = { ...internals.state, selected_project_id: projectId, selected_canvas_id: canvasId }
  internals.projection = projection

  await internals.adoptSelectedCandidate(candidateId, [artboardId, secondArtboardId])
  await internals.deriveSelectedCandidate(candidateId, '仅修改球桌区域', 'inpaint', 'data:image/png;base64,AA==')
  expect(calls).toHaveLength(2)
  await internals.confirmDerivedCandidate(candidateId)
  await internals.addCanvasTextLayer(canvasId, { text: '夏季联赛', x: 80, y: 64, font_size: 56, fill: '#101820' })

  expect(calls[0]).toMatchObject({
    kind: 'adopt',
    value: { candidate_id: candidateId, input: { adoptions: [{ artboard_id: artboardId }, { artboard_id: secondArtboardId }] } },
  })
  expect(calls[1]).toMatchObject({
    kind: 'estimate-derive',
    value: { candidate_id: candidateId, input: { kind: 'inpaint', mask_data_url: 'data:image/png;base64,AA==' } },
  })
  expect(calls[2]).toMatchObject({
    kind: 'derive',
    value: { candidate_id: candidateId, input: { kind: 'inpaint', mask_data_url: 'data:image/png;base64,AA==' } },
  })
  expect(calls[3]).toMatchObject({
    kind: 'canvas',
    value: { canvas_id: canvasId, input: { command: { kind: 'add_layer', payload: { layer: { kind: 'text', text: '夏季联赛' } } } } },
  })
})

test('shell grants a project asset before writing Brand and Template logo revisions', async () => {
  const calls: Array<{ kind: string; value: unknown }> = []
  const brandKitId = 'brand_kit_001'
  const templateId = 'template_001'
  const logoAssetId = 'logo_asset_001'
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getBrandKit: async () => ok({
      brand_kit: { id: brandKitId, revision: 2 },
      revision: { id: 'brand_revision_002', logo_asset_ids: [], font_asset_ids: [], color_tokens: {}, required_text: [] },
    }),
    getTemplate: async () => ok({
      template: { id: templateId, revision: 1 },
      revision: {
        id: 'template_revision_001',
        blueprint: { schema_version: 1, artboard: { width: 1024, height: 1024 }, background: { kind: 'solid', color: '#ffffff' }, layers: [] },
        slots: [],
        schema_version: 1,
      },
    }),
    createAssetGrant: async (command: unknown) => {
      calls.push({ kind: 'grant', value: command })
      return ok({})
    },
    reviseBrandKit: async (command: unknown) => {
      calls.push({ kind: 'revise-brand', value: command })
      return ok({})
    },
    reviseTemplate: async (command: unknown) => {
      calls.push({ kind: 'revise-template', value: command })
      return ok({})
    },
    revokeAssetGrant: async (command: unknown) => {
      calls.push({ kind: 'revoke-grant', value: command })
      return ok({})
    },
    listBrandKits: async () => ok({ brand_kits: [] }),
    listTemplates: async () => ok({ templates: [] }),
    listAssetGrants: async () => ok({ grants: [] }),
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({
    root,
    client,
    idempotency_key_factory: () => 'image_ui_0123456789abcdef',
  })
  const internals = shell as unknown as {
    reviseBrandKitFromForm: (form: HTMLFormElement) => Promise<void>
    reviseTemplateFromForm: (form: HTMLFormElement) => Promise<void>
    grantReusableAssetFromForm: (form: HTMLFormElement) => Promise<void>
    revokeAssetGrantFromButton: (grantId: string) => Promise<void>
  }
  const fieldForm = (fields: Record<string, unknown>) => ({
    querySelector: (selector: string) => fields[selector] ?? null,
  }) as unknown as HTMLFormElement

  await internals.reviseBrandKitFromForm(fieldForm({
    '[data-brand-revise-id]': { value: brandKitId },
    '[data-brand-color-token]': { value: 'primary' },
    '[data-brand-color-value]': { value: '#174c80' },
    '[data-brand-logo-asset-id]': { value: logoAssetId },
  }))
  await internals.reviseTemplateFromForm(fieldForm({
    '[data-template-revise-id]': { value: templateId },
    '[data-template-text]': { value: '' },
    '[data-template-layer-kind]': { value: 'logo' },
    '[data-template-slot-id]': { value: 'logo_mark' },
    '[data-template-slot-required]': { checked: false },
    '[data-template-logo-asset-id]': { value: logoAssetId },
  }))
  await internals.grantReusableAssetFromForm(fieldForm({
    '[data-grant-asset-id]': { value: logoAssetId },
    '[data-grant-target]': { value: `template:${templateId}` },
    '[data-grant-purpose]': { value: 'template_use' },
  }))
  await internals.revokeAssetGrantFromButton('grant_view_0001')

  expect(calls).toMatchObject([
    { kind: 'grant', value: { input: { asset_id: logoAssetId, to_owner: { kind: 'brand_kit', id: brandKitId }, purpose: 'render' } } },
    { kind: 'revise-brand', value: { brand_kit_id: brandKitId, input: { revision: { logo_asset_ids: [logoAssetId] } } } },
    { kind: 'grant', value: { input: { asset_id: logoAssetId, to_owner: { kind: 'template', id: templateId }, purpose: 'template_use' } } },
    { kind: 'revise-template', value: { template_id: templateId, input: { revision: { blueprint: { layers: [{ kind: 'logo', source_asset_id: logoAssetId }] }, slots: [{ id: 'logo_mark', kind: 'logo' }] } } } },
    { kind: 'grant', value: { input: { asset_id: logoAssetId, to_owner: { kind: 'template', id: templateId }, purpose: 'template_use' } } },
    { kind: 'revoke-grant', value: { grant_id: 'grant_view_0001', input: { idempotency_key: 'image_ui_0123456789abcdef' } } },
  ])
})

test('shell applies reusable Brand and Template revisions through the standard Canvas commands', async () => {
  const brandKitId = 'brand_kit_001'
  const templateId = 'template_001'
  const calls: unknown[] = []
  const projection = {
    project: { id: projectId, revision: 8 },
    candidate_groups: [],
    delivery_spec: null,
    canvases: [{
      canvas_id: canvasId,
      revision: 5,
      document: { artboard_id: artboardId, width: 1024, height: 768, layers: [] },
    }],
    library: { project_id: projectId, entries: [] },
    creative_plans: [],
    generation_rounds: [],
    operations: [],
    inspiration_board: undefined,
    campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    getBrandKit: async () => ok({
      brand_kit: { id: brandKitId, revision: 3 },
      revision: { id: 'brand_revision_003' },
    }),
    getTemplate: async () => ok({
      template: { id: templateId, revision: 2 },
      revision: {
        id: 'template_revision_002',
        blueprint: { schema_version: 1, artboard: { width: 1024, height: 768 }, background: { kind: 'solid', color: '#ffffff' }, layers: [] },
        slots: [{ id: 'title', layer_id: 'template_text_001', kind: 'text', required: true }],
        schema_version: 1,
      },
    }),
    applyCanvasCommand: async (command: unknown) => {
      calls.push(command)
      return ok({})
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client, idempotency_key_factory: () => 'image_ui_0123456789abcdef' })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    projection?: ImageWorkbenchProjectProjection
    applyBrandKitFromForm: (form: HTMLFormElement) => Promise<void>
    applyTemplateFromForm: (form: HTMLFormElement) => Promise<void>
  }
  internals.state = { ...internals.state, selected_project_id: projectId, selected_canvas_id: canvasId }
  internals.projection = projection
  const fieldForm = (dataset: Record<string, string>, fields: Record<string, unknown>) => ({
    dataset,
    querySelector: (selector: string) => fields[selector] ?? null,
  }) as unknown as HTMLFormElement

  await internals.applyBrandKitFromForm(fieldForm({ canvasId }, {
    '[data-apply-brand-id]': { value: brandKitId },
  }))
  await internals.applyTemplateFromForm(fieldForm({ canvasId }, {
    '[data-apply-template-id]': { value: templateId },
    '[data-apply-template-slots]': { value: '[{"slot_id":"title","text":"夏季联赛"}]' },
  }))

  expect(calls).toMatchObject([
    { canvas_id: canvasId, input: { command: { kind: 'apply_brand_kit', payload: { brand_kit_id: brandKitId, brand_kit_revision_id: 'brand_revision_003' } } } },
    { canvas_id: canvasId, input: { command: { kind: 'apply_template', payload: { template_id: templateId, template_revision_id: 'template_revision_002', slot_bindings: [{ slot_id: 'title', text: '夏季联赛' }] } } } },
  ])
})

test('shell creates a Campaign from the selected Template revision instead of requiring internal revision ids', async () => {
  const templateId = 'template_001'
  const brandKitId = 'brand_kit_001'
  const calls: unknown[] = []
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getTemplate: async () => ok({
      template: { id: templateId, revision: 4 },
      revision: {
        id: 'template_revision_004',
        brand_kit_id: brandKitId,
        brand_kit_revision_id: 'brand_revision_003',
        blueprint: { schema_version: 1, artboard: { width: 1024, height: 1024 }, background: { kind: 'solid', color: '#ffffff' }, layers: [] },
        slots: [{ id: 'title', layer_id: 'template_text_001', kind: 'text', required: true }],
        schema_version: 1,
      },
    }),
    createCampaign: async (input: unknown) => {
      calls.push(input)
      return ok({ campaign: { id: 'campaign_001' }, items: [] })
    },
    listCampaigns: async () => ok({ campaigns: [] }),
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client, idempotency_key_factory: () => 'image_ui_0123456789abcdef' })
  const internals = shell as unknown as {
    createCampaignFromForm: (form: HTMLFormElement) => Promise<void>
  }
  const form = {
    querySelector: (selector: string) => ({
      '[data-campaign-name]': { value: '夏季门店素材' },
      '[data-campaign-request]': { value: '制作夏季台球赛事宣传图' },
      '[data-campaign-preset]': { value: 'square' },
      '[data-campaign-template-id]': { value: templateId },
      '[data-campaign-brand-kit-id]': { value: '' },
      '[data-campaign-items]': { value: '[{"variable_values":[{"slot_id":"title","value":"夏季联赛"}]}]' },
    }[selector] ?? null),
  } as unknown as HTMLFormElement

  await internals.createCampaignFromForm(form)

  expect(calls).toMatchObject([{
    name: '夏季门店素材',
    template_id: templateId,
    template_revision_id: 'template_revision_004',
    brand_kit_id: brandKitId,
    brand_kit_revision_id: 'brand_revision_003',
    items: [{ variable_values: [{ slot_id: 'title', value: '夏季联赛' }] }],
  }])
})

test('canvas Shell lists layers and persists Shape, QR, transform, and drag through Canvas commands', async () => {
  const canvasLayer = {
    id: layerId,
    kind: 'shape',
    shape: 'rectangle',
    transform: { x: 20, y: 30, width: 160, height: 90, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
    fill: '#174C80',
    opacity: 1,
  }
  const projection = {
    project: { id: projectId, revision: 8 },
    candidate_groups: [],
    delivery_spec: null,
    canvases: [{
      canvas_id: canvasId,
      revision: 5,
      document: {
        project_id: projectId,
        artboard_id: artboardId,
        width: 1024,
        height: 768,
        layers: [canvasLayer],
      },
    }],
    library: { project_id: projectId, entries: [] },
    creative_plans: [],
    generation_rounds: [],
    operations: [],
    inspiration_board: undefined,
    campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const state = reduceImageWorkbenchViewState(
    reduceImageWorkbenchViewState(
      reduceImageWorkbenchViewState(createImageWorkbenchViewState(), { kind: 'select-project', project_id: projectId }),
      { kind: 'select-canvas', canvas_id: canvasId },
    ),
    { kind: 'open-panel', panel: 'canvas-editor' },
  )
  const html = renderImageWorkbenchShell({
    view_state: state,
    projection,
    campaigns: [],
    selected_canvas_layer_id: layerId,
  })
  expect(html).toContain('data-canvas-preview-id="canvas_001"')
  expect(html).toContain('最终像素以渲染结果为准')
  expect(html).toContain('data-canvas-layer-transform-form')
  expect(html).toContain('data-add-canvas-shape-form')
  expect(html).toContain('data-add-canvas-qr-form')

  const calls: unknown[] = []
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    applyCanvasCommand: async (command: unknown) => {
      calls.push(command)
      return ok({})
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client, idempotency_key_factory: () => 'image_ui_0123456789abcdef' })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    projection?: ImageWorkbenchProjectProjection
    addCanvasShapeFromForm: (form: HTMLFormElement) => Promise<void>
    addCanvasQrFromForm: (form: HTMLFormElement) => Promise<void>
    updateCanvasLayerTransformFromForm: (form: HTMLFormElement) => Promise<void>
    persistCanvasDrag: () => Promise<void>
  }
  internals.state = { ...internals.state, selected_project_id: projectId, selected_canvas_id: canvasId }
  internals.projection = projection
  const fieldForm = (dataset: Record<string, string>, fields: Record<string, unknown>) => ({
    dataset,
    querySelector: (selector: string) => fields[selector] ?? null,
  }) as unknown as HTMLFormElement

  await internals.addCanvasShapeFromForm(fieldForm({ canvasId }, {
    '[data-canvas-shape-kind]': { value: 'ellipse' },
    '[data-canvas-shape-x]': { value: '80' },
    '[data-canvas-shape-y]': { value: '90' },
    '[data-canvas-shape-width]': { value: '240' },
    '[data-canvas-shape-height]': { value: '120' },
    '[data-canvas-shape-fill]': { value: '#FFFFFF' },
  }))
  await internals.addCanvasQrFromForm(fieldForm({ canvasId }, {
    '[data-canvas-qr-payload]': { value: 'https://example.test/league' },
    '[data-canvas-qr-x]': { value: '600' },
    '[data-canvas-qr-y]': { value: '480' },
    '[data-canvas-qr-size]': { value: '160' },
    '[data-canvas-qr-error-correction]': { value: 'H' },
  }))
  await internals.updateCanvasLayerTransformFromForm(fieldForm({ canvasId, layerId }, {
    '[data-canvas-layer-x]': { value: '40' },
    '[data-canvas-layer-y]': { value: '50' },
    '[data-canvas-layer-width]': { value: '220' },
    '[data-canvas-layer-height]': { value: '110' },
    '[data-canvas-layer-rotation]': { value: '35' },
    '[data-canvas-layer-scale-x]': { value: '1.5' },
    '[data-canvas-layer-scale-y]': { value: '0.8' },
  }))
  internals.state = reduceImageWorkbenchViewState(internals.state, {
    kind: 'begin-drag',
    draft: {
      kind: 'canvas-layer', project_id: projectId, canvas_id: canvasId, layer_id: layerId,
      origin: { x: 10, y: 10 }, current: { x: 40, y: 30 },
    },
  })
  await internals.persistCanvasDrag()

  expect(calls).toMatchObject([
    { canvas_id: canvasId, input: { command: { kind: 'add_layer', payload: { layer: { kind: 'shape', shape: 'ellipse' } } } } },
    { canvas_id: canvasId, input: { command: { kind: 'add_layer', payload: { layer: { kind: 'qrcode', source: { kind: 'payload', value: 'https://example.test/league' }, error_correction: 'H' } } } } },
    { canvas_id: canvasId, input: { command: { kind: 'replace_layer', payload: { layer: { id: layerId, transform: { x: 40, y: 50, width: 220, height: 110, rotation_degrees: 35, scale_x: 1.5, scale_y: 0.8 } } } } } },
    { canvas_id: canvasId, input: { command: { kind: 'replace_layer', payload: { layer: { id: layerId, transform: { x: 50, y: 50, width: 160, height: 90, rotation_degrees: 0, scale_x: 1, scale_y: 1 } } } } } },
  ])
})

test('delivery Shell restores the durable Delivery Set and saves each artboard through an opaque grant', async () => {
  const versionId = 'version_001'
  const deliverySetId = 'delivery_set_001'
  const receipt = {
    id: 'export_receipt_001', project_id: projectId, artboard_id: artboardId, version_id: versionId,
    source_hash: `sha256:${'a'.repeat(64)}`, output_asset_id: 'output_asset_001', output_format: 'png', output_hash: `sha256:${'b'.repeat(64)}`,
    width: 1024, height: 1024, byte_size: 4096, release_check_result_id: 'release_check_001', created_at: '2026-08-05T00:00:00.000Z',
  }
  const deliverySet = {
    id: deliverySetId, project_id: projectId, delivery_spec_id: 'delivery_001', delivery_spec_revision: 2,
    version_ids_by_artboard: { [artboardId]: versionId },
    export_receipt_ids_by_artboard: { [artboardId]: receipt.id },
    created_at: '2026-08-05T00:00:00.000Z',
  }
  const projection = {
    project: {
      id: projectId, revision: 9, latest_delivery_set_id: deliverySetId,
      current_versions_by_artboard: { [artboardId]: versionId },
    },
    candidate_groups: [],
    delivery_spec: {
      id: 'delivery_001', revision: 2,
      artboards: [{ id: artboardId, label: '正式海报', width: 1024, height: 1024, output: { format: 'png', transparent: false } }],
    },
    canvases: [], library: { project_id: projectId, entries: [] }, creative_plans: [], generation_rounds: [], operations: [], inspiration_board: undefined, campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const exportCalls: unknown[] = []
  const destinationCalls: unknown[] = []
  const saveCalls: unknown[] = []
  let deliverySetReads = 0
  let receiptReads = 0
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    getDeliverySet: async () => {
      deliverySetReads += 1
      return ok({ delivery_set: deliverySet })
    },
    getExportReceipt: async (input: { export_receipt_id: string }) => {
      receiptReads += 1
      expect(input).toEqual({ project_id: projectId, export_receipt_id: receipt.id })
      return ok({ export_receipt: receipt })
    },
    exportDelivery: async (command: unknown) => {
      exportCalls.push(command)
      return ok({
        operation: { id: 'operation_export_001', status: 'succeeded' },
        export_receipts: [receipt], delivery_set: deliverySet, project_revision: 10,
      })
    },
    requestDestination: async (input: unknown) => {
      destinationCalls.push(input)
      return ok({ destination_grant_id: 'destination_grant_001', expires_at: '2026-08-05T00:05:00.000Z' })
    },
    saveOutput: async (command: unknown) => {
      saveCalls.push(command)
      return ok({
        destination_grant_id: 'destination_grant_001',
        verification: { byte_size: 4096, mime_type: 'image/png', width: 1024, height: 1024, content_hash: `sha256:${'b'.repeat(64)}`, verified_at: '2026-08-05T00:00:01.000Z' },
      })
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client, idempotency_key_factory: () => 'image_ui_0123456789abcdef' })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    projection?: ImageWorkbenchProjectProjection
    exportCurrentDelivery: () => Promise<void>
    saveExportedArtboard: (artboardId: string, versionId: string, format: 'png' | 'jpeg' | 'webp') => Promise<void>
  }
  internals.state = reduceImageWorkbenchViewState(
    reduceImageWorkbenchViewState(createImageWorkbenchViewState(), { kind: 'select-project', project_id: projectId }),
    { kind: 'open-panel', panel: 'delivery-panel' },
  )
  internals.projection = projection

  await internals.exportCurrentDelivery()
  await internals.saveExportedArtboard(artboardId, versionId, 'png')

  expect(exportCalls).toMatchObject([{
    project_id: projectId,
    input: { version_ids_by_artboard: { [artboardId]: versionId } },
  }])
  expect(destinationCalls).toEqual([{
    project_id: projectId,
    version_id: versionId,
    intent: 'save_version',
    suggested_name: '正式海报.png',
  }])
  expect(saveCalls).toEqual([{
    project_id: projectId,
    input: { version_id: versionId, destination_grant_id: 'destination_grant_001' },
  }])
  expect(JSON.stringify([...destinationCalls, ...saveCalls])).not.toContain('path')
  expect(shell.snapshot().latest_export?.saved_outputs[artboardId]?.verification.content_hash).toBe(receipt.output_hash)
  expect(root.innerHTML).toContain(receipt.output_hash)

  const restoredRoot = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const restored = new ImageWorkbenchShell({ root: restoredRoot, client })
  const restoredInternals = restored as unknown as { state: ReturnType<typeof createImageWorkbenchViewState> }
  restoredInternals.state = reduceImageWorkbenchViewState(
    reduceImageWorkbenchViewState(createImageWorkbenchViewState(), { kind: 'select-project', project_id: projectId }),
    { kind: 'open-panel', panel: 'delivery-panel' },
  )
  await restored.refreshSelectedProject()

  expect(deliverySetReads).toBeGreaterThanOrEqual(2)
  expect(receiptReads).toBeGreaterThanOrEqual(1)
  expect(restored.snapshot().latest_export).toMatchObject({
    project_id: projectId,
    delivery_set: { id: deliverySetId },
    export_receipts: [receipt],
  })
  expect(restoredRoot.innerHTML).toContain(`data-delivery-set-id="${deliverySetId}"`)
  expect(restoredRoot.innerHTML).toContain(receipt.output_hash)
  expect(restoredRoot.innerHTML).toContain(String(receipt.byte_size))
  expect(restoredRoot.innerHTML).toContain(receipt.created_at)
})

test('Canvas Shell renders only the current formal Version through Main and switches same-artboard history with a command envelope', async () => {
  const currentVersionId = 'version_canvas_current_001'
  const historicalVersionId = 'version_canvas_history_001'
  let projection = {
    project: {
      id: projectId,
      revision: 11,
      current_versions_by_artboard: { [artboardId]: currentVersionId },
      version_history: [
        {
          id: historicalVersionId, kind: 'canvas', artboard_id: artboardId, canvas_id: canvasId, canvas_revision: 1,
          asset_id: 'asset_history_001', image_path: '/api/images/projects/project_001/outputs/asset_history_001/content', mime_type: 'image/png',
          text_layers: [], image_layers: [], created_at: '2026-08-05T00:00:00.000Z',
        },
        {
          id: currentVersionId, kind: 'canvas', artboard_id: artboardId, canvas_id: canvasId, canvas_revision: 2,
          asset_id: 'asset_current_001', image_path: '/api/images/projects/project_001/outputs/asset_current_001/content', mime_type: 'image/png',
          text_layers: [], image_layers: [], created_at: '2026-08-05T00:01:00.000Z',
        },
        {
          id: 'version_other_artboard_001', kind: 'canvas', artboard_id: 'artboard_002', canvas_id: 'canvas_002', canvas_revision: 1,
          asset_id: 'asset_other_001', image_path: '/api/images/projects/project_001/outputs/asset_other_001/content', mime_type: 'image/png',
          text_layers: [], image_layers: [], created_at: '2026-08-05T00:02:00.000Z',
        },
      ],
    },
    candidate_groups: [],
    canvases: [{
      canvas_id: canvasId,
      revision: 2,
      document: {
        id: canvasId, project_id: projectId, artboard_id: artboardId,
        width: 1024, height: 1024, layers: [],
      },
    }],
    library: { project_id: projectId, entries: [] }, creative_plans: [], generation_rounds: [], operations: [], inspiration_board: undefined, campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const previewCalls: unknown[] = []
  const selectCalls: unknown[] = []
  const versionDerivationCalls: Array<{ kind: 'estimate' | 'derive'; command: unknown }> = []
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    getVersionPreview: async (input: unknown) => {
      previewCalls.push(input)
      const version = (input as { version_id: string }).version_id
      return ok({ version_id: version, data_url: 'data:image/png;base64,AA==' })
    },
    estimateVersionDerivation: async (command: unknown) => {
      versionDerivationCalls.push({ kind: 'estimate', command })
      return ok({
        estimate_hash: `sha256:${'a'.repeat(64)}`,
        paid_operation_count: 1,
        candidate_count_per_operation: 3,
        concurrency: 1,
        price_upper_bound: {
          currency: 'USD', amount_minor: 42, per_operation_amount_minor: 42, pricing_revision: 'fixture',
          usage_upper_bound: { requests: 1, input_bytes: 0, output_images: 3 },
        },
        expires_at: '2099-08-05T12:00:00.000Z',
      })
    },
    deriveVersion: async (command: unknown) => {
      versionDerivationCalls.push({ kind: 'derive', command })
      return ok({})
    },
    selectArtboardVersion: async (command: unknown) => {
      const { project_id: project, artboard_id: artboard, input } = command as {
        project_id: string
        artboard_id: string
        input: { version_id: string }
      }
      selectCalls.push({ project, artboard, input })
      projection = {
        ...projection,
        project: {
          ...projection.project,
          revision: projection.project.revision + 1,
          current_versions_by_artboard: { [artboardId]: (input as { version_id: string }).version_id },
        },
      } as ImageWorkbenchProjectProjection
      return ok({ project: projection.project })
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({
    root,
    client,
    idempotency_key_factory: () => 'image_ui_canvas_history_0123456789',
  })
  const internals = shell as unknown as {
    state: ReturnType<typeof createImageWorkbenchViewState>
    selectArtboardVersion: (artboard: string, version: string) => Promise<void>
    deriveSelectedVersion: (version: string, instruction: string, kind: 'edit' | 'inpaint', mask?: string) => Promise<void>
    confirmDerivedVersion: (version: string) => Promise<void>
  }
  internals.state = reduceImageWorkbenchViewState(
    reduceImageWorkbenchViewState(
      reduceImageWorkbenchViewState(createImageWorkbenchViewState(), { kind: 'select-project', project_id: projectId }),
      { kind: 'select-canvas', canvas_id: canvasId },
    ),
    { kind: 'open-panel', panel: 'canvas-editor' },
  )

  await shell.refreshSelectedProject()

  expect(previewCalls).toEqual([{ project_id: projectId, version_id: currentVersionId }])
  expect(root.innerHTML).toContain('data-feature="canvas-render-preview"')
  expect(root.innerHTML).toContain('data:image/png;base64,AA==')
  expect(root.innerHTML).toContain('data-feature="canvas-version-history"')
  expect(root.innerHTML).toContain('data-feature="version-derivation"')
  expect(root.innerHTML).toContain(`data-version-id="${currentVersionId}"`)
  expect(root.innerHTML).toContain(`data-version-id="${historicalVersionId}"`)
  expect(root.innerHTML).not.toContain('version_other_artboard_001')
  expect(root.innerHTML).not.toContain('/api/images/projects/project_001/versions/')

  await internals.selectArtboardVersion(artboardId, historicalVersionId)

  expect(selectCalls).toEqual([{
    project: projectId,
    artboard: artboardId,
    input: {
      idempotency_key: 'image_ui_canvas_history_0123456789',
      base_revision: 11,
      version_id: historicalVersionId,
    },
  }])
  expect(previewCalls).toEqual([
    { project_id: projectId, version_id: currentVersionId },
    { project_id: projectId, version_id: historicalVersionId },
  ])
  expect(shell.snapshot().version_previews).toEqual({
    [historicalVersionId]: 'data:image/png;base64,AA==',
  })

  await internals.deriveSelectedVersion(historicalVersionId, '只调整背景亮度', 'edit')
  expect(root.innerHTML).toContain('确认并派生')
  await internals.confirmDerivedVersion(historicalVersionId)
  await internals.deriveSelectedVersion(historicalVersionId, '只替换角落背景', 'inpaint', 'data:image/png;base64,AA==')
  await internals.confirmDerivedVersion(historicalVersionId)

  expect(versionDerivationCalls).toEqual([
    {
      kind: 'estimate',
      command: {
        project_id: projectId,
        version_id: historicalVersionId,
        input: { base_revision: 12, instruction: '只调整背景亮度', kind: 'edit' },
      },
    },
    {
      kind: 'derive',
      command: {
        project_id: projectId,
        version_id: historicalVersionId,
        input: {
          idempotency_key: 'image_ui_canvas_history_0123456789',
          base_revision: 12,
          instruction: '只调整背景亮度',
          kind: 'edit',
          estimate_hash: `sha256:${'a'.repeat(64)}`,
          confirm: true,
        },
      },
    },
    {
      kind: 'estimate',
      command: {
        project_id: projectId,
        version_id: historicalVersionId,
        input: {
          base_revision: 12,
          instruction: '只替换角落背景',
          kind: 'inpaint',
          mask_data_url: 'data:image/png;base64,AA==',
        },
      },
    },
    {
      kind: 'derive',
      command: {
        project_id: projectId,
        version_id: historicalVersionId,
        input: {
          idempotency_key: 'image_ui_canvas_history_0123456789',
          base_revision: 12,
          instruction: '只替换角落背景',
          kind: 'inpaint',
          mask_data_url: 'data:image/png;base64,AA==',
          estimate_hash: `sha256:${'a'.repeat(64)}`,
          confirm: true,
        },
      },
    },
  ])
})

test('Delivery recovery keeps the durable Delivery Set when one receipt read is temporarily unavailable', async () => {
  const firstArtboard = 'artboard_001'
  const secondArtboard = 'artboard_002'
  const successfulReceipt = {
    id: 'export_receipt_available_001', project_id: projectId, artboard_id: firstArtboard, version_id: 'version_canvas_001',
    source_hash: `sha256:${'c'.repeat(64)}`, output_asset_id: 'output_asset_available_001', output_format: 'png', output_hash: `sha256:${'d'.repeat(64)}`,
    width: 1024, height: 1024, byte_size: 2048, release_check_result_id: 'release_available_001', created_at: '2026-08-05T00:00:00.000Z',
  }
  const unavailableReceiptId = 'export_receipt_pending_002'
  const deliverySet = {
    id: 'delivery_set_partial_001', project_id: projectId, delivery_spec_id: 'delivery_001', delivery_spec_revision: 2,
    version_ids_by_artboard: { [firstArtboard]: 'version_canvas_001', [secondArtboard]: 'version_canvas_002' },
    export_receipt_ids_by_artboard: { [firstArtboard]: successfulReceipt.id, [secondArtboard]: unavailableReceiptId },
    created_at: '2026-08-05T00:00:00.000Z',
  }
  const projection = {
    project: {
      id: projectId, revision: 12, latest_delivery_set_id: deliverySet.id,
      current_versions_by_artboard: deliverySet.version_ids_by_artboard,
    },
    candidate_groups: [],
    delivery_spec: {
      id: 'delivery_001', revision: 2,
      artboards: [
        { id: firstArtboard, label: '主画板', width: 1024, height: 1024, output: { format: 'png', transparent: false } },
        { id: secondArtboard, label: '副画板', width: 1024, height: 1024, output: { format: 'png', transparent: false } },
      ],
    },
    canvases: [], library: { project_id: projectId, entries: [] }, creative_plans: [], generation_rounds: [], operations: [], inspiration_board: undefined, campaign_intent: null,
  } as unknown as ImageWorkbenchProjectProjection
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const client = {
    getProjectProjection: async () => ok(projection),
    getDeliverySet: async () => ok({ delivery_set: deliverySet }),
    getExportReceipt: async (input: { export_receipt_id: string }) => {
      if (input.export_receipt_id === successfulReceipt.id) return ok({ export_receipt: successfulReceipt })
      throw new Error('temporary receipt lookup failure')
    },
  } as unknown as ImageWorkbenchClient
  const root = { innerHTML: '', addEventListener: () => undefined } as unknown as HTMLElement
  const shell = new ImageWorkbenchShell({ root, client })
  const internals = shell as unknown as { state: ReturnType<typeof createImageWorkbenchViewState> }
  internals.state = reduceImageWorkbenchViewState(
    reduceImageWorkbenchViewState(createImageWorkbenchViewState(), { kind: 'select-project', project_id: projectId }),
    { kind: 'open-panel', panel: 'delivery-panel' },
  )

  await shell.refreshSelectedProject()

  expect(shell.snapshot().latest_export).toMatchObject({
    delivery_set: { id: deliverySet.id },
    export_receipts: [successfulReceipt],
  })
  expect(root.innerHTML).toContain(successfulReceipt.output_hash)
  expect(root.innerHTML).toContain(unavailableReceiptId)
  expect(root.innerHTML).not.toContain('如需输出哈希，请重新导出')
})
