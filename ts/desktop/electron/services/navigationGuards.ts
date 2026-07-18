import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

export type WindowOpenHandlerResult = { action: 'deny' } | { action: 'allow' }

type NavigationGuardEvent = {
  preventDefault(): void
  url?: string
  isMainFrame?: boolean
}

type NavigationGuardHandler = (event: NavigationGuardEvent, url?: string) => void

export type NavigationGuardWebContents = {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void
  on(event: 'will-navigate' | 'will-redirect' | 'will-frame-navigate', handler: NavigationGuardHandler): unknown
}

export type NavigationGuardOptions = {
  openExternal: (url: string) => void | Promise<void>
}

export type MainWindowNavigationGuardOptions = NavigationGuardOptions & {
  rendererEntry: string
}

export type TrustedMainWindowSender = {
  getURL(): string
}

export type TrustedMainWindowFrame = {
  parent: unknown | null
  url: string
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function asRendererUrl(rendererEntry: string): URL | null {
  try {
    const parsed = new URL(rendererEntry)
    if (parsed.protocol === 'file:' || parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed
    }
  } catch {
    // Renderer entries are normally absolute file paths, which are converted below.
  }

  if (!isAbsolute(rendererEntry)) return null

  try {
    return pathToFileURL(rendererEntry)
  } catch {
    return null
  }
}

/**
 * The app preload exposes intentionally narrow IPC capabilities. They are only
 * safe for the product renderer itself: a packaged app accepts its exact file
 * entry, while development accepts navigation within the configured local
 * renderer origin so Vite/HMR keeps working.
 */
export function isTrustedMainWindowNavigationUrl(url: string, rendererEntry: string): boolean {
  const candidate = (() => {
    try {
      return new URL(url)
    } catch {
      return null
    }
  })()
  const trustedEntry = asRendererUrl(rendererEntry)
  if (!candidate || !trustedEntry) return false

  if (trustedEntry.protocol === 'file:') {
    return candidate.protocol === 'file:'
      && candidate.host === trustedEntry.host
      && candidate.pathname === trustedEntry.pathname
  }

  return candidate.protocol === trustedEntry.protocol
    && candidate.origin === trustedEntry.origin
    && candidate.username === ''
    && candidate.password === ''
}

/**
 * IPC is accepted only from the current product window after it has loaded a
 * trusted renderer entry. This keeps a newly-created or navigated WebContents
 * from using the preload bridge even if another guard is bypassed.
 */
export function isTrustedMainWindowSender(
  sender: TrustedMainWindowSender,
  mainWindowWebContents: TrustedMainWindowSender | null | undefined,
  rendererEntry: string,
): boolean {
  return sender === mainWindowWebContents
    && isTrustedMainWindowNavigationUrl(sender.getURL(), rendererEntry)
}

export function isTrustedMainWindowFrame(
  frame: TrustedMainWindowFrame | null | undefined,
  rendererEntry: string,
): boolean {
  return frame?.parent === null
    && isTrustedMainWindowNavigationUrl(frame.url, rendererEntry)
}

function navigationUrl(event: NavigationGuardEvent, legacyUrl?: string): string | null {
  if (typeof event.url === 'string') return event.url
  return typeof legacyUrl === 'string' ? legacyUrl : null
}

function openExternalSafely(openExternal: NavigationGuardOptions['openExternal'], url: string): void {
  try {
    void Promise.resolve(openExternal(url)).catch(() => undefined)
  } catch {
    // A failure to open an external browser must not restore the blocked navigation.
  }
}

/**
 * Main app window guard. The renderer is a single-page app loaded from a fixed
 * entry; it should never spawn an uncontrolled child window. Any window.open /
 * target=_blank with an http(s) URL is routed to the system browser and the
 * Electron popup is denied. Top-level navigation, redirects, and subframe
 * navigation are allowed only for the renderer entry itself. Other http(s)
 * top-level destinations are handed to the system browser; non-http(s) URLs
 * are denied outright.
 */
export function installMainWindowNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal, rendererEntry }: MainWindowNavigationGuardOptions,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (!isTrustedMainWindowNavigationUrl(url, rendererEntry) && isHttpUrl(url)) {
      openExternalSafely(openExternal, url)
    }
    return { action: 'deny' }
  })

  const blockUntrustedNavigation = (
    event: NavigationGuardEvent,
    legacyUrl?: string,
    openInSystemBrowser = true,
  ) => {
    const url = navigationUrl(event, legacyUrl)
    if (!url) {
      event.preventDefault()
      return
    }
    if (isTrustedMainWindowNavigationUrl(url, rendererEntry)) return

    event.preventDefault()
    if (openInSystemBrowser && isHttpUrl(url)) openExternalSafely(openExternal, url)
  }

  // `will-navigate` covers user/page-initiated top-level navigation. The
  // separate redirect guard also covers redirects after the initial renderer
  // request (including redirects caused by a compromised dev server).
  webContents.on('will-navigate', (event, url) => {
    blockUntrustedNavigation(event, url)
  })
  webContents.on('will-redirect', (event, url) => {
    blockUntrustedNavigation(event, url, event.isMainFrame !== false)
  })
  // Preload code must not become available to an untrusted iframe. Main-frame
  // navigations are handled above to avoid opening an external link twice.
  webContents.on('will-frame-navigate', (event, url) => {
    if (event.isMainFrame === true) return
    blockUntrustedNavigation(event, url, false)
  })
}

/**
 * Preview (WebContentsView) guard. The preview renders untrusted remote pages,
 * so it must keep working as a browser: in-page http(s) navigation is allowed.
 * Popups are denied (http(s) ones handed to the system browser), and navigation
 * to any non-http(s) scheme (file:, custom schemes) is blocked outright.
 */
export function installPreviewNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal }: NavigationGuardOptions,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    const target = navigationUrl(event, url)
    if (!target || !isHttpUrl(target)) event.preventDefault()
  })
}
