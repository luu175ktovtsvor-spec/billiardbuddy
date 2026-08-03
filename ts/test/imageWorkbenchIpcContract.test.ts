import { expect, test } from 'bun:test'
import { ELECTRON_IPC_CHANNELS } from '../desktop/electron/ipc/channels.js'
import { validateElectronIpcPayload } from '../desktop/electron/ipc/capabilities.js'
import { imageWorkbenchIpcResponse } from '../desktop/electron/ipc/imageResponse.js'
import { ElectronImageActions } from '../desktop/electron/services/imageActions.js'
import { ImageDestinationGrants } from '../desktop/electron/services/imageDestinationGrants.js'
import { mediaSafeError } from '../shared/contracts/media.js'
import type {
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
} from '../shared/contracts/imageGeneration.js'

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

test('15.4 image IPC validators expose shared typed Qwen advice, Canvas and delivery commands', () => {
  const imageChannels = [
    ELECTRON_IPC_CHANNELS.imageSubmitProject,
    ELECTRON_IPC_CHANNELS.imageStartOperation,
    ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject,
    ELECTRON_IPC_CHANNELS.imageSaveOutput,
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

test('15.3 opaque destination grant is Main-only, expires, and cannot be replayed', () => {
  const grants = new ImageDestinationGrants()
  const issued = grants.issue('/private/user-selected-output.png', 1_000)
  expect(issued.destination_grant_id).toMatch(/^dgr_/)
  expect(JSON.stringify(issued)).not.toContain('/private/user-selected-output.png')
  expect(grants.consume(issued.destination_grant_id, 1_001)).toBe('/private/user-selected-output.png')
  expect(grants.consume(issued.destination_grant_id, 1_002)).toBeNull()
  const expired = grants.issue('/private/expired.png', 1_000)
  expect(grants.consume(expired.destination_grant_id, 1_000 + 5 * 60_000 + 1)).toBeNull()
})

test('current Main-only image action bridge sends the desktop capability through fixed image action entrypoints', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const timestamp = '2026-08-03T00:00:00.000Z'
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    capability,
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
  expect(new Headers(requests[0]!.init?.headers).get('x-billiardbuddy-media-capability')).toBe(capability)
  expect(() => new ElectronImageActions({ getServerUrl: async () => '', capability: 'too-short' })).toThrow('Image UI capability is too short')
})

test('15.2 Image IPC rejects a malformed server response before it reaches the renderer', async () => {
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    capability,
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
    capability,
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
        capability,
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
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageRequestDestination, { suggested_name: '交付图.png' })).toBeTrue()
})
