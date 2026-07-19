import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from './desktopHost/browserHost'
import {
  filesToInlineComposerAttachments,
  pathToComposerAttachment,
  selectNativeFileAttachments,
} from './composerAttachments'

describe('composer attachment payloads', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
    vi.unstubAllGlobals()
  })

  it('keeps many selected desktop project files as paths instead of request-body data', () => {
    const projectRoot = '/tmp/billiardbuddy-issue-444-regression'
    const files = Array.from({ length: 12 }, (_, index) => (
      `${projectRoot}/assets/large-${index + 1}.bin`
    ))

    const oldInlineAttachments = files.map((filePath) => ({
      type: 'file',
      name: filePath.split('/').pop(),
      data: `data:application/octet-stream;base64,${'A'.repeat(256 * 1024)}`,
      mimeType: 'application/octet-stream',
    }))
    const oldInlinePayload = JSON.stringify({
      type: 'user_message',
      content: 'analyze these files',
      attachments: oldInlineAttachments,
    })

    const pathOnlyAttachments = files.map(pathToComposerAttachment)
    const pathOnlyPayload = JSON.stringify({
      type: 'user_message',
      content: 'analyze these files',
      attachments: pathOnlyAttachments,
    })

    expect(oldInlinePayload.length).toBeGreaterThan(3 * 1024 * 1024)
    expect(pathOnlyPayload.length).toBeLessThan(3 * 1024)
    expect(pathOnlyAttachments.every((attachment) => attachment.path && !attachment.data)).toBe(true)
  })

  it('selects native file attachments through the injected desktop host', async () => {
    const open = vi.fn().mockResolvedValue(['/workspace/a.txt', '/workspace/b.log'])
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        dialogs: true,
      },
      dialogs: {
        ...browserHost.dialogs,
        open,
      },
    }

    const attachments = await selectNativeFileAttachments()

    expect(open).toHaveBeenCalledWith({ multiple: true, directory: false })
    expect(attachments?.map((attachment) => attachment.path)).toEqual([
      '/workspace/a.txt',
      '/workspace/b.log',
    ])
  })

  it('reads selected desktop files inline for the bounded product task transport', async () => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
    }
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
    expect(attachments[0]?.path).toBeUndefined()
  })
})
