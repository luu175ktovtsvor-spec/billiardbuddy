import { describe, expect, it } from 'vitest'
import {
  PRODUCT_TASK_ATTACHMENT_LIMITS,
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
    expect(validateProductTaskAttachments([{
      ...image,
      path: '/Users/example/球台.png',
      note: 'internal detail',
    }])).toEqual({
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
    expect(validateProductTaskAttachments([{
      id: 'path-only',
      type: 'file',
      name: '秘密.txt',
      path: '/Users/example/秘密.txt',
    }])).toMatchObject({ ok: false })

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
})
