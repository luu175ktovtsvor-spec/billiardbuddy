import { afterEach, describe, expect, it, vi } from 'vitest'
import { filesToInlineComposerAttachments } from './composerAttachments'

describe('composer attachment payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads selected files inline for the bounded product task transport', async () => {
    class FakeFileReader {
      result: string | null = null
      onload: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      readAsDataURL(): void {
        this.result = 'data:image/png;base64,QQ=='
        this.onload?.(new Event('load'))
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader)
    const file = new File(['a'], '球台.png', { type: 'image/png' }) as File & { path?: string }
    file.path = '/private/ball-table.png'

    const attachments = await filesToInlineComposerAttachments([file])

    expect(attachments).toEqual([expect.objectContaining({
      type: 'image',
      name: '球台.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,QQ==',
    })])
    expect(attachments[0]).not.toHaveProperty('path')
  })
})
