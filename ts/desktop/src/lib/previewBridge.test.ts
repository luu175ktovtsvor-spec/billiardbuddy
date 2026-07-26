import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebviewBounds } from '../components/browser/computeWebviewBounds'
import { browserHost } from './desktopHost/browserHost'

function installElectronPreviewHost() {
  const open = vi.fn().mockResolvedValue(undefined)
  const setBounds = vi.fn().mockResolvedValue(undefined)
  const setZoom = vi.fn().mockResolvedValue(undefined)
  const message = vi.fn().mockResolvedValue(undefined)

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
      open,
      setBounds,
      setZoom,
      message,
    },
  }

  return { open, setBounds, setZoom, message }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'desktopHost')
})

describe('previewBridge', () => {
  it('openPreview forwards url + bounds to the Electron preview host', async () => {
    const { open } = installElectronPreviewHost()
    const { previewBridge } = await import('./previewBridge')
    const bounds: WebviewBounds = { x: 1, y: 2, width: 3, height: 4 }
    await previewBridge.open('http://localhost/a', bounds)
    expect(open).toHaveBeenCalledWith('http://localhost/a', bounds)
  })

  it('setBounds forwards to the Electron preview host', async () => {
    const { setBounds } = installElectronPreviewHost()
    const { previewBridge } = await import('./previewBridge')
    const bounds: WebviewBounds = { x: 0, y: 0, width: 10, height: 10 }
    await previewBridge.setBounds(bounds)
    expect(setBounds).toHaveBeenCalledWith(bounds)
  })

  it('setZoom forwards to the Electron preview host', async () => {
    const { setZoom } = installElectronPreviewHost()
    const { previewBridge } = await import('./previewBridge')
    await previewBridge.setZoom(0.8)
    expect(setZoom).toHaveBeenCalledWith(0.8)
  })

  it('message forwards structured host messages to the Electron preview host', async () => {
    const { message } = installElectronPreviewHost()
    const { previewBridge } = await import('./previewBridge')
    const payload = { v: 1, type: 'capture', kind: 'viewport' } as const
    await previewBridge.message(payload)
    expect(message).toHaveBeenCalledWith(payload)
  })

  it('is a no-op outside the desktop runtime', async () => {
    vi.resetModules()
    const { previewBridge } = await import('./previewBridge')
    await previewBridge.open('http://localhost/a', { x: 0, y: 0, width: 1, height: 1 })
  })

  it('routes preview commands through an injected desktop host', async () => {
    vi.resetModules()
    const open = vi.fn().mockResolvedValue(undefined)
    const setBounds = vi.fn().mockResolvedValue(undefined)
    const setZoom = vi.fn().mockResolvedValue(undefined)
    const message = vi.fn().mockResolvedValue(undefined)

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
        open,
        setBounds,
        setZoom,
        message,
      },
    }

    const { previewBridge } = await import('./previewBridge')
    const bounds: WebviewBounds = { x: 1, y: 2, width: 3, height: 4 }

    await previewBridge.open('http://localhost/a', bounds)
    await previewBridge.setBounds(bounds)
    await previewBridge.setZoom(0.75)
    await previewBridge.message({ v: 1, type: 'enter-picker' })

    expect(open).toHaveBeenCalledWith('http://localhost/a', bounds)
    expect(setBounds).toHaveBeenCalledWith(bounds)
    expect(setZoom).toHaveBeenCalledWith(0.75)
    expect(message).toHaveBeenCalledWith({ v: 1, type: 'enter-picker' })
  })
})
