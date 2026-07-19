/**
 * Product task sockets are a browser-visible, task-scoped boundary rather than
 * a second transport for the Agent Core protocol. Keep the accepted input
 * intentionally small until each product action has its own safe contract.
 */

export type ProductTaskInboundMessage =
  | { type: 'user_message'; content: string }
  | { type: 'stop_generation' }
  | { type: 'ping' }

const MAX_PRODUCT_USER_MESSAGE_LENGTH = 32_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/**
 * Parse the public product-task websocket input. In particular, do not pass
 * through Agent Core permission payloads, runtime/configuration commands,
 * prewarming, or attachments. Slash commands remain ordinary task text: the
 * existing session command parser is the authority for their semantics. A
 * future product action must define a dedicated, validated message before it
 * is accepted here.
 */
export function parseProductTaskInboundMessage(value: unknown): ProductTaskInboundMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null

  switch (value.type) {
    case 'user_message': {
      if (!hasOnlyKeys(value, ['type', 'content']) || typeof value.content !== 'string') {
        return null
      }

      const content = value.content.trim()
      if (
        !content ||
        content.length > MAX_PRODUCT_USER_MESSAGE_LENGTH
      ) {
        return null
      }

      return { type: 'user_message', content }
    }

    case 'stop_generation':
    case 'ping':
      return hasOnlyKeys(value, ['type']) ? { type: value.type } : null

    default:
      return null
  }
}
