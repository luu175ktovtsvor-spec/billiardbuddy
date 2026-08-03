export type RecoveryStep = { name: string; recover: () => Promise<void> }

/** Runs durable recovery steps in an explicit order before serving requests. */
export class RecoverySupervisor {
  constructor(private readonly steps: RecoveryStep[]) {}

  async recover(): Promise<void> {
    for (const step of this.steps) await step.recover()
  }
}
