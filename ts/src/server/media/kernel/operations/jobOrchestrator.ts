export type RecoverableOperation = { id: string; status: string }

/**
 * Keeps restart traversal deterministic. Resource phases and DAG dependencies
 * are added in later video gates; this first owner already guarantees that a
 * persisted operation is recovered from storage rather than an in-memory map.
 */
export class JobOrchestrator<T extends RecoverableOperation> {
  constructor(
    private readonly loadRecoverable: () => Promise<T[]>,
    private readonly recoverOne: (operation: T) => Promise<void>,
  ) {}

  async recover(): Promise<void> {
    for (const operation of await this.loadRecoverable()) {
      await this.recoverOne(operation)
    }
  }
}
