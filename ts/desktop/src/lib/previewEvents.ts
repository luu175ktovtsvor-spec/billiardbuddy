import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { getDesktopHost } from './desktopHost'
import type { ElementMetadata } from '../preview-agent/metadata'

export type BrowserPreviewScreenshot = {
  dataUrl: string
  kind?: string
  captureId?: string
}

export type BrowserPreviewSelection = {
  pageUrl: string
  sourceHint?: string
  element: ElementMetadata
  screenshot?: {
    dataUrl?: string
    kind?: string
  }
}

export type BrowserPreviewEventOptions = {
  onScreenshot?: (screenshot: BrowserPreviewScreenshot) => void
  onSelection?: (selection: BrowserPreviewSelection) => void
  onNavigated?: (url: string) => void
  isNavigationAllowed?: (url: string) => boolean
}

export type BrowserPreviewEventSubscriber = (
  browserKey: string,
  options?: BrowserPreviewEventOptions,
) => Promise<() => void>

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeSelectionPayload(value: unknown): BrowserPreviewSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const selection = value as Record<string, unknown>
  const pageUrl = boundedString(selection.pageUrl, 2_048)
  try {
    if (!pageUrl || !['http:', 'https:'].includes(new URL(pageUrl).protocol)) return null
  } catch {
    return null
  }

  const rawElement = selection.element
  if (!rawElement || typeof rawElement !== 'object' || Array.isArray(rawElement)) return null
  const element = rawElement as Record<string, unknown>
  const selector = boundedString(element.selector, 1_024)
  const nthPath = boundedString(element.nthPath, 2_048)
  const tag = boundedString(element.tag, 64)
  const rawClasses = element.classes
  const rawBounds = element.boundingBox
  const rawStyles = element.computedStyles
  if (
    !selector || !nthPath || !tag || !/^[a-z][a-z0-9-]*$/i.test(tag) ||
    !Array.isArray(rawClasses) || rawClasses.length > 16 ||
    !rawBounds || typeof rawBounds !== 'object' || Array.isArray(rawBounds) ||
    !rawStyles || typeof rawStyles !== 'object' || Array.isArray(rawStyles)
  ) return null

  const classes = rawClasses.map(value => boundedString(value, 64))
  if (classes.some(value => value === undefined)) return null
  const bounds = rawBounds as Record<string, unknown>
  const x = finiteNumber(bounds.x)
  const y = finiteNumber(bounds.y)
  const w = finiteNumber(bounds.w)
  const h = finiteNumber(bounds.h)
  if (x === undefined || y === undefined || w === undefined || h === undefined || w < 0 || h < 0) return null

  const styleEntries = Object.entries(rawStyles)
  if (styleEntries.length > 16) return null
  const computedStyles: Record<string, string> = {}
  for (const [key, rawValue] of styleEntries) {
    const styleValue = boundedString(rawValue, 256)
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(key) || styleValue === undefined) return null
    computedStyles[key] = styleValue
  }

  const sourceHint = boundedString(selection.sourceHint, 256)
  const id = boundedString(element.id, 128)
  const text = boundedString(element.text, 500)
  const outerHtmlSnippet = boundedString(element.outerHtmlSnippet, 512)
  const normalized: BrowserPreviewSelection = {
    pageUrl,
    ...(sourceHint ? { sourceHint } : {}),
    element: {
      selector,
      nthPath,
      tag: tag.toLowerCase(),
      ...(id ? { id } : {}),
      classes: classes as string[],
      ...(text ? { text } : {}),
      boundingBox: { x, y, w, h },
      computedStyles,
      ...(outerHtmlSnippet ? { outerHtmlSnippet } : {}),
    },
  }

  const screenshot = selection.screenshot
  if (screenshot !== undefined) {
    if (!screenshot || typeof screenshot !== 'object' || Array.isArray(screenshot)) return null
    const rawScreenshot = screenshot as Record<string, unknown>
    const kind = boundedString(rawScreenshot.kind, 16)
    const dataUrl = boundedString(rawScreenshot.dataUrl, 8 * 1024 * 1024)
    if (rawScreenshot.kind !== undefined && kind === undefined) return null
    if (rawScreenshot.dataUrl !== undefined && dataUrl === undefined) return null
    if (kind && !['full', 'viewport', 'element', 'region'].includes(kind)) return null
    if (dataUrl && !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(dataUrl)) return null
    normalized.screenshot = {
      ...(kind ? { kind } : {}),
      ...(dataUrl ? { dataUrl } : {}),
    }
  }
  return normalized
}

function isPreviewCaptureId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-zA-Z_-]{16,64}$/.test(value)
}

/**
 * Subscribe the native preview host to a browser-panel key without assuming
 * that key is an Agent Core session. Callers opt into screenshot and selection
 * handling explicitly; navigation and readiness remain generic panel state.
 */
export const subscribePreviewEvents: BrowserPreviewEventSubscriber = async (
  browserKey,
  options = {},
) => {
  const host = getDesktopHost()
  if (!host.capabilities.previewWebview) return () => {}

  return host.preview.onEvent((payload) => {
    let msg: {
      type?: string
      url?: string
      title?: string
      dataUrl?: string
      kind?: string
      captureId?: unknown
      payload?: unknown
    }
    try {
      msg = typeof payload === 'string'
        ? JSON.parse(payload)
        : payload as typeof msg
    } catch { return }
    const store = useBrowserPanelStore.getState()
    if (msg.type === 'navigated' && msg.url) {
      if (options.isNavigationAllowed && !options.isNavigationAllowed(msg.url)) return
      store.setNavigated(browserKey, msg.url, msg.title ?? '')
      options.onNavigated?.(msg.url)
    } else if (msg.type === 'ready') {
      store.setReady(browserKey)
    } else if (msg.type === 'screenshot' && msg.dataUrl) {
      options.onScreenshot?.({
        dataUrl: msg.dataUrl,
        kind: msg.kind,
        ...(isPreviewCaptureId(msg.captureId) ? { captureId: msg.captureId } : {}),
      })
    } else if (msg.type === 'selection') {
      // A page can forge a preview event. Accept a selection only after a
      // renderer-owned picker gesture armed this specific browser panel.
      const session = store.bySession[browserKey]
      if (!session?.pickerActive) return
      store.setPicker(browserKey, false)
      const selection = normalizeSelectionPayload(msg.payload)
      if (selection?.pageUrl === session.url) options.onSelection?.(selection)
    } else if (msg.type === 'picker-exited') {
      store.setPicker(browserKey, false)
    } else if (msg.type === 'error') {
      console.warn('[preview-agent]', msg)
    }
  })
}
