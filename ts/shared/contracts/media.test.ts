import { describe, expect, test } from 'bun:test'
import {
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  imageWorkbenchProjectSchema,
  productTaskOwnerIdSchema,
  publicImageWorkbenchProjectSchema,
  publicMediaTaskSchema,
  publicVideoStudioProjectSchema,
  startImageOperationInputSchema,
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

describe('media product task ownership contract', () => {
  test('keeps legacy standalone projects valid while allowing an opaque public task owner', () => {
    expect(imageWorkbenchProjectSchema.parse(baseImageProject).product_task_id).toBeUndefined()

    const owned = imageWorkbenchProjectSchema.parse({
      ...baseImageProject,
      product_task_id: 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb',
    })
    expect(owned.product_task_id).toBe('task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb')
  })

  test('does not accept a Core-style session id as a media owner', () => {
    expect(productTaskOwnerIdSchema.safeParse('session_internal_1234567890').success).toBe(false)
    expect(productTaskOwnerIdSchema.safeParse('task_0123456789abcdef').success).toBe(true)
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
        created_at: baseImageProject.created_at,
      }],
    })
    expect(publicProject.version_history).toHaveLength(1)
    expect(publicProject).not.toHaveProperty('model')
    expect(publicProject).not.toHaveProperty('prompt')
    expect(publicProject).not.toHaveProperty('outputs')
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
  })

  test('keeps relay acknowledgement bookkeeping out of the renderer task contract', () => {
    const task = publicMediaTaskSchema.parse({
      schema_version: 1,
      id: 'task_public01',
      project_id: 'img_12345678',
      kind: 'image.generate',
      status: 'succeeded',
      progress: 100,
      stage: '生成完成',
      remote_result_acknowledged_at: '2026-07-24T05:00:00.000Z',
      created_at: '2026-07-24T04:59:00.000Z',
      updated_at: '2026-07-24T05:00:00.000Z',
    })
    expect(task).not.toHaveProperty('remote_result_acknowledged_at')
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
    })
    expect(project.sources[0]?.fingerprint).toBe(`sha256:${'a'.repeat(64)}`)
    expect(project.sources[0]).not.toHaveProperty('path')
  })
})
