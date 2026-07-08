export const CROSS_SESSION_MESSAGE_TAG = 'cross-session-message'

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

export function formatCrossSessionMessage(from: string, message: string): string {
  return `<${CROSS_SESSION_MESSAGE_TAG} from="${xmlAttr(from)}">\n${xmlText(message)}\n</${CROSS_SESSION_MESSAGE_TAG}>`
}
