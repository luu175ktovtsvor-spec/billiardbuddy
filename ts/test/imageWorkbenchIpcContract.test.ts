import { expect, test } from 'bun:test'
import { ELECTRON_IPC_CHANNELS } from '../desktop/electron/ipc/channels.js'
import { validateElectronIpcPayload } from '../desktop/electron/ipc/capabilities.js'
import { ElectronImageActions } from '../desktop/electron/services/imageActions.js'

const projectId = 'img_00000001'
const versionId = 'ver_00000001'
const capability = '0123456789abcdef0123456789abcdef'

test('current image IPC validators accept only the four explicitly registered baseline channels and reject forged payload shapes', () => {
  const baselineChannels = [
    ELECTRON_IPC_CHANNELS.imageSubmitProject,
    ELECTRON_IPC_CHANNELS.imageStartOperation,
    ELECTRON_IPC_CHANNELS.imageUpdateUnknownProject,
    ELECTRON_IPC_CHANNELS.imageSaveOutput,
  ]
  expect(baselineChannels).toEqual([
    'desktop:image:submit-project',
    'desktop:image:start-operation',
    'desktop:image:update-unknown-project',
    'desktop:image:save-output',
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
})

test('current Main-only image action bridge sends the desktop capability through fixed image action entrypoints', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const actions = new ElectronImageActions({
    getServerUrl: async () => 'http://127.0.0.1:3456',
    capability,
    fetchImpl: async (input, init) => {
      requests.push({ url: input.toString(), init })
      return Response.json({ task: { id: 'task_00000001' } })
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
  expect(requests.map(request => new URL(request.url).pathname)).toEqual([
    `/api/images/projects/${projectId}/submit`,
    `/api/images/projects/${projectId}/operations`,
  ])
  expect(new Headers(requests[0]!.init?.headers).get('x-billiardbuddy-media-capability')).toBe(capability)
  expect(() => new ElectronImageActions({ getServerUrl: async () => '', capability: 'too-short' })).toThrow('Image UI capability is too short')
})

test('15.0 records the image IPC gaps that later 13.7 work must replace without silently treating them as final security', () => {
  const missingForFinalBroker = [
    'project_brief_reference_delivery_spec_canvas_brand_template_campaign_commands',
    'candidate_decision_adoption_derivation_and_risk_acceptance',
    'operation_cancel_retry_and_unknown_outcome_decision',
    'opaque_source_destination_and_asset_grants',
    'sensitive_media_capability_reads',
  ]
  expect(missingForFinalBroker).toHaveLength(5)
  // The legacy baseline accepts a renderer-supplied path.  This is deliberately
  // documented here as a 13.7 gap, not a future security expectation.
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.imageSaveOutput, {
    projectId,
    input: { version_id: versionId, output_path: '/tmp/current-baseline.png' },
  })).toBeTrue()
})
