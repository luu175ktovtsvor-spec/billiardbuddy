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
  for (const role of ['subject', 'product', 'character', 'style', 'composition', 'environment', 'brand', 'logo', 'qrcode']) {
    expect(html).toContain(`value="${role}"`)
  }
  expect(html).not.toContain('value="unclassified"')
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
