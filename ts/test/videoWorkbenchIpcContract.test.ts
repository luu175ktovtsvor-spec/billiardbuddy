import { expect, test } from 'bun:test'
import { ELECTRON_IPC_CHANNELS } from '../desktop/electron/ipc/channels.js'
import { validateElectronIpcPayload } from '../desktop/electron/ipc/capabilities.js'
import { videoWorkbenchIpcResponse, VideoWorkbenchReplayCache } from '../desktop/electron/ipc/videoWorkbenchResponse.js'
import { ElectronVideoWorkbenchActionError, ElectronVideoWorkbenchActions } from '../desktop/electron/services/videoWorkbenchActions.js'
import { MEDIA_UI_CAPABILITY_HEADER } from '../shared/contracts/media.js'
import { createVideoWorkbenchElectronBridge } from '../desktop/src/videoWorkbench/electronBridge.js'
import type { VideoWorkbenchPreloadBridge } from '../shared/contracts/videoWorkbenchPreload.js'

const projectId = 'video_00000001'
const variantId = 'variant_00000001'
const timelineId = 'timeline_00000001'
const capability = '0123456789abcdef0123456789abcdef'
const idempotencyKey = 'video-ipc-contract-key-0001'

function task(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    id: 'task_00000001',
    project_id: projectId,
    kind: 'video.render',
    status: 'queued',
    status_sequence: 1,
    progress: 0,
    stage: '等待执行',
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

test('视频正式 IPC 只保留受控 workbench 通道，并拒绝 Renderer 路径和伪造字段', () => {
  expect(ELECTRON_IPC_CHANNELS.videoWorkbench).toBe('desktop:video:workbench')
  expect('videoAddSource' in ELECTRON_IPC_CHANNELS).toBeFalse()
  expect('videoRender' in ELECTRON_IPC_CHANNELS).toBeFalse()
  expect('videoAnalyze' in ELECTRON_IPC_CHANNELS).toBeFalse()

  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'choose_sources', projectId,
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'choose_sources', projectId, path: '/Users/private/video.mp4',
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'add_sources', projectId, selectionIds: [`vsg_${'a'.repeat(32)}`], idempotencyKey,
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'add_sources', projectId, selectionIds: [`vsg_${'a'.repeat(32)}`], idempotencyKey, path: '/forged/source.mp4',
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'render_variant', projectId, variantId, destinationGrantId: `vdg_${'b'.repeat(32)}`,
    command: { idempotency_key: idempotencyKey, input: { base_revision: 1, base_variant_version_id: 'variant_version_00000001' } },
  })).toBeTrue()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'render_variant', projectId, variantId, destinationGrantId: `vdg_${'b'.repeat(32)}`,
    command: { idempotency_key: idempotencyKey, input: { base_revision: 1, base_variant_version_id: 'variant_version_00000001', output_path: '/forged/export.mp4' } },
  })).toBeFalse()
  expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.videoWorkbench, {
    action: 'apply_editorial_command_set', projectId,
    command: { idempotency_key: idempotencyKey, input: { base_timeline_version_id: timelineId, commands: [] } },
  })).toBeFalse()
})

test('视频 Main 重放缓存只复用完全相同的首次结果，变更请求失败关闭', async () => {
  const cache = new VideoWorkbenchReplayCache()
  let calls = 0
  const first = await cache.execute('source-import', idempotencyKey, { project_id: projectId, selection_ids: ['vsg_one'] }, async () => ({ task_id: `task_${++calls}` }))
  const replay = await cache.execute('source-import', idempotencyKey, { selection_ids: ['vsg_one'], project_id: projectId }, async () => ({ task_id: `task_${++calls}` }))
  expect(first).toEqual({ task_id: 'task_1' })
  expect(replay).toEqual(first)
  expect(calls).toBe(1)
  await expect(cache.execute('source-import', idempotencyKey, { project_id: projectId, selection_ids: ['vsg_two'] }, async () => ({ task_id: 'unexpected' }))).rejects.toMatchObject({
    code: 'MEDIA_INVALID_REQUEST',
  })
})

test('视频 Electron 错误通过稳定安全信封返回，而不是泄露底层错误', async () => {
  const response = await videoWorkbenchIpcResponse(async () => {
    throw new ElectronVideoWorkbenchActionError('MEDIA_RESOURCE_UNAVAILABLE')
  })
  expect(response).toMatchObject({ ok: false, error: { code: 'MEDIA_RESOURCE_UNAVAILABLE' } })
})

test('视频 Main HTTP broker 仅在 Main 到 Sidecar 请求中注入输出路径和幂等头', async () => {
  let received: { url: string; init?: RequestInit } | undefined
  const actions = new ElectronVideoWorkbenchActions({
    getServerUrl: async () => 'http://127.0.0.1:8790/',
    capability,
    fetchImpl: async (input, init) => {
      received = { url: String(input), init }
      return Response.json({ task: task() })
    },
  })
  const result = await actions.renderVariant(projectId, variantId, {
    base_revision: 1,
    base_variant_version_id: 'variant_version_00000001',
    output_path: '/main-only/export.mp4',
  }, idempotencyKey)
  expect(result.id).toBe('task_00000001')
  expect(received?.url).toBe(`http://127.0.0.1:8790/api/videos/projects/${projectId}/delivery-variants/${variantId}/render`)
  expect(new Headers(received?.init?.headers).get('Idempotency-Key')).toBe(idempotencyKey)
  expect(new Headers(received?.init?.headers).get(MEDIA_UI_CAPABILITY_HEADER)).toBe(capability)
  expect(received?.init?.body).toContain('/main-only/export.mp4')
})

test('Renderer bridge 只把 opaque 导出授权交给 Preload，不能附带本机路径', async () => {
  let received: unknown[] | undefined
  const preload = {
    renderVariant: async (...args: unknown[]) => {
      received = args
      return { ok: true, value: task() }
    },
  } as unknown as VideoWorkbenchPreloadBridge
  const bridge = createVideoWorkbenchElectronBridge(preload)
  const result = await bridge.renderVariant(projectId, variantId, {
    destination_grant_id: `vdg_${'c'.repeat(32)}`,
    display_name: 'delivery.mp4',
  }, {
    idempotency_key: idempotencyKey,
    input: { base_revision: 1, base_variant_version_id: 'variant_version_00000001' },
  })

  expect(result).toMatchObject({ ok: true, value: { id: 'task_00000001' } })
  expect(received).toEqual([
    projectId,
    variantId,
    `vdg_${'c'.repeat(32)}`,
    { idempotency_key: idempotencyKey, input: { base_revision: 1, base_variant_version_id: 'variant_version_00000001' } },
  ])
  expect(JSON.stringify(received)).not.toContain('/private/')
})
