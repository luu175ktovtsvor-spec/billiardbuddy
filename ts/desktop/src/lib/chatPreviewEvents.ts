import { useChatStore } from '../stores/chatStore'
import { buildSelectionDirectMessage } from './selectionComposer'
import {
  subscribePreviewEvents,
  type BrowserPreviewEventSubscriber,
} from './previewEvents'

function kindLabel(kind?: string): string {
  if (kind === 'viewport') return 'viewport'
  if (kind === 'element') return 'element'
  return 'full'
}

/**
 * Legacy Agent-Core composer adapter. Product task pages deliberately use the
 * generic preview subscriber instead, so their public task keys never touch
 * ChatStore or a Core session composer.
 */
export const subscribeChatPreviewEvents: BrowserPreviewEventSubscriber = (
  sessionId,
  options = {},
) => subscribePreviewEvents(sessionId, {
  ...options,
  onScreenshot: options.onScreenshot ?? ((screenshot) => {
    useChatStore.getState().queueComposerPrefill(sessionId, {
      text: '',
      mode: 'append',
      attachments: [{
        type: 'image',
        name: `screenshot-${kindLabel(screenshot.kind)}.png`,
        mimeType: 'image/png',
        data: screenshot.dataUrl,
      }],
    })
  }),
  onSelection: options.onSelection ?? ((selectionPayload) => {
    const selection = buildSelectionDirectMessage(selectionPayload)
    const attachments = selectionPayload.screenshot?.dataUrl
      ? [{
          type: 'image' as const,
          name: selection.displayName,
          mimeType: 'image/png',
          data: selectionPayload.screenshot.dataUrl,
          note: selection.note,
          quote: selectionPayload.element.selector,
        }]
      : []
    useChatStore.getState().queueComposerPrefill(sessionId, {
      text: selection.modelText,
      attachments,
      mode: 'replace',
    })
  }),
})
