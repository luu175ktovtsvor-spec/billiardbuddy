export type ProductTaskRunDispatchPort = {
  dispatch(runId: string, generation: number, kind?: 'interactive' | 'scheduled'): Promise<'started' | 'queued' | 'recovery_required'>
  stop?(runId: string, generation: number): Promise<void>
  approve?(runId: string, generation: number, requestId: string, allowed: boolean): Promise<boolean>
  answer?(runId: string, generation: number, requestId: string, answers: readonly string[]): Promise<boolean>
  steer?(runId: string, generation: number, queueItemId: string, text: string): Promise<boolean>
}
