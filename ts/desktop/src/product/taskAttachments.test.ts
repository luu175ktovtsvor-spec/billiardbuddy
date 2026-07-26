import { describe, expect, it } from 'vitest'
import {
  PRODUCT_TASK_ATTACHMENT_LIMITS,
  createProductTaskPreviewImageDraft,
  readProductTaskAttachmentDrafts,
  validateProductTaskAttachments,
} from './taskAttachments'

const image = {
  id: 'image-1',
  type: 'image' as const,
  name: '球台.png',
  mimeType: 'image/png',
  data: 'data:image/png;base64,cG9zaXRpb24=',
}

describe('validateProductTaskAttachments', () => {
  it('keeps only the product socket attachment shape', () => {
    const attachmentWithLegacyMetadata = {
      ...image,
      path: '/Users/example/球台.png',
      note: 'internal detail',
    }
    expect(validateProductTaskAttachments([attachmentWithLegacyMetadata])).toEqual({
      ok: true,
      attachments: [{
        type: 'image',
        name: '球台.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,cG9zaXRpb24=',
      }],
    })
  })

  it('rejects paths, unsupported types, and oversize batches before opening the socket', () => {
    const legacyPathOnly = {
      id: 'path-only',
      type: 'file' as const,
      name: '秘密.txt',
      path: '/Users/example/秘密.txt',
    }
    expect(validateProductTaskAttachments([legacyPathOnly])).toMatchObject({ ok: false })

    expect(validateProductTaskAttachments([{
      ...image,
      mimeType: 'image/svg+xml',
      data: 'data:image/svg+xml;base64,PHN2Zy8+',
    }])).toMatchObject({ ok: false })

    expect(validateProductTaskAttachments(Array.from(
      { length: PRODUCT_TASK_ATTACHMENT_LIMITS.count + 1 },
      (_, index) => ({ ...image, id: `image-${index}` }),
    ))).toMatchObject({ ok: false })
  })

  it('reads only supported browser-selected files into inline product drafts', async () => {
    const { attachments, rejectedCount } = await readProductTaskAttachmentDrafts([
      new File(['table'], '球台.png', { type: 'image/png' }),
      new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
    ])

    expect(rejectedCount).toBe(1)
    expect(attachments).toEqual([expect.objectContaining({
      type: 'image',
      name: '球台.png',
      mimeType: 'image/png',
      data: expect.stringMatching(/^data:image\/png;base64,/),
    })])
  })

  it('keeps bounded video bytes as a multipart File instead of a base64 draft', async () => {
    const video = new File([new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70])], '训练.mp4', { type: 'video/mp4' })
    const result = await readProductTaskAttachmentDrafts([video])

    expect(result.rejectedCount).toBe(0)
    expect(result.attachments).toEqual([expect.objectContaining({
      type: 'file',
      name: '训练.mp4',
      mimeType: 'video/mp4',
      file: video,
    })])
    expect(result.attachments[0]).not.toHaveProperty('data')
  })
})

describe('createProductTaskPreviewImageDraft', () => {
  it('accepts only bounded native image data as a task attachment draft', () => {
    expect(createProductTaskPreviewImageDraft(
      'data:image/png;base64,TkFUSVZF',
      '浏览器截图.png',
    )).toEqual(expect.objectContaining({
      type: 'image',
      name: '浏览器截图.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,TkFUSVZF',
    }))
  })

  it('rejects malformed, unsupported, and path-like preview captures', () => {
    expect(createProductTaskPreviewImageDraft(
      'data:text/html;base64,PHNjcmlwdD4=',
      '浏览器截图.png',
    )).toBeNull()
    expect(createProductTaskPreviewImageDraft(
      'data:image/png;base64,TkFUSVZF',
      ' ',
    )).toBeNull()
  })
})
