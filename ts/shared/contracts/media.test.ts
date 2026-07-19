import { describe, expect, test } from 'bun:test'
import {
  createImageProjectInputSchema,
  imageWorkbenchProjectSchema,
  productTaskOwnerIdSchema,
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

describe('image model canvas contract', () => {
  test('keeps legacy projects on GPT while accepting Seedream-specific ratios', () => {
    expect(imageWorkbenchProjectSchema.parse(baseImageProject).model).toBe('gpt-image-2')
    expect(createImageProjectInputSchema.parse({
      prompt: '4K 竖版海报',
      model: 'gpt-image-2',
      size: '2160x3840',
    })).toMatchObject({
      model: 'gpt-image-2',
      size: '2160x3840',
    })
    expect(createImageProjectInputSchema.parse({
      prompt: '短视频竖版海报',
      model: 'doubao-seedream-4-5-251128',
      size: '3040x5504',
    })).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      size: '3040x5504',
    })
  })

  test('rejects sending a Seedream-only canvas to GPT instead of silently switching models', () => {
    const parsed = createImageProjectInputSchema.safeParse({
      prompt: '易拉宝',
      model: 'gpt-image-2',
      size: '1216x3040',
    })
    expect(parsed.success).toBe(false)
  })
})
