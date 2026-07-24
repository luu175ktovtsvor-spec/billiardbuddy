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
    const onNavigated = vi.fn()
    useBrowserPanelStore.getState().open(key, 'https://safe.example/')
    await subscribePreviewEvents(key, { isNavigationAllowed, onNavigated })

    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'file:///private/secret.html', title: 'Nope' }))
    expect(isNavigationAllowed).toHaveBeenCalledWith('file:///private/secret.html')
    expect(useBrowserPanelStore.getState().bySession[key]!.url).toBe('https://safe.example/')

    previewHandler!(JSON.stringify({ v: 1, type: 'navigated', url: 'https://safe.example/next', title: 'Safe' }))
    expect(useBrowserPanelStore.getState().bySession[key]!.url).toBe('https://safe.example/next')
    expect(onNavigated).toHaveBeenCalledTimes(1)
    expect(onNavigated).toHaveBeenCalledWith('https://safe.example/next')
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

  it('preserves only a bounded native capture id for caller verification', async () => {
    const onScreenshot = vi.fn()
    await subscribePreviewEvents('product-task:task_abc:browser', { onScreenshot })

    previewHandler!({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'viewport',
      captureId: 'native_capture_id_0123456789',
    })
    previewHandler!({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,BBBB',
      kind: 'viewport',
      captureId: 'too-short',
    })

    expect(onScreenshot).toHaveBeenNthCalledWith(1, {
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'viewport',
      captureId: 'native_capture_id_0123456789',
    })
    expect(onScreenshot).toHaveBeenNthCalledWith(2, {
      dataUrl: 'data:image/png;base64,BBBB',
      kind: 'viewport',
    })
  })

  it('delivers only an armed, well-formed selection to the caller callback', async () => {
    const key = 'product-task:task_abc:preview'
    const onSelection = vi.fn()
    const payload = {
      pageUrl: 'https://safe.example/',
      element: {
        selector: '#t',
        nthPath: 'html:nth-child(1)>body:nth-child(1)>h1:nth-child(1)',
        tag: 'h1',
        classes: [],
        boundingBox: { x: 1, y: 2, w: 3, h: 4 },
        computedStyles: { color: 'rgb(0, 0, 0)' },
      },
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
      payload: {
        pageUrl: 'https://safe.example/',
        element: {
          selector: '#injected',
          nthPath: 'html>body>div',
          tag: 'div',
          classes: [],
          boundingBox: { x: 0, y: 0, w: 1, h: 1 },
          computedStyles: {},
        },
      },
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
