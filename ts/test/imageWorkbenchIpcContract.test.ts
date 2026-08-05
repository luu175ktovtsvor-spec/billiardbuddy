import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELECTRON_IPC_CHANNELS } from '../desktop/electron/ipc/channels.js'
import { validateElectronIpcPayload } from '../desktop/electron/ipc/capabilities.js'
import { imageWorkbenchIpcResponse } from '../desktop/electron/ipc/imageResponse.js'
import { ElectronImageActions } from '../desktop/electron/services/imageActions.js'
import { ImageDestinationGrants } from '../desktop/electron/services/imageDestinationGrants.js'
import { buildSidecarEnv } from '../desktop/electron/services/sidecarManager.js'
import { MEDIA_UI_CAPABILITY_HEADER, mediaSafeError } from '../shared/contracts/media.js'
import {
  ImageUiCapabilityReplayGuard,
  issueImageUiCapabilityTicket,
  verifyImageUiCapabilityTicket,
} from '../shared/product/imageUiCapabilityTicket.js'
import {
  imageWorkbenchIpcResponseSchemas,
  parseImageWorkbenchIpcRequest,
} from '../shared/contracts/imageWorkbenchIpc.js'
import type { ImageWorkbenchPreloadBridge } from '../shared/contracts/imageWorkbenchPreload.js'
import { createElectronImageWorkbenchClient } from '../desktop/src/image-workbench/api/imageWorkbenchClient.js'
import {
  consumeImageUiTicketSecret,
  createImageWorkbenchDomainApiHandler,
  readImageWorkbenchRequestBody,
} from '../src/server/api/imageWorkbench.js'
import { consumeMediaUiCapability } from '../src/server/api/media.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import { imageTicketHeaders } from './helpers/imageUiTicket.js'
import type {
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageArtboardSelectVersionResponse,
  ImageDestinationGrant,
  ImageDestinationGrantRequest,
  ImageExportReceipt,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
  ImageSaveOutputInput,
  ImageSaveOutputResponse,
} from '../shared/contracts/imageGeneration.js'
import { IMAGE_WORKBENCH_REQUEST_BODY_MAX_BYTES } from '../shared/contracts/imageWorkflow.js'

const projectId = 'img_00000001'
const versionId = 'ver_00000001'
const capability = '0123456789abcdef0123456789abcdef'
type ImageCommandResponse =
  | ImageCandidateAdoptionResponse
  | ImageCandidateDecisionResponse
  | ImageCandidateDerivationResponse
  | ImageCreativePlanResponse
  | ImageGenerationRoundResponse
  | ImageReferenceControlResponse

test('15.4 image IPC validators expose every shared typed image command', () => {
  const imageChannels = [
    ELECTRON_IPC_CHANNELS.imageSubmitProject,
    ELECTRON_IPC_CHANNELS.imageStartOperation,
    ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject,
    ELECTRON_IPC_CHANNELS.imageSaveOutput,
    ELECTRON_IPC_CHANNELS.imageRequestDestination,
    ELECTRON_IPC_CHANNELS.imageCreateCreativePlan,
    ELECTRON_IPC_CHANNELS.imageUnderstandProject,
    ELECTRON_IPC_CHANNELS.imageEstimateGenerationRound,
    ELECTRON_IPC_CHANNELS.imageEstimateDerivation,
    ELECTRON_IPC_CHANNELS.imageCreateGenerationRound,
    ELECTRON_IPC_CHANNELS.imageDecideCandidate,
    ELECTRON_IPC_CHANNELS.imageAssessCandidateVisual,
    ELECTRON_IPC_CHANNELS.imageAssessVersionVisual,
    ELECTRON_IPC_CHANNELS.imageAdoptCandidate,
    ELECTRON_IPC_CHANNELS.imageDeriveCandidate,
    ELECTRON_IPC_CHANNELS.imageCancelGenerationOperation,
    ELECTRON_IPC_CHANNELS.imageUpdateReferenceControl,
    ELECTRON_IPC_CHANNELS.imageCreateDeliverySpecRevision,
    ELECTRON_IPC_CHANNELS.imageCreateCanvas,
    ELECTRON_IPC_CHANNELS.imageApplyCanvasCommand,
    ELECTRON_IPC_CHANNELS.imagePreflightCanvas,
    ELECTRON_IPC_CHANNELS.imageRenderCanvas,
    ELECTRON_IPC_CHANNELS.imageExportDelivery,
    ELECTRON_IPC_CHANNELS.imageSelectArtboardVersion,
  ]
  expect(imageChannels).toEqual([
    'desktop:image:submit-project',
    'desktop:image:start-operation',
    'desktop:image:update-unknown-project',
    'desktop:image:save-output',
    'desktop:image:request-destination',
    'desktop:image:create-creative-plan',
    'desktop:image:understand-project',
    'desktop:image:estimate-generation-round',
    'desktop:image:estimate-derivation',
    'desktop:image:create-generation-round',
    'desktop:image:decide-candidate',
    'desktop:image:assess-candidate-visual',
    'desktop:image:assess-version-visual',
    'desktop:image:adopt-candidate',
    'desktop:image:derive-candidate',
    'desktop:image:cancel-generation-operation',
    'desktop:image:update-reference-control',
    'desktop:image:create-delivery-spec-revision',
    'desktop:image:create-canvas',
    'desktop:image:apply-canvas-command',
    'desktop:image:preflight-canvas',
    'desktop:image:render-canvas',
    'desktop:image:export-delivery',
    'desktop:image:select-artboard-version',
  ])
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSubmitProject, {
    projectId,
    confirmUnknownRetry: false,
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSubmitProject, {
    projectId,
    confirmUnknownRetry: false,
    actor: 'forged-owner',
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSaveOutput, {
    projectId,
    input: { version_id: versionId, output_path: '' },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageRequestDestination, {
    project_id: projectId,
    version_id: versionId,
    intent: 'save_version',
    suggested_name: 'delivery.png',
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageRequestDestination, {
    project_id: projectId,
    version_id: versionId,
    intent: 'save_version',
    suggested_name: 'delivery.png',
    destination_path: '/forged/renderer-path.png',
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageStartOperation, {
    projectId,
    input: {
      revision: 0,
      base_version_id: versionId,
      kind: 'edit',
      instruction: '仅用于完整 Preload 类型合同的编辑请求',
      confirm_unknown_retry: false,
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageStartOperation, {
    projectId,
    input: {
      revision: 0,
      base_version_id: versionId,
      kind: 'edit',
      instruction: '不得绕过共享输入 schema',
      confirm_unknown_retry: false,
      actor: 'forged-owner',
    },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject, {
    projectId,
    input: {
      revision: 0,
      user_request: '重新确认图片工作台请求',
      size: '1024x1024',
      confirm_unknown_retry: true,
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageCreateGenerationRound, {
    projectId,
    input: {
      base_revision: 0,
      idempotency_key: 'bb-image-ipc-generation-round-0001',
      creative_plan_id: 'plan_00000001',
      direction_ids: ['dir_00000001'],
      estimate_hash: `sha256:${'a'.repeat(64)}`,
      confirm: true,
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageUnderstandProject, {
    projectId,
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-qwen-understanding-0001' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageUnderstandProject, {
    projectId,
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-qwen-understanding-0001', forged: true },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageAssessCandidateVisual, {
    projectId,
    candidateId: 'cand_00000001',
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-qwen-assessment-0001' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageAssessVersionVisual, {
    projectId,
    versionId,
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-qwen-version-assessment-0001' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageEstimateDerivation, {
    projectId,
    candidateId: 'cand_00000001',
    input: { base_revision: 0, instruction: '只修改背景光线' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageDeriveCandidate, {
    projectId,
    candidateId: 'cand_00000001',
    input: {
      base_revision: 0,
      idempotency_key: 'bb-image-ipc-derivation-0001',
      instruction: '只修改背景光线',
      estimate_hash: `sha256:${'b'.repeat(64)}`,
      confirm: true,
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageDeriveCandidate, {
    projectId,
    candidateId: 'cand_00000001',
    input: {
      base_revision: 0,
      idempotency_key: 'bb-image-ipc-derivation-0001',
      instruction: '只修改背景光线',
    },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageAdoptCandidate, {
    projectId,
    candidateId: 'cand_00000001',
    input: {
      base_revision: 1,
      idempotency_key: 'bb-image-ipc-adoption-0001',
      adoptions: [{ artboard_id: 'art_00000001', placement: { fit: 'cover', focus_x: 0.5, focus_y: 0.5 } }],
      actor: 'forged-owner',
    },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageCreateCanvas, {
    projectId,
    input: { artboard_id: 'art_00000001', base_revision: 0, idempotency_key: 'bb-image-ipc-canvas-create-0001' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageApplyCanvasCommand, {
    projectId,
    canvasId: 'canvas_00000001',
    input: {
      base_project_revision: 0,
      command: {
        idempotency_key: 'bb-image-ipc-canvas-command-0001', base_revision: 0, kind: 'add_layer',
        payload: { layer: { id: 'shape_00000001', kind: 'shape', shape: 'rectangle', transform: { x: 0, y: 0, width: 100, height: 100, rotation_degrees: 0, scale_x: 1, scale_y: 1 }, fill: '#ffffff', opacity: 1 } },
      },
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageRenderCanvas, {
    projectId, canvasId: 'canvas_00000001',
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-canvas-render-0001', canvas_revision: 0, activate_on_success: true },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageExportDelivery, {
    projectId,
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-export-0001', version_ids_by_artboard: { art_00000001: versionId } },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSelectArtboardVersion, {
    projectId, artboardId: 'art_00000001',
    input: { base_revision: 0, idempotency_key: 'bb-image-ipc-select-artboard-0001', version_id: versionId },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageRenderCanvas, {
    projectId, canvasId: 'canvas_00000001', input: { base_revision: 0, idempotency_key: 'short', canvas_revision: 0, activate_on_success: true },
  })).toBeFalse()
})

test('15.5 image workbench bridge validates method payloads and response schemas', () => {
  const channel = ELECTRON_IPC_CHANNELS.imageWorkbenchInvoke
  expect(channel).toBe('desktop:image-workbench:invoke')
  expect(validateElectronIpcPayload(channel, { method: 'listProjects', payload: {} })).toBeTrue()
  expect(validateElectronIpcPayload(channel, { method: 'listProjects', payload: { forged: true } })).toBeFalse()
  expect(validateElectronIpcPayload(channel, {
    method: 'getProjectProjection',
    payload: { projectId },
  })).toBeTrue()
  expect(validateElectronIpcPayload(channel, {
    method: 'getProjectProjection',
    payload: { projectId, actor: 'forged-owner' },
  })).toBeFalse()
  expect(validateElectronIpcPayload(channel, {
    method: 'getVersionPreview',
    payload: { projectId, versionId },
  })).toBeTrue()
  expect(validateElectronIpcPayload(channel, {
    method: 'getVersionPreview',
    payload: { projectId, versionId, path: '/api/images/forged' },
  })).toBeFalse()
  expect(validateElectronIpcPayload(channel, {
    method: 'estimateVersionDerivation',
    payload: {
      projectId,
      versionId,
      input: { base_revision: 4, instruction: '只调整背景亮度', kind: 'edit' },
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(channel, {
    method: 'deriveVersion',
    payload: {
      projectId,
      versionId,
      input: {
        base_revision: 4,
        idempotency_key: 'bb-image-ipc-version-derive-0001',
        instruction: '只调整背景亮度',
        kind: 'edit',
        estimate_hash: `sha256:${'a'.repeat(64)}`,
        confirm: true,
        candidate_id: 'forged-candidate-source',
      },
    },
  })).toBeFalse()
  expect(validateElectronIpcPayload(channel, {
    method: 'getExportReceipt',
    payload: { projectId, receiptId: 'export_receipt_00000001' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(channel, {
    method: 'getExportReceipt',
    payload: { projectId, receiptId: 'export_receipt_00000001', rawReceipt: true },
  })).toBeFalse()
  expect(validateElectronIpcPayload(channel, {
    method: 'quickCreate',
    payload: {
      input: {
        idempotency_key: 'bb-image-ipc-quick-create-0001',
        prompt: '一张桌球馆海报',
        output_preset: 'square',
        reference_inputs: [],
        brief_overrides: {
          confirmed_facts: ['场馆地址以用户确认为准'],
          must_preserve: ['赛事主题'],
          may_change: ['背景配色'],
          exact_text: ['夏季冠军赛'],
        },
      },
    },
  })).toBeTrue()
  expect(validateElectronIpcPayload(channel, {
    method: 'quickCreate',
    payload: {
      input: {
        idempotency_key: 'bb-image-ipc-quick-create-0001',
        prompt: '一张桌球馆海报',
        output_preset: 'square',
        reference_inputs: [],
        actor: 'forged-owner',
      },
    },
  })).toBeFalse()
  expect(() => parseImageWorkbenchIpcRequest({ method: 'listProjects', payload: {} })).not.toThrow()
  expect(() => parseImageWorkbenchIpcRequest({ method: 'listProjects', payload: { forged: true } })).toThrow()
  expect(imageWorkbenchIpcResponseSchemas.getCandidatePreview.safeParse({
    candidate_id: 'cand_00000001',
    data_url: 'data:image/png;base64,AA==',
  }).success).toBeTrue()
  expect(imageWorkbenchIpcResponseSchemas.getCandidatePreview.safeParse({
    candidate_id: 'cand_00000001',
    data_url: 'https://server.example/candidate.png',
  }).success).toBeFalse()
  expect(imageWorkbenchIpcResponseSchemas.getVersionPreview.safeParse({
    version_id: versionId,
    data_url: 'data:image/png;base64,AA==',
  }).success).toBeTrue()
  expect(imageWorkbenchIpcResponseSchemas.getVersionPreview.safeParse({
    version_id: versionId,
    data_url: 'https://server.example/version.png',
  }).success).toBeFalse()
  expect(imageWorkbenchIpcResponseSchemas.getExportReceipt.safeParse({
    export_receipt: {
      id: 'export_receipt_00000001', project_id: projectId, artboard_id: 'art_00000001', version_id: versionId,
      source_hash: `sha256:${'a'.repeat(64)}`, output_asset_id: 'asset_00000001', output_format: 'png', output_hash: `sha256:${'b'.repeat(64)}`,
      width: 1024, height: 1024, byte_size: 1024, release_check_result_id: 'release_00000001', created_at: '2026-08-05T00:00:00.000Z',
    },
  }).success).toBeTrue()
})

test('15.5 Main validates bounded Version pixels and durable export receipts for typed workbench reads', async () => {
  const previewBytes = Buffer.from('verified-version-preview')
  const previewHash = `sha256:${createHash('sha256').update(previewBytes).digest('hex')}`
  const requests: Array<{ url: URL; headers: Headers }> = []
  const receipt = {
    id: 'export_receipt_00000001', project_id: projectId, artboard_id: 'art_00000001', version_id: versionId,
    source_hash: `sha256:${'a'.repeat(64)}`, output_asset_id: 'asset_00000001', output_format: 'png' as const, output_hash: `sha256:${'b'.repeat(64)}`,
    width: 1024, height: 1024, byte_size: 1024, release_check_result_id: 'release_00000001', created_at: '2026-08-05T00:00:00.000Z',
  }
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    ticketSecret: capability,
    fetchImpl: async (input, init) => {
      const url = new URL(input.toString())
      requests.push({ url, headers: new Headers(init?.headers) })
      if (url.pathname.endsWith('/versions/ver_00000002/content')) {
        return new Response(previewBytes, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(8 * 1024 * 1024 + 1),
            'X-BilliardBuddy-Media-Hash': previewHash,
            'X-BilliardBuddy-Media-Width': '1024',
            'X-BilliardBuddy-Media-Height': '1024',
          },
        })
      }
      if (url.pathname.endsWith('/versions/' + versionId + '/content')) {
        return new Response(previewBytes, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(previewBytes.byteLength),
            'X-BilliardBuddy-Media-Hash': previewHash,
            'X-BilliardBuddy-Media-Width': '1024',
            'X-BilliardBuddy-Media-Height': '1024',
          },
        })
      }
      if (url.pathname.endsWith('/export-receipts/export_receipt_00000001')) {
        return Response.json({ export_receipt: receipt })
      }
      return Response.json({ error: 'MEDIA_NOT_FOUND', message: 'not found' }, { status: 404 })
    },
  })

  const preview = await actions.invokeWorkbench(parseImageWorkbenchIpcRequest({
    method: 'getVersionPreview',
    payload: { projectId, versionId },
  }))
  const persistedReceipt = await actions.invokeWorkbench(parseImageWorkbenchIpcRequest({
    method: 'getExportReceipt',
    payload: { projectId, receiptId: receipt.id },
  }))
  await expect(actions.invokeWorkbench(parseImageWorkbenchIpcRequest({
    method: 'getVersionPreview',
    payload: { projectId, versionId: 'ver_00000002' },
  }))).rejects.toMatchObject({ code: 'MEDIA_RESOURCE_UNAVAILABLE' })

  expect(preview).toEqual({
    version_id: versionId,
    data_url: `data:image/png;base64,${previewBytes.toString('base64')}`,
  })
  expect(persistedReceipt).toEqual({ export_receipt: receipt })
  expect(requests.map(request => request.url.pathname)).toEqual([
    `/api/images/projects/${projectId}/versions/${versionId}/content`,
    `/api/images/projects/${projectId}/export-receipts/${receipt.id}`,
    `/api/images/projects/${projectId}/versions/ver_00000002/content`,
  ])
  for (const request of requests) {
    const ticket = request.headers.get(MEDIA_UI_CAPABILITY_HEADER)
    expect(ticket).toStartWith('bbimg1.')
    expect(verifyImageUiCapabilityTicket(capability, ticket!, {
      method: 'GET',
      url: request.url,
      body: '',
      range: request.headers.get('range'),
    }, new ImageUiCapabilityReplayGuard())).not.toBeNull()
  }
})

test('15.5 renderer adapter maps project and Campaign commands to typed Preload inputs', async () => {
  const calls: Array<{ method: string; value: unknown }> = []
  const ok = <Value>(value: Value) => Promise.resolve({ ok: true as const, value })
  const bridge = {
    getProjectProjection: async (projectId: string) => {
      calls.push({ method: 'getProjectProjection', value: projectId })
      return ok({})
    },
    listCampaigns: async (input?: { cursor?: number; limit?: number }) => {
      calls.push({ method: 'listCampaigns', value: input })
      return ok({ campaigns: [] })
    },
    createCampaign: async (input: unknown) => {
      calls.push({ method: 'createCampaign', value: input })
      return ok({})
    },
  } as unknown as ImageWorkbenchPreloadBridge
  const client = createElectronImageWorkbenchClient(bridge)
  await client.getProjectProjection({ project_id: projectId })
  await client.listCampaigns({ cursor: 20, limit: 10 })
  await client.createCampaign({
    idempotency_key: 'bb-image-adapter-campaign-0001',
    name: '适配器回归',
    shared_brief: { user_request: '海报', confirmed_facts: [], must_preserve: [] },
    output_preset: 'square',
    items: [{ variable_values: [] }],
  })
  expect(calls).toEqual([
    { method: 'getProjectProjection', value: projectId },
    { method: 'listCampaigns', value: { cursor: 20, limit: 10 } },
    {
      method: 'createCampaign',
      value: {
        idempotency_key: 'bb-image-adapter-campaign-0001',
        name: '适配器回归',
        shared_brief: { user_request: '海报', confirmed_facts: [], must_preserve: [] },
        output_preset: 'square',
        items: [{ variable_values: [] }],
      },
    },
  ])
})

test('15.5 renderer adapter maps Version preview, derivation, receipt recovery and Artboard history selection to typed Preload inputs', async () => {
  const calls: Array<{ method: string; value: unknown }> = []
  const receipt: ImageExportReceipt = {
    id: 'export_receipt_00000001', project_id: projectId, artboard_id: 'art_00000001', version_id: versionId,
    source_hash: `sha256:${'a'.repeat(64)}`, output_asset_id: 'asset_00000001', output_format: 'png', output_hash: `sha256:${'b'.repeat(64)}`,
    width: 1024, height: 1024, byte_size: 1024, release_check_result_id: 'release_00000001', created_at: '2026-08-05T00:00:00.000Z',
  }
  const bridge = {
    getVersionPreview: async (input: { projectId: string; versionId: string }) => {
      calls.push({ method: 'getVersionPreview', value: input })
      return { ok: true as const, value: { version_id: input.versionId, data_url: 'data:image/png;base64,AA==' } }
    },
    estimateVersionDerivation: async (project: string, version: string, input: unknown) => {
      calls.push({ method: 'estimateVersionDerivation', value: { project, version, input } })
      return { ok: true as const, value: {} as unknown as ImageDerivationEstimateResponse }
    },
    deriveVersion: async (project: string, version: string, input: unknown) => {
      calls.push({ method: 'deriveVersion', value: { project, version, input } })
      return { ok: true as const, value: {} as unknown as ImageCandidateDerivationResponse }
    },
    getExportReceipt: async (input: { projectId: string; receiptId: string }) => {
      calls.push({ method: 'getExportReceipt', value: input })
      return { ok: true as const, value: { export_receipt: receipt } }
    },
    selectArtboardVersion: async (project: string, artboard: string, input: unknown) => {
      calls.push({ method: 'selectArtboardVersion', value: { project, artboard, input } })
      return { ok: true as const, value: { project: {} } as unknown as ImageArtboardSelectVersionResponse }
    },
  } satisfies Pick<ImageWorkbenchPreloadBridge, 'getVersionPreview' | 'estimateVersionDerivation' | 'deriveVersion' | 'getExportReceipt' | 'selectArtboardVersion'>
  const client = createElectronImageWorkbenchClient(bridge as ImageWorkbenchPreloadBridge)

  await client.getVersionPreview({ project_id: projectId, version_id: versionId })
  await client.estimateVersionDerivation({
    project_id: projectId,
    version_id: versionId,
    input: { base_revision: 4, instruction: '只调整背景亮度', kind: 'edit' },
  })
  await client.deriveVersion({
    project_id: projectId,
    version_id: versionId,
    input: {
      base_revision: 4,
      idempotency_key: 'bb-image-ipc-version-derive-0001',
      instruction: '只调整背景亮度',
      kind: 'edit',
      estimate_hash: `sha256:${'c'.repeat(64)}`,
      confirm: true,
    },
  })
  await client.getExportReceipt({ project_id: projectId, export_receipt_id: receipt.id })
  await client.selectArtboardVersion({
    project_id: projectId,
    artboard_id: receipt.artboard_id,
    input: {
      base_revision: 4,
      idempotency_key: 'bb-image-ipc-select-history-0001',
      version_id: versionId,
    },
  })

  expect(calls).toEqual([
    { method: 'getVersionPreview', value: { projectId, versionId } },
    {
      method: 'estimateVersionDerivation',
      value: {
        project: projectId,
        version: versionId,
        input: { base_revision: 4, instruction: '只调整背景亮度', kind: 'edit' },
      },
    },
    {
      method: 'deriveVersion',
      value: {
        project: projectId,
        version: versionId,
        input: {
          base_revision: 4,
          idempotency_key: 'bb-image-ipc-version-derive-0001',
          instruction: '只调整背景亮度',
          kind: 'edit',
          estimate_hash: `sha256:${'c'.repeat(64)}`,
          confirm: true,
        },
      },
    },
    { method: 'getExportReceipt', value: { projectId, receiptId: receipt.id } },
    {
      method: 'selectArtboardVersion',
      value: {
        project: projectId,
        artboard: receipt.artboard_id,
        input: {
          base_revision: 4,
          idempotency_key: 'bb-image-ipc-select-history-0001',
          version_id: versionId,
        },
      },
    },
  ])
})

test('15.5 renderer adapter keeps destination grant and save-output payloads typed', async () => {
  type FileOutputCall =
    | { method: 'requestDestination'; input: ImageDestinationGrantRequest }
    | { method: 'saveOutput'; projectId: string; input: ImageSaveOutputInput }

  const calls: FileOutputCall[] = []
  const destination: ImageDestinationGrant = {
    destination_grant_id: 'dgr_00000001',
    expires_at: '2026-08-05T00:05:00.000Z',
  }
  const saved: ImageSaveOutputResponse = {
    destination_grant_id: destination.destination_grant_id,
    verification: {
      byte_size: 1024,
      mime_type: 'image/png',
      width: 1024,
      height: 1024,
      content_hash: `sha256:${'f'.repeat(64)}`,
      verified_at: '2026-08-05T00:00:00.000Z',
    },
  }
  const bridge = {
    requestDestination: async (input: ImageDestinationGrantRequest) => {
      calls.push({ method: 'requestDestination', input })
      return { ok: true as const, value: destination }
    },
    saveOutput: async (projectId: string, input: ImageSaveOutputInput) => {
      calls.push({ method: 'saveOutput', projectId, input })
      return { ok: true as const, value: saved }
    },
  } satisfies Pick<ImageWorkbenchPreloadBridge, 'requestDestination' | 'saveOutput'>
  const client = createElectronImageWorkbenchClient(bridge as ImageWorkbenchPreloadBridge)

  const requested = await client.requestDestination({
    project_id: projectId,
    version_id: versionId,
    intent: 'save_version',
    suggested_name: 'final-artboard.png',
  })
  const savedOutput = await client.saveOutput({
    project_id: projectId,
    input: {
      version_id: versionId,
      destination_grant_id: destination.destination_grant_id,
    },
  })

  expect(requested).toEqual({ ok: true, value: destination })
  expect(savedOutput).toEqual({ ok: true, value: saved })
  expect(calls).toEqual([
    {
      method: 'requestDestination',
      input: {
        project_id: projectId,
        version_id: versionId,
        intent: 'save_version',
        suggested_name: 'final-artboard.png',
      },
    },
    {
      method: 'saveOutput',
      projectId,
      input: {
        version_id: versionId,
        destination_grant_id: destination.destination_grant_id,
      },
    },
  ])
})

test('15.3 opaque destination grant binds a one-shot native choice to sender, Project and Version', () => {
  const grants = new ImageDestinationGrants()
  const subject = { senderId: 42, projectId, versionId }
  const issued = grants.issue('/private/user-selected-output.png', subject, 1_000)
  expect(issued.destination_grant_id).toMatch(/^dgr_/)
  expect(JSON.stringify(issued)).not.toContain('/private/user-selected-output.png')
  expect(grants.consume(issued.destination_grant_id, subject, 1_001)).toBe('/private/user-selected-output.png')
  expect(grants.consume(issued.destination_grant_id, subject, 1_002)).toBeNull()

  const mismatch = grants.issue('/private/mismatch.png', subject, 1_000)
  expect(grants.consume(mismatch.destination_grant_id, { ...subject, senderId: 43 }, 1_001)).toBeNull()
  // A mismatched request is terminal: an untrusted sender cannot leave the
  // opaque capability live and let a later request retry it.
  expect(grants.consume(mismatch.destination_grant_id, subject, 1_002)).toBeNull()

  const expired = grants.issue('/private/expired.png', subject, 1_000)
  expect(grants.consume(expired.destination_grant_id, subject, 1_000 + 5 * 60_000 + 1)).toBeNull()
})

test('15.5 image API accepts only a short-lived exact-request Main ticket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billiardbuddy-image-ticket-api-'))
  const legacyMediaRoot = await mkdtemp(join(tmpdir(), 'billiardbuddy-image-ticket-api-legacy-'))
  const service = new ImageWorkbenchService({ root, legacyMediaRoot })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  const projectsUrl = new URL('http://127.0.0.1:3456/api/images/projects')
  const body = JSON.stringify({
    title: '票据安全回归',
    user_request: '验证桌面图片操作的短期签名票据',
    size: '1024x1024',
    reference_images: [],
    reference_roles: [],
  })
  const invoke = async (request: Request, url = new URL(request.url)) => await handler(
    request,
    url,
    url.pathname.split('/').filter(Boolean),
  )
  const signedHeaders = (url: URL, signedBody = body) => imageTicketHeaders(capability, url, {
    method: 'POST',
    body: signedBody,
    headers: { 'Content-Type': 'application/json' },
  })
  const signedRequest = (url: URL, signedBody = body, actualBody = signedBody, headers = signedHeaders(url, signedBody)) => new Request(url, {
    method: 'POST',
    headers,
    body: actualBody,
  })
  const expectDenied = async (request: Request, url = new URL(request.url)) => {
    const response = await invoke(request, url)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'MEDIA_ACTION_NOT_ALLOWED' })
  }

  try {
    const publicList = await invoke(new Request(projectsUrl))
    expect(publicList.status).toBe(200)

    await expectDenied(new Request(projectsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: projectsUrl.origin,
        [MEDIA_UI_CAPABILITY_HEADER]: capability,
      },
      body,
    }))

    const replayHeaders = signedHeaders(projectsUrl)
    const first = await invoke(signedRequest(projectsUrl, body, body, replayHeaders))
    expect(first.status).toBe(201)
    await expectDenied(signedRequest(projectsUrl, body, body, replayHeaders))

    await expectDenied(signedRequest(projectsUrl, body, `${body} `))

    const changedPath = new URL('http://127.0.0.1:3456/api/images/quick-create')
    await expectDenied(signedRequest(changedPath, body, body, signedHeaders(projectsUrl)), changedPath)

    const changedQuery = new URL('http://127.0.0.1:3456/api/images/projects?cursor=1')
    await expectDenied(signedRequest(changedQuery, body, body, signedHeaders(projectsUrl)), changedQuery)

    const rangedHeaders = signedHeaders(projectsUrl)
    rangedHeaders.set('Range', 'bytes=0-1')
    await expectDenied(signedRequest(projectsUrl, body, body, rangedHeaders))

    const hostTicketUrl = new URL('http://localhost:3456/api/images/projects')
    await expectDenied(signedRequest(projectsUrl, body, body, signedHeaders(hostTicketUrl)))

    const wrongOriginHeaders = signedHeaders(projectsUrl)
    wrongOriginHeaders.set('Origin', 'http://localhost:3456')
    await expectDenied(signedRequest(projectsUrl, body, body, wrongOriginHeaders))

    const expiredHeaders = new Headers({
      'Content-Type': 'application/json',
      Origin: projectsUrl.origin,
      [MEDIA_UI_CAPABILITY_HEADER]: issueImageUiCapabilityTicket(capability, {
        method: 'POST', url: projectsUrl, body,
      }, { now: 0 }),
    })
    await expectDenied(signedRequest(projectsUrl, body, body, expiredHeaders))

    const invalidSignatureHeaders = signedHeaders(projectsUrl)
    const validTicket = invalidSignatureHeaders.get(MEDIA_UI_CAPABILITY_HEADER)!
    invalidSignatureHeaders.set(MEDIA_UI_CAPABILITY_HEADER, `${validTicket.slice(0, -1)}${validTicket.endsWith('a') ? 'b' : 'a'}`)
    await expectDenied(signedRequest(projectsUrl, body, body, invalidSignatureHeaders))
  } finally {
    service.repository.close()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(legacyMediaRoot, { recursive: true, force: true }),
    ])
  }
})

test('image Sidecar bounds streamed JSON before materializing text and rejects declared oversize Base64 bodies without reading them', async () => {
  let streamCancelled = false
  let streamedChunks = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      streamedChunks += 1
      if (streamedChunks === 1) controller.enqueue(new TextEncoder().encode('abc'))
      else controller.enqueue(new TextEncoder().encode('d'))
    },
    cancel() { streamCancelled = true },
  })
  await expect(readImageWorkbenchRequestBody(new Request('http://127.0.0.1:3456/api/images/projects', {
    method: 'POST', body: stream,
  }), 3)).rejects.toMatchObject({ statusCode: 413, code: 'IMAGE_REQUEST_BODY_TOO_LARGE' })
  expect(streamedChunks).toBe(2)
  expect(streamCancelled).toBeTrue()

  const root = await mkdtemp(join(tmpdir(), 'billiardbuddy-image-body-limit-'))
  const legacyMediaRoot = await mkdtemp(join(tmpdir(), 'billiardbuddy-image-body-limit-legacy-'))
  const service = new ImageWorkbenchService({ root, legacyMediaRoot })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  const url = new URL('http://127.0.0.1:3456/api/images/projects')
  let inboundBodyPulled = 0
  const inboundBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      inboundBodyPulled += 1
      controller.enqueue(new Uint8Array([123]))
    },
  })
  try {
    const initialized = await handler(new Request(url), url, url.pathname.split('/').filter(Boolean))
    expect(initialized.status).toBe(200)
    const oversizeRequest = new Request(url, {
      method: 'POST',
      headers: {
        Origin: url.origin,
        [MEDIA_UI_CAPABILITY_HEADER]: 'bbimg1.not-a-valid-ticket',
        'Content-Length': String(IMAGE_WORKBENCH_REQUEST_BODY_MAX_BYTES + 1),
      },
      body: inboundBody,
    })
    const pullsBeforeSidecar = inboundBodyPulled
    const response = await handler(oversizeRequest, url, url.pathname.split('/').filter(Boolean))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({
      error: 'MEDIA_IMAGE_INPUT_TOO_LARGE',
      message: mediaSafeError('MEDIA_IMAGE_INPUT_TOO_LARGE').message,
    })
    expect(inboundBodyPulled).toBe(pullsBeforeSidecar)
  } finally {
    service.repository.close()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(legacyMediaRoot, { recursive: true, force: true }),
    ])
  }
})

test('image ticket secret is a distinct trusted sidecar input and cannot consume video or generic media capability', () => {
  const trusted = buildSidecarEnv({
    BB_IMAGE_UI_TICKET_SECRET: 'forged-image-ticket-secret',
    BB_MEDIA_UI_CAPABILITY: 'forged-media-capability',
    UNRELATED_PROVIDER_SECRET: 'must-be-stripped',
  }, {
    BB_IMAGE_UI_TICKET_SECRET: capability,
    BB_MEDIA_UI_CAPABILITY: 'generic-video-media-capability-0123456789',
  })
  expect(trusted.BB_IMAGE_UI_TICKET_SECRET).toBe(capability)
  expect(trusted.BB_MEDIA_UI_CAPABILITY).toBe('generic-video-media-capability-0123456789')
  expect(trusted.UNRELATED_PROVIDER_SECRET).toBeUndefined()

  const sidecarEnv = { ...trusted }
  expect(consumeImageUiTicketSecret(sidecarEnv)).toBe(capability)
  expect(sidecarEnv.BB_IMAGE_UI_TICKET_SECRET).toBeUndefined()
  expect(sidecarEnv.BB_MEDIA_UI_CAPABILITY).toBe('generic-video-media-capability-0123456789')
  expect(consumeMediaUiCapability(sidecarEnv)).toBe('generic-video-media-capability-0123456789')
})

test('current Main-only image action bridge signs fixed image action entrypoints with a verifiable ticket', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const timestamp = '2026-08-03T00:00:00.000Z'
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    ticketSecret: capability,
    fetchImpl: async (input, init) => {
      requests.push({ url: input.toString(), init })
      const pathname = new URL(input.toString()).pathname
      if (pathname.endsWith('/derivations/estimate')) {
        return Response.json({
          estimate_hash: `sha256:${'c'.repeat(64)}`,
          paid_operation_count: 1,
          candidate_count_per_operation: 3,
          concurrency: 1,
          price_upper_bound: {
            currency: 'USD', amount_minor: 42, per_operation_amount_minor: 42, pricing_revision: 'test-price-v1',
            usage_upper_bound: { requests: 1, input_bytes: 0, output_images: 3 },
          },
          expires_at: '2026-08-03T00:05:00.000Z',
        })
      }
      if (pathname.endsWith('/decisions')) {
        return Response.json({
          decision: {
            id: 'adopt_00000001',
            project_id: projectId,
            candidate_id: 'cand_00000001',
            decision: 'kept',
            actor: { kind: 'standalone', owner_id: 'local_workbench' },
            idempotency_key: 'bb-image-ipc-decision-0001',
            request_hash: `sha256:${'d'.repeat(64)}`,
            created_at: timestamp,
          },
        })
      }
      return Response.json({
        task: {
          schema_version: 1,
          id: 'task_00000001',
          project_id: projectId,
          kind: 'image.generate',
          status: 'queued',
          status_sequence: 0,
          progress: 0,
          stage: '等待提交',
          created_at: timestamp,
          updated_at: timestamp,
        },
      })
    },
  })
  await actions.submitProject(projectId)
  await actions.startOperation(projectId, {
    revision: 0,
    base_version_id: versionId,
    kind: 'edit',
    instruction: '仅用于 IPC 合同基线',
    confirm_unknown_retry: false,
  })
  const estimate = await actions.estimateDerivation(projectId, 'cand_00000001', {
    base_revision: 0,
    instruction: '只修改背景光线',
  })
  expect(estimate.expires_at).toBe('2026-08-03T00:05:00.000Z')
  const decision = await actions.decideCandidate(projectId, 'cand_00000001', {
    base_revision: 0,
    idempotency_key: 'bb-image-ipc-decision-0001',
    decision: 'kept',
  })
  expect(decision.decision.id).toBe('adopt_00000001')
  expect(requests.map(request => new URL(request.url).pathname)).toEqual([
    `/api/images/projects/${projectId}/submit`,
    `/api/images/projects/${projectId}/operations`,
    `/api/images/projects/${projectId}/candidates/cand_00000001/derivations/estimate`,
    `/api/images/projects/${projectId}/candidates/cand_00000001/decisions`,
  ])
  const first = requests[0]!
  const firstUrl = new URL(first.url)
  const firstHeaders = new Headers(first.init?.headers)
  const ticket = firstHeaders.get('x-billiardbuddy-media-capability')
  expect(ticket).toStartWith('bbimg1.')
  expect(ticket).not.toBe(capability)
  expect(firstHeaders.get('origin')).toBe(firstUrl.origin)
  const replayGuard = new ImageUiCapabilityReplayGuard()
  expect(verifyImageUiCapabilityTicket(capability, ticket!, {
    method: first.init?.method ?? 'GET',
    url: firstUrl,
    body: typeof first.init?.body === 'string' ? first.init.body : '',
    range: firstHeaders.get('range'),
  }, replayGuard)).not.toBeNull()
  expect(verifyImageUiCapabilityTicket(capability, ticket!, {
    method: first.init?.method ?? 'GET',
    url: firstUrl,
    body: typeof first.init?.body === 'string' ? first.init.body : '',
    range: firstHeaders.get('range'),
  }, replayGuard)).toBeNull()
  const decisionRequest = requests[3]!
  const decisionUrl = new URL(decisionRequest.url)
  const decisionHeaders = new Headers(decisionRequest.init?.headers)
  const decisionClaims = verifyImageUiCapabilityTicket(capability, decisionHeaders.get(MEDIA_UI_CAPABILITY_HEADER)!, {
    method: decisionRequest.init?.method ?? 'GET',
    url: decisionUrl,
    body: typeof decisionRequest.init?.body === 'string' ? decisionRequest.init.body : '',
    range: decisionHeaders.get('range'),
  }, new ImageUiCapabilityReplayGuard())
  expect(decisionClaims).toMatchObject({
    owner: { kind: 'standalone', owner_id: 'local_workbench' },
    project_id: projectId,
  })
  expect(decisionClaims?.resource_ids).toEqual(expect.arrayContaining([projectId, 'cand_00000001']))
  expect(() => new ElectronImageActions({ getServerUrl: async () => '', ticketSecret: 'too-short' })).toThrow('Image UI ticket secret is too short')
})

test('15.2 Image IPC rejects a malformed server response before it reaches the renderer', async () => {
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    ticketSecret: capability,
    fetchImpl: async () => Response.json({ estimate_hash: `sha256:${'e'.repeat(64)}` }),
  })
  await expect(actions.estimateDerivation(projectId, 'cand_00000001', {
    base_revision: 0,
    instruction: '只修改背景光线',
  })).rejects.toThrow()
})

test('15.3 Canvas IPC rejects a malformed Render response before it reaches the renderer', async () => {
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    ticketSecret: capability,
    fetchImpl: async () => Response.json({ operation: { id: 'op_00000001' } }),
  })
  await expect(actions.renderCanvas(projectId, 'canvas_00000001', {
    base_revision: 0, idempotency_key: 'bb-image-ipc-malformed-render-0001', canvas_revision: 0, activate_on_success: true,
  })).rejects.toThrow()
})

test('15.2 Image IPC keeps HTTP idempotency and revision conflicts distinguishable for every Command', async () => {
  const commands: Array<{
    name: string
    path: string
    invoke(actions: ElectronImageActions, idempotencyKey: string): Promise<ImageCommandResponse>
  }> = [
    {
      name: 'Creative Plan',
      path: `/api/images/projects/${projectId}/creative-plans`,
      invoke: async (actions, idempotencyKey) => await actions.createCreativePlan(projectId, {
        base_revision: 0,
        idempotency_key: idempotencyKey,
      }),
    },
    {
      name: 'Generation Round',
      path: `/api/images/projects/${projectId}/generation-rounds`,
      invoke: async (actions, idempotencyKey) => await actions.createGenerationRound(projectId, {
        base_revision: 0,
        idempotency_key: idempotencyKey,
        creative_plan_id: 'plan_00000001',
        direction_ids: ['dir_00000001'],
        estimate_hash: `sha256:${'a'.repeat(64)}`,
        confirm: true,
      }),
    },
    {
      name: 'Candidate Decision',
      path: `/api/images/projects/${projectId}/candidates/cand_00000001/decisions`,
      invoke: async (actions, idempotencyKey) => await actions.decideCandidate(projectId, 'cand_00000001', {
        base_revision: 0,
        idempotency_key: idempotencyKey,
        decision: 'kept',
      }),
    },
    {
      name: 'Candidate Adoption',
      path: `/api/images/projects/${projectId}/candidates/cand_00000001/adoptions`,
      invoke: async (actions, idempotencyKey) => await actions.adoptCandidate(projectId, 'cand_00000001', {
        base_revision: 0,
        idempotency_key: idempotencyKey,
        adoptions: [{ artboard_id: 'art_00000001', placement: { fit: 'cover', focus_x: 0.5, focus_y: 0.5 } }],
      }),
    },
    {
      name: 'Candidate Derivation',
      path: `/api/images/projects/${projectId}/candidates/cand_00000001/derivations`,
      invoke: async (actions, idempotencyKey) => await actions.deriveCandidate(projectId, 'cand_00000001', {
        base_revision: 0,
        idempotency_key: idempotencyKey,
        instruction: '保持主体，仅调整背景光线',
        estimate_hash: `sha256:${'b'.repeat(64)}`,
        confirm: true,
      }),
    },
    {
      name: 'Reference Control',
      path: `/api/images/projects/${projectId}/references/ref_00000001/commands/update-control`,
      invoke: async (actions, idempotencyKey) => await actions.updateReferenceControl(projectId, 'ref_00000001', {
        base_revision: 0,
        idempotency_key: idempotencyKey,
        role: 'subject',
        influence_strength: 'high',
        preservation: 'must_preserve',
        priority: 80,
      }),
    },
  ]
  for (const command of commands) {
    for (const code of ['MEDIA_IMAGE_IDEMPOTENCY_CONFLICT', 'MEDIA_IMAGE_REVISION_CONFLICT'] as const) {
      const requests: string[] = []
      const actions = new ElectronImageActions({
        getServerUrl: async () => 'http://127.0.0.1:3456',
        ticketSecret: capability,
        fetchImpl: async input => {
          requests.push(new URL(input.toString()).pathname)
          return Response.json({ error: code, message: mediaSafeError(code).message }, { status: 409 })
        },
      })
      const result = await imageWorkbenchIpcResponse(async () => await command.invoke(
        actions,
        `bb-image-ipc-${command.name.toLowerCase().replaceAll(' ', '-')}-${code.toLowerCase()}-0001`,
      ))
      expect(result).toEqual({ ok: false, error: mediaSafeError(code) })
      expect(requests).toEqual([command.path])
    }
  }
})

test('15.3 IPC 只接受不透明 destination grant，拒绝 Renderer 路径', () => {
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSaveOutput, {
    projectId,
    input: { version_id: versionId, output_path: '/tmp/current-baseline.png' },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSaveOutput, {
    projectId,
    input: { version_id: versionId, destination_grant_id: 'dgr_00000000000000000000000000000000' },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageRequestDestination, {
    project_id: projectId,
    version_id: versionId,
    intent: 'save_version',
    suggested_name: '交付图.png',
  })).toBeTrue()
})
