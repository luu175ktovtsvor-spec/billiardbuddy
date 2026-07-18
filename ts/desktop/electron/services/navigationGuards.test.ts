import { describe, expect, it, vi } from 'vitest'
import {
  installMainWindowNavigationGuards,
  installPreviewNavigationGuards,
  isHttpUrl,
  isTrustedMainWindowFrame,
  isTrustedMainWindowNavigationUrl,
  isTrustedMainWindowSender,
} from './navigationGuards'

function fakeWebContents() {
  let windowOpenHandler: ((details: { url: string }) => { action: 'deny' } | { action: 'allow' }) | null = null
  const navigationHandlers = new Map<string, (event: { preventDefault: () => void, url?: string, isMainFrame?: boolean }, url?: string) => void>()
  return {
    contents: {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }) {
        windowOpenHandler = handler
      },
      on(
        event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate',
        handler: (event: { preventDefault: () => void, url?: string, isMainFrame?: boolean }, url?: string) => void,
      ) {
        navigationHandlers.set(event, handler)
        return this
      },
    },
    openWindow(url: string) {
      if (!windowOpenHandler) throw new Error('window open handler not installed')
      return windowOpenHandler({ url })
    },
    navigate(
      url: string,
      eventName: 'will-navigate' | 'will-redirect' | 'will-frame-navigate' = 'will-navigate',
      { isMainFrame = true, useEventUrl = false }: { isMainFrame?: boolean, useEventUrl?: boolean } = {},
    ) {
      const event = { preventDefault: vi.fn(), isMainFrame, ...(useEventUrl ? { url } : {}) }
      navigationHandlers.get(eventName)?.(event, useEventUrl ? undefined : url)
      return event.preventDefault
    },
    hasNavigationHandler(event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate') {
      return navigationHandlers.has(event)
    },
  }
}

const packagedRendererEntry = '/Applications/BilliardBuddy.app/Contents/Resources/app.asar/dist/index.html'
const packagedRendererUrl = 'file:///Applications/BilliardBuddy.app/Contents/Resources/app.asar/dist/index.html'
const devRendererEntry = 'http://127.0.0.1:1420'

describe('isHttpUrl', () => {
  it('accepts only http(s) URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://127.0.0.1:8080')).toBe(true)
    expect(isHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('trusted main renderer URLs', () => {
  it('allows only the packaged renderer file, not arbitrary local files', () => {
    expect(isTrustedMainWindowNavigationUrl(packagedRendererUrl, packagedRendererEntry)).toBe(true)
    expect(isTrustedMainWindowNavigationUrl(`${packagedRendererUrl}?restore=1`, packagedRendererEntry)).toBe(true)
    expect(isTrustedMainWindowNavigationUrl('file:///etc/passwd', packagedRendererEntry)).toBe(false)
  })

  it('allows only the configured development origin', () => {
    expect(isTrustedMainWindowNavigationUrl('http://127.0.0.1:1420/settings', devRendererEntry)).toBe(true)
    expect(isTrustedMainWindowNavigationUrl('http://127.0.0.1:5173', devRendererEntry)).toBe(false)
    expect(isTrustedMainWindowNavigationUrl('http://localhost:1420', devRendererEntry)).toBe(false)
    expect(isTrustedMainWindowNavigationUrl('https://example.com', devRendererEntry)).toBe(false)
  })

  it('accepts IPC only from the current window while it has a trusted URL', () => {
    const sender = { getURL: () => packagedRendererUrl }
    expect(isTrustedMainWindowSender(sender, sender, packagedRendererEntry)).toBe(true)
    expect(isTrustedMainWindowSender({ getURL: () => packagedRendererUrl }, sender, packagedRendererEntry)).toBe(false)
    expect(isTrustedMainWindowSender(sender, sender, devRendererEntry)).toBe(false)

    expect(isTrustedMainWindowFrame({ parent: null, url: packagedRendererUrl }, packagedRendererEntry)).toBe(true)
    expect(isTrustedMainWindowFrame({ parent: {}, url: packagedRendererUrl }, packagedRendererEntry)).toBe(false)
    expect(isTrustedMainWindowFrame({ parent: null, url: 'https://example.com' }, packagedRendererEntry)).toBe(false)
  })
})

describe('installMainWindowNavigationGuards', () => {
  it('denies popups and routes http(s) ones to the system browser', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererEntry: packagedRendererEntry })

    expect(wc.openWindow('https://example.com')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('denies non-http popups without opening anything', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererEntry: packagedRendererEntry })

    expect(wc.openWindow('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('keeps trusted file renderer navigation working while blocking remote navigation', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererEntry: packagedRendererEntry })

    expect(wc.hasNavigationHandler('will-navigate')).toBe(true)
    expect(wc.navigate(packagedRendererUrl)).not.toHaveBeenCalled()
    expect(wc.navigate('https://example.com')).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('allows development same-origin navigation but blocks another local origin', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererEntry: devRendererEntry })

    expect(wc.navigate('http://127.0.0.1:1420/settings')).not.toHaveBeenCalled()
    expect(wc.navigate('http://127.0.0.1:5173')).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('http://127.0.0.1:5173')
  })

  it('blocks redirects and untrusted subframes before their preload can run', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installMainWindowNavigationGuards(wc.contents, { openExternal, rendererEntry: packagedRendererEntry })

    expect(wc.navigate('https://example.com/redirect', 'will-redirect', { useEventUrl: true })).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/redirect')

    expect(wc.navigate('https://example.com/frame', 'will-frame-navigate', { isMainFrame: false })).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})

describe('installPreviewNavigationGuards', () => {
  it('allows in-page http(s) navigation so the preview keeps working as a browser', () => {
    const wc = fakeWebContents()
    installPreviewNavigationGuards(wc.contents, { openExternal: vi.fn() })

    const preventDefault = wc.navigate('https://example.com/page')
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('blocks navigation to non-http(s) schemes', () => {
    const wc = fakeWebContents()
    installPreviewNavigationGuards(wc.contents, { openExternal: vi.fn() })

    const preventDefault = wc.navigate('file:///etc/passwd')
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })

  it('denies popups and routes http(s) ones to the system browser', () => {
    const openExternal = vi.fn()
    const wc = fakeWebContents()
    installPreviewNavigationGuards(wc.contents, { openExternal })

    expect(wc.openWindow('https://example.com')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })
})
