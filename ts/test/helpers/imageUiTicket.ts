import { MEDIA_UI_CAPABILITY_HEADER } from '../../shared/contracts/media.js'
import { issueImageUiCapabilityTicket } from '../../shared/product/imageUiCapabilityTicket.js'

/**
 * Existing image API fixtures keep a `MEDIA_UI_CAPABILITY_HEADER` value as a
 * local HMAC test key. This helper replaces that test-only key with the same
 * short-lived request ticket Electron Main would issue in production.
 */
export function imageTicketRequest(url: URL, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  const ticketSecret = headers.get(MEDIA_UI_CAPABILITY_HEADER)?.trim() ?? ''
  if (!ticketSecret) return new Request(url, init)
  headers.delete(MEDIA_UI_CAPABILITY_HEADER)
  const body = typeof init.body === 'string' ? init.body : ''
  headers.set('Origin', url.origin)
  headers.set(MEDIA_UI_CAPABILITY_HEADER, issueImageUiCapabilityTicket(ticketSecret, {
    method: init.method ?? 'GET',
    url,
    body,
    range: headers.get('Range'),
  }))
  return new Request(url, { ...init, headers })
}

export function imageTicketHeaders(
  ticketSecret: string,
  url: URL,
  init: Pick<RequestInit, 'method' | 'body' | 'headers'> = {},
): Headers {
  const headers = new Headers(init.headers)
  const body = typeof init.body === 'string' ? init.body : ''
  headers.set('Origin', url.origin)
  headers.set(MEDIA_UI_CAPABILITY_HEADER, issueImageUiCapabilityTicket(ticketSecret, {
    method: init.method ?? 'GET',
    url,
    body,
    range: headers.get('Range'),
  }))
  return headers
}
