import { describe, expect, test } from 'bun:test'
import {
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  imageWorkbenchProjectSchema,
  mediaOwnerSchema,
  publicImageWorkbenchProjectSchema,
  publicMediaTaskSchema,
  publicVideoStudioProjectSchema,
  startImageOperationInputSchema,
  updateImageProjectInputSchema,
} from './media.js'

const baseImageProject = {
  schema_version: 1,
  id: 'img_12345678',
  kind: 'image' as const,
  title: '测试图片',
  revision: 0,
  created_at: '2026-07-19T00:00:00.000Z',
  updated_at: '2026-07-19T00:00:00.000Z',
  state: 'draft' as const,
  mode: 'generate' as const,
  prompt: '一张台球海报',
  size: '1024x1024' as const,
  count: 1,
  reference_images: [],
  reference_image_count: 0,
  outputs: [],
}

describe('standalone media ownership contract', () => {
  test('only accepts the independent local workbench owner', () => {
    expect(imageWorkbenchProjectSchema.parse(baseImageProject).owner).toEqual({
      kind: 'standalone',
      owner_id: 'local_workbench',
    })
    expect(mediaOwnerSchema.safeParse({
      kind: 'product_task',
      owner_id: 'task_0123456789abcdef',
    }).success).toBe(false)
  })
})

describe('provider-neutral image creation contract', () => {
  test('keeps legacy provider fields readable but strips them from new creation input', () => {
    expect(imageWorkbenchProjectSchema.parse(baseImageProject).model).toBe('gpt-image-2')
    const input = createImageProjectInputSchema.parse({
      user_request: '4K 竖版海报',
      model: 'doubao-seedream-4-5-251128',
      count: 1,
      size: '2160x3840',
    })
    expect(input).toMatchObject({ user_request: '4K 竖版海报', size: '2160x3840' })
    expect(input).not.toHaveProperty('model')
    expect(input).not.toHaveProperty('count')
  })

  test('requires one user-confirmed role for every reference image', () => {
    const reference = `data:image/png;base64,${Buffer.from('reference').toString('base64')}`
    expect(createImageProjectInputSchema.safeParse({
      user_request: '参考图海报',
      reference_images: [reference],
    }).success).toBe(false)
    expect(createImageProjectInputSchema.safeParse({
      user_request: '参考图海报',
      reference_images: [reference],
      reference_roles: ['unclassified'],
    }).success).toBe(false)
    const parsed = createImageProjectInputSchema.parse({
      user_request: '参考图海报',
      reference_images: [reference],
      reference_roles: ['subject'],
    })
    expect(parsed.reference_roles).toEqual(['subject'])
    expect(updateImageProjectInputSchema.safeParse({
      revision: 0,
      user_request: '新增参考图',
      size: '1024x1024',
      new_reference_images: [reference],
      new_reference_roles: [],
    }).success).toBe(false)
    expect(updateImageProjectInputSchema.safeParse({
      revision: 0,
      user_request: '新增参考图',
      size: '1024x1024',
      new_reference_images: [reference],
      new_reference_roles: ['unclassified'],
    }).success).toBe(false)
  })

  test('keeps provider and legacy outputs private while exposing immutable version history', () => {
    const publicProject = publicImageWorkbenchProjectSchema.parse({
      ...baseImageProject,
      model: 'gpt-image-2',
      outputs: [{ id: 'out_private01', mime_type: 'image/png', url: 'https://example.test/private.png' }],
      version_history: [{
        id: 'ver_public001',
        kind: 'generated',
        asset_id: 'out_private01',
        image_path: '/api/media/assets/img_12345678/out_private01.png',
        mime_type: 'image/png',
        image_layers: [{
          id: 'layer_public01',
          source_asset_id: 'ref_public001',
          x: 10,
          y: 10,
          width: 100,
          height: 100,
          opacity: 0.8,
          image_path: '/api/media/images/projects/img_12345678/layer-assets/ref_public001/content',
          mime_type: 'image/png',
        }],
        created_at: baseImageProject.created_at,
      }],
    })
    expect(publicProject.version_history).toHaveLength(1)
    expect(publicProject.version_history[0]!.image_layers[0]).toMatchObject({
      source_asset_id: 'ref_public001',
      opacity: 0.8,
    })
    expect(publicProject).not.toHaveProperty('model')
    expect(publicProject).not.toHaveProperty('prompt')
    expect(publicProject).not.toHaveProperty('outputs')
  })

  test('does not stop an image project at the old sixteen-output legacy limit', () => {
    const outputs = Array.from({ length: 17 }, (_, index) => ({
      id: `out_version${String(index).padStart(3, '0')}`,
      mime_type: 'image/png' as const,
      url: `https://example.test/version-${index}.png`,
    }))
    expect(imageWorkbenchProjectSchema.safeParse({ ...baseImageProject, outputs }).success).toBe(true)
  })

  test('requires an explicit base and matching operation-specific inputs', () => {
    const common = {
      revision: 2,
      base_version_id: 'ver_base0001',
      instruction: '只修改蒙版区域',
    }
    expect(startImageOperationInputSchema.safeParse({ ...common, kind: 'inpaint' }).success).toBe(false)
    expect(startImageOperationInputSchema.safeParse({
      ...common,
      kind: 'inpaint',
      mask_data_url: 'data:image/png;base64,AAAA',
    }).success).toBe(true)
    expect(commitImageVersionInputSchema.safeParse({
      revision: 3,
      base_version_id: 'ver_base0001',
      kind: 'upscale',
      rendered_image: 'data:image/png;base64,AAAA',
      width: 200,
      height: 200,
    }).success).toBe(false)
    expect(commitImageVersionInputSchema.safeParse({
      revision: 3,
      base_version_id: 'ver_base0001',
      kind: 'composite',
      rendered_image: 'data:image/png;base64,AAAA',
      width: 200,
      height: 200,
      image_layers: [],
    }).success).toBe(false)
    expect(commitImageVersionInputSchema.safeParse({
      revision: 3,
      base_version_id: 'ver_base0001',
      kind: 'composite',
      rendered_image: 'data:image/png;base64,AAAA',
      width: 200,
      height: 200,
      image_layers: [{
        id: 'layer_subject01',
        source_asset_id: 'ref_subject01',
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        opacity: 0.75,
      }],
    }).success).toBe(true)
  })

  test('exposes the job sequence while keeping provider polling and acknowledgement bookkeeping private', () => {
    const task = publicMediaTaskSchema.parse({
      schema_version: 1,
      id: 'task_public01',
      project_id: 'img_12345678',
      kind: 'image.generate',
      status: 'succeeded',
      status_sequence: 4,
      progress: 100,
      stage: '生成完成',
      poll_after_seconds: 30,
      remote_result_acknowledged_at: '2026-07-24T05:00:00.000Z',
      created_at: '2026-07-24T04:59:00.000Z',
      updated_at: '2026-07-24T05:00:00.000Z',
    })
    expect(task).not.toHaveProperty('remote_result_acknowledged_at')
    expect(task).not.toHaveProperty('poll_after_seconds')
    expect(task.status_sequence).toBe(4)
  })

  test('exposes video fingerprints and versions without exposing source paths', () => {
    const project = publicVideoStudioProjectSchema.parse({
      schema_version: 1,
      id: 'vid_12345678',
      kind: 'video',
      title: '真实素材',
      revision: 1,
      created_at: baseImageProject.created_at,
      updated_at: baseImageProject.updated_at,
      state: 'ready',
      sources: [{
        id: 'src_12345678',
        path: '/private/video/source.mp4',
        name: 'source.mp4',
        duration_ms: 1000,
        width: 1920,
        height: 1080,
        has_audio: true,
        fingerprint: `sha256:${'a'.repeat(64)}`,
      }],
      timeline: [{ id: 'clip_12345678', source_id: 'src_12345678', in_ms: 0, out_ms: 1000 }],
      output: { width: 1920, height: 1080, fps: 30 },
      evidence: [],
      timeline_versions: [],
      alternatives: [],
      preview_task_id: 'task_preview01',
      preview: {
        timeline_version_id: 'timeline_preview01',
        asset_id: 'preview_asset001',
        asset_path: '/api/media/assets/vid_12345678/preview_asset001.mp4',
        content_hash: `sha256:${'b'.repeat(64)}`,
        created_at: baseImageProject.updated_at,
      },
    })
    expect(project.sources[0]?.fingerprint).toBe(`sha256:${'a'.repeat(64)}`)
    expect(project.sources[0]).not.toHaveProperty('path')
    expect(project.preview).toMatchObject({ asset_id: 'preview_asset001' })
    expect(publicMediaTaskSchema.safeParse({
      schema_version: 1,
      id: 'task_preview01',
      project_id: project.id,
      kind: 'video.preview',
      status: 'running',
      progress: 50,
      stage: '正在生成预览',
      created_at: baseImageProject.created_at,
      updated_at: baseImageProject.updated_at,
    }).success).toBe(true)
  })
})
