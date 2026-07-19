import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from './desktopHost/browserHost'
import { useBrowserPanelStore } from '../stores/browserPanelStore'

let previewHandler: ((payload: unknown) => void) | null = null

const { prefill } = vi.hoisted(() => ({
  prefill: vi.fn(),
}))

vi.mock('../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      queueComposerPrefill: prefill,
    }),
  },
}))

import { subscribeChatPreviewEvents } from './chatPreviewEvents'

describe('subscribeChatPreviewEvents', () => {
  beforeEach(() => {
    previewHandler = null
    prefill.mockReset()
    useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        previewWebview: true,
      },
      preview: {
        ...browserHost.preview,
        onEvent: async (handler) => {
          previewHandler = handler
          return () => {
            previewHandler = null
          }
        },
      },
    }
  })

  it('preserves the legacy workbench screenshot composer prefill', async () => {
    await subscribeChatPreviewEvents('legacy-session-1')

    previewHandler!({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'viewport',
    })

    expect(prefill).toHaveBeenCalledWith('legacy-session-1', expect.objectContaining({
      mode: 'append',
      attachments: [expect.objectContaining({
        type: 'image',
        name: 'screenshot-viewport.png',
        data: 'data:image/png;base64,AAAA',
      })],
    }))
  })

  it('preserves the legacy armed-selection composer prefill', async () => {
    useBrowserPanelStore.getState().open('legacy-session-1', 'https://example.com/')
    useBrowserPanelStore.getState().setPicker('legacy-session-1', true)
    await subscribeChatPreviewEvents('legacy-session-1')

    previewHandler!(JSON.stringify({
      v: 1,
      type: 'selection',
      payload: {
        pageUrl: 'https://example.com/',
        element: { selector: '#headline', tag: 'h1', classes: [] },
        change: { description: '让标题更醒目' },
        screenshot: { dataUrl: 'data:image/png;base64,AAAA', kind: 'element' },
      },
    }))

    expect(prefill).toHaveBeenCalledWith('legacy-session-1', expect.objectContaining({
      mode: 'replace',
      text: expect.stringContaining('让标题更醒目'),
      attachments: [expect.objectContaining({
        name: '<h1>',
        note: '让标题更醒目',
      })],
    }))
    expect(useBrowserPanelStore.getState().bySession['legacy-session-1']!.pickerActive).toBe(false)
  })
})
