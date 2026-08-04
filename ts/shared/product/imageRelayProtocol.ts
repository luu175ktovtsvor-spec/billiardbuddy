/** Public Image Relay HTTP contract. It is independent from Gateway's model protocol. */
export const IMAGE_RELAY_TASKS_PATH = '/v1/images/tasks' as const
export const IMAGE_RELAY_RESULTS_PATH = '/v1/images/results' as const

/** Successful status polls stay compact unless the authenticated desktop asks
 * Image Relay to issue short-lived, owner-bound result URLs. */
export const IMAGE_RELAY_RESULT_HANDOFF_HEADER = 'X-BB-Media-Result-Handoff' as const
export const IMAGE_RELAY_RESULT_HANDOFF_DIRECT_V1 = 'direct-v1' as const
