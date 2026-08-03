export type ProviderSmokeCancelAction = 'attempt_cancel' | 'do_not_cancel'

/**
 * The current cancellation contract only promises cancellation for a task
 * still queued at the last observation point. A task may start after that
 * observation, which the protocol reports as a 409 cancellation race.
 */
export function providerSmokeCancelAction(lastKnownStatus: string | undefined): ProviderSmokeCancelAction {
  return lastKnownStatus === 'queued' ? 'attempt_cancel' : 'do_not_cancel'
}
