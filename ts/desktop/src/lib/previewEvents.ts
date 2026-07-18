import { useBrowserPanelStore } from '../stores/browserPanelStore'
import { useChatStore } from '../stores/chatStore'
import { getDesktopHost } from './desktopHost'
import { buildSelectionDirectMessage, type SelectionPayload } from './selectionComposer'

function kindLabel(kind?: string): string {
  if (kind === 'viewport') return 'viewport'
  if (kind === 'element') return 'element'
  return 'full'
}

export async function subscribePreviewEvents(sessionId: string): Promise<() => void> {
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
    if (msg.type === 'navigated' && msg.url) store.setNavigated(sessionId, msg.url, msg.title ?? '')
    else if (msg.type === 'ready') store.setReady(sessionId)
    else if (msg.type === 'screenshot' && msg.dataUrl) {
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: '',
        mode: 'append',
        attachments: [{ type: 'image', name: `screenshot-${kindLabel(msg.kind)}.png`, mimeType: 'image/png', data: msg.dataUrl }],
      })
    }
    else if (msg.type === 'selection') {
      // A page can call APIs exposed in its own main world. Only consume a
      // selection while the renderer is also expecting the user's picker gesture.
      const session = store.bySession[sessionId]
      if (!session?.pickerActive) return
      store.setPicker(sessionId, false)
      const p = msg.payload as (SelectionPayload & { screenshot?: { dataUrl?: string; kind?: string } }) | undefined
      if (!p || typeof p !== 'object' || !p.element) return
      const selection = buildSelectionDirectMessage(p)
      const attachments = p.screenshot?.dataUrl
        ? [{
            type: 'image' as const,
            name: selection.displayName,
            mimeType: 'image/png',
            data: p.screenshot.dataUrl,
            note: selection.note,
            quote: p.element.selector,
          }]
        : []
      useChatStore.getState().queueComposerPrefill(sessionId, {
        text: selection.modelText,
        attachments,
        mode: 'replace',
      })
    }
    else if (msg.type === 'picker-exited') {
      store.setPicker(sessionId, false)
    }
    else if (msg.type === 'error') {
      console.warn('[preview-agent]', msg)
    }
  })
}
