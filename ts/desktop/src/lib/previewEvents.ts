import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { getDesktopHost } from './desktopHost'
import type { ElementMetadata } from '../preview-agent/metadata'
import type { EditDiff } from '../preview-agent/popover'

export type BrowserPreviewScreenshot = {
  dataUrl: string
  kind?: string
}

export type BrowserPreviewSelection = {
  pageUrl: string
  sourceHint?: string
  element: ElementMetadata
  change?: EditDiff & { description?: string }
  screenshot?: {
    dataUrl?: string
    kind?: string
  }
}

export type BrowserPreviewEventOptions = {
  onScreenshot?: (screenshot: BrowserPreviewScreenshot) => void
  onSelection?: (selection: BrowserPreviewSelection) => void
  isNavigationAllowed?: (url: string) => boolean
}

export type BrowserPreviewEventSubscriber = (
  browserKey: string,
  options?: BrowserPreviewEventOptions,
) => Promise<() => void>

function isSelectionPayload(value: unknown): value is BrowserPreviewSelection {
  if (!value || typeof value !== 'object') return false
  const selection = value as Partial<BrowserPreviewSelection>
  const element = selection.element
  return Boolean(
    element &&
    typeof element === 'object' &&
    typeof (element as { selector?: unknown }).selector === 'string',
  )
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
    let msg: { type?: string; url?: string; title?: string; dataUrl?: string; kind?: string; payload?: unknown }
    try {
      msg = typeof payload === 'string'
        ? JSON.parse(payload)
        : payload as typeof msg
    } catch { return }
    const store = useBrowserPanelStore.getState()
    if (msg.type === 'navigated' && msg.url) {
      if (options.isNavigationAllowed && !options.isNavigationAllowed(msg.url)) return
      store.setNavigated(browserKey, msg.url, msg.title ?? '')
    } else if (msg.type === 'ready') {
      store.setReady(browserKey)
    } else if (msg.type === 'screenshot' && msg.dataUrl) {
      options.onScreenshot?.({ dataUrl: msg.dataUrl, kind: msg.kind })
    } else if (msg.type === 'selection') {
      // A page can forge a preview event. Accept a selection only after a
      // renderer-owned picker gesture armed this specific browser panel.
      const session = store.bySession[browserKey]
      if (!session?.pickerActive) return
      store.setPicker(browserKey, false)
      if (isSelectionPayload(msg.payload)) options.onSelection?.(msg.payload)
    } else if (msg.type === 'picker-exited') {
      store.setPicker(browserKey, false)
    } else if (msg.type === 'error') {
      console.warn('[preview-agent]', msg)
    }
  })
}
