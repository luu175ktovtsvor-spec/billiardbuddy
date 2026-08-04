/** Public Image Relay HTTP contract. It is independent from Gateway's model protocol. */
export const IMAGE_RELAY_TASKS_PATH = '/v1/images/tasks' as const
export const IMAGE_RELAY_RESULTS_PATH = '/v1/images/results' as const
export const IMAGE_RELAY_IDEMPOTENCY_LOOKUP_PATH = `${IMAGE_RELAY_TASKS_PATH}/by-idempotency` as const

/**
 * Stable, provider-neutral failures from the public Image Relay.  `error`
 * remains a human-safe diagnostic for compatibility; callers must branch only
 * on these codes.  A quota result means the hosted image gift is exhausted for
 * this UTC period, not that the user lost access to Agent or video features.
 */
export const IMAGE_RELAY_QUOTA_ERROR_CODES = [
  'image_owner_quota_exhausted',
  'image_provider_quota_exhausted',
] as const
export type ImageRelayQuotaErrorCode = (typeof IMAGE_RELAY_QUOTA_ERROR_CODES)[number]

export function isImageRelayQuotaErrorCode(value: unknown): value is ImageRelayQuotaErrorCode {
  return typeof value === 'string' && (IMAGE_RELAY_QUOTA_ERROR_CODES as readonly string[]).includes(value)
}

export const IMAGE_RELAY_QUEUE_FULL_ERROR = 'image_queue_full' as const

/** Recovery lookup for a request whose submit response was lost. This endpoint
 * only observes an already persisted Relay task; a miss must never trigger a
 * fresh paid submission. */
export function imageRelayIdempotencyLookupPath(idempotencyKey: string): string {
  return `${IMAGE_RELAY_IDEMPOTENCY_LOOKUP_PATH}/${encodeURIComponent(idempotencyKey)}`
}

/** Successful status polls stay compact unless the authenticated desktop asks
 * Image Relay to issue short-lived, owner-bound result URLs. */
export const IMAGE_RELAY_RESULT_HANDOFF_HEADER = 'X-BB-Media-Result-Handoff' as const
export const IMAGE_RELAY_RESULT_HANDOFF_DIRECT_V1 = 'direct-v1' as const
