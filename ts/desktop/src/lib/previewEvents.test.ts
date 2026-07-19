import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from './desktopHost/browserHost'
import { subscribePreviewEvents } from './previewEvents'
import { useBrowserPanelStore } from '../stores/browserPanelStore'

let previewHandler: ((payload: unknown) => void) | null = null

describe('subscribePreviewEvents', () => {
  beforeEach(() => {
    previewHandler = null
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

  it('routes a generic navigated event to the keyed browser panel', async () => {
    useBrowserPanelStore.getState().open('product-task:task_abc:browser', 'http://x/a')
    await subscribePreviewEvents('product-task:task_abc:browser')

    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'http://x/c', title: 'C' }))

    expect(useBrowserPanelStore.getState().bySession['product-task:task_abc:browser']!.url).toBe('http://x/c')
  })

  it('honors the caller navigation boundary before mutating browser state', async () => {
    const key = 'product-task:task_abc:preview'
    const isNavigationAllowed = vi.fn((url: string) => url.startsWith('https://'))
    useBrowserPanelStore.getState().open(key, 'https://safe.example/')
    await subscribePreviewEvents(key, { isNavigationAllowed })

    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'file:///private/secret.html', title: 'Nope' }))
    expect(isNavigationAllowed).toHaveBeenCalledWith('file:///private/secret.html')
    expect(useBrowserPanelStore.getState().bySession[key]!.url).toBe('https://safe.example/')

    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'https://safe.example/next', title: 'Safe' }))
    expect(useBrowserPanelStore.getState().bySession[key]!.url).toBe('https://safe.example/next')
  })

  it('delivers screenshots to the caller-owned callback', async () => {
    const onScreenshot = vi.fn()
    await subscribePreviewEvents('product-task:task_abc:browser', { onScreenshot })

    previewHandler!({ v: 1, type: 'screenshot', dataUrl: 'data:image/png;base64,AAAA', kind: 'full' })

    expect(onScreenshot).toHaveBeenCalledWith({
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'full',
    })
  })

  it('delivers only an armed, well-formed selection to the caller callback', async () => {
    const key = 'product-task:task_abc:preview'
    const onSelection = vi.fn()
    const payload = {
      pageUrl: 'https://safe.example/',
      element: { selector: '#t', tag: 'h1', classes: [] },
      change: { description: '改一下' },
      screenshot: { dataUrl: 'data:image/png;base64,AAAA', kind: 'element' },
    }
    useBrowserPanelStore.getState().open(key, 'https://safe.example/')
    useBrowserPanelStore.getState().setPicker(key, true)
    await subscribePreviewEvents(key, { onSelection })

    previewHandler!(JSON.stringify({ v: 1, type: 'selection', payload }))

    expect(onSelection).toHaveBeenCalledWith(payload)
    expect(useBrowserPanelStore.getState().bySession[key]!.pickerActive).toBe(false)
  })

  it('rejects forged or malformed selections while always disarming the picker', async () => {
    const key = 'product-task:task_abc:browser'
    const onSelection = vi.fn()
    useBrowserPanelStore.getState().open(key, 'https://safe.example/')
    await subscribePreviewEvents(key, { onSelection })

    previewHandler!(JSON.stringify({
      v: 1,
      type: 'selection',
      payload: { pageUrl: 'https://safe.example/', element: { selector: '#injected', tag: 'div', classes: [] } },
    }))
    expect(onSelection).not.toHaveBeenCalled()

    useBrowserPanelStore.getState().setPicker(key, true)
    expect(() => previewHandler!(JSON.stringify({ v: 1, type: 'selection', payload: { pageUrl: 'https://safe.example/' } }))).not.toThrow()
    expect(onSelection).not.toHaveBeenCalled()
    expect(useBrowserPanelStore.getState().bySession[key]!.pickerActive).toBe(false)
  })

  it('clears the picker when the native host reports picker exit', async () => {
    const key = 'product-task:task_abc:browser'
    useBrowserPanelStore.getState().open(key, 'https://safe.example/')
    useBrowserPanelStore.getState().setPicker(key, true)
    await subscribePreviewEvents(key)

    previewHandler!(JSON.stringify({ v: 1, type: 'picker-exited' }))

    expect(useBrowserPanelStore.getState().bySession[key]!.pickerActive).toBe(false)
  })
})
