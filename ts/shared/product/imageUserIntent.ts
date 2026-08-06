export const IMAGE_USER_INTENT_PURPOSES = [
  'sell', 'promote', 'announce', 'inform', 'brand', 'social_engagement', 'personal', 'other', 'unknown',
] as const
export const IMAGE_USER_INTENT_CHANNELS = [
  'social_feed', 'poster', 'product_page', 'presentation', 'story', 'print', 'other', 'unknown',
] as const
export const IMAGE_USER_INTENT_PRIORITIES = [
  'subject', 'product', 'character', 'brand', 'text', 'layout', 'mood', 'background',
] as const

export type ImageUserIntentPayload = {
  purpose: typeof IMAGE_USER_INTENT_PURPOSES[number]
  audience?: string
  channel: typeof IMAGE_USER_INTENT_CHANNELS[number]
  subject?: string
  desired_effect?: string
  style_keywords: string[]
  priority_order: typeof IMAGE_USER_INTENT_PRIORITIES[number][]
}

const PURPOSES = new Set<string>(IMAGE_USER_INTENT_PURPOSES)
const CHANNELS = new Set<string>(IMAGE_USER_INTENT_CHANNELS)
const PRIORITIES = new Set<string>(IMAGE_USER_INTENT_PRIORITIES)
const REQUIRED_KEYS = ['purpose', 'channel', 'style_keywords', 'priority_order'] as const
const OPTIONAL_KEYS = ['audience', 'subject', 'desired_effect'] as const

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
}

/**
 * Dependency-free runtime validation for Gateway's production image. The
 * richer zod schema lives beside the shared image contract; this predicate is
 * intentionally kept free of zod so Gateway does not need to install a package
 * or write a transpiler cache into its read-only container.
 */
export function isImageUserIntent(value: unknown): value is ImageUserIntentPayload {
  const item = record(value)
  if (!item) return false
  const keys = Object.keys(item)
  if (!keys.every(key => (REQUIRED_KEYS as readonly string[]).includes(key) || (OPTIONAL_KEYS as readonly string[]).includes(key))) return false
  if (!REQUIRED_KEYS.every(key => keys.includes(key))) return false
  if (typeof item.purpose !== 'string' || !PURPOSES.has(item.purpose)) return false
  if (typeof item.channel !== 'string' || !CHANNELS.has(item.channel)) return false
  if (item.audience !== undefined && !boundedText(item.audience)) return false
  if (item.subject !== undefined && !boundedText(item.subject)) return false
  if (item.desired_effect !== undefined && !boundedText(item.desired_effect)) return false
  if (!Array.isArray(item.style_keywords) || item.style_keywords.length > 8 || !item.style_keywords.every(boundedText)) return false
  return Array.isArray(item.priority_order)
    && item.priority_order.length <= 8
    && item.priority_order.every(value => typeof value === 'string' && PRIORITIES.has(value))
}
