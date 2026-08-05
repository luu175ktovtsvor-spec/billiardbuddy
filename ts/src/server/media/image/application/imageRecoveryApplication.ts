import { ImageApplication } from './imageApplication.js'
import type { ImageRecoveryApplicationPort } from '../runtime/imageApplicationPorts.js'
import type { ImageRecoveryRuntimePort } from '../../../services/imageWorkbenchRuntime.js'

/** Migration, event recovery, Relay acknowledgement and trash/GC operations. */
export class ImageRecoveryApplication extends ImageApplication<ImageRecoveryApplicationPort> {
  readonly #recovery: ImageRecoveryRuntimePort

  readonly listDeletions = this.bind('listDeletions')
  readonly hasProjectHistory = this.bind('hasProjectHistory')
  readonly hasOperationHistory = this.bind('hasOperationHistory')
  readonly deleteProject = this.bind('deleteProject')
  readonly restoreProject = this.bind('restoreProject')
  readonly getOperation = this.bind('getOperation')
  readonly listOperationEvents = this.bind('listOperationEvents')
  readonly waitForOperationEvents = this.bind('waitForOperationEvents')
  /**
   * Restart order is intentional and cross-domain: a prepared Campaign
   * cancellation prevents a queued paid POST; remote results are recovered
   * before local Canvas/Export jobs; Gateway advice is ACKed only after its
   * receipt exists; Campaign dispatch is last.
   */
  readonly recoverInterruptedOperations = async (): Promise<void> => {
    await this.#recovery.recoverPreparedCampaignCancellations()

    const transportOperations = await this.#recovery.listTransportOperations()
    await Promise.all(transportOperations.map(async operation => {
      const fenced = await this.#recovery.fenceInterruptedSubmission(operation)
      const formal = await this.#recovery.findGenerationOperationByTransportTask(fenced.id)
      const resumed = formal
        ? await this.#recovery.resumeUnpostedGenerationOperation(fenced, formal)
        : fenced
      const lookedUp = await this.#recovery.recoverOutcomeUnknownOperation(resumed)
      // A committing transport may have published CAS bytes but not made the
      // SQLite Project transaction. The only valid recovery is a read of that
      // exact accepted Relay task; no local success fabrication or new POST.
      const recovered = lookedUp.status === 'committing'
        ? await this.#recovery.refreshPersistedOperation(lookedUp)
        : lookedUp
      await this.#recovery.acknowledgeRemoteResult(recovered)
      const generation = await this.#recovery.findGenerationOperationByTransportTask(recovered.id)
      if (generation) await this.#recovery.syncGenerationOperationFromTransport(generation, recovered)
    }))

    const localDeliveries = await this.#recovery.listRecoverableLocalDeliveryOperations()
    await Promise.all(localDeliveries.map(async operation => {
      if (operation.local_delivery?.kind === 'canvas_render') {
        await this.#recovery.resumeCanvasRender(operation)
      } else if (operation.local_delivery?.kind === 'export') {
        await this.#recovery.resumeExportDelivery(operation)
      }
    }))

    const adviceReceipts = await this.#recovery.listUnacknowledgedGatewayAdviceReceipts()
    await Promise.all(adviceReceipts.map(async receipt => {
      await this.#recovery.acknowledgeQwenGatewayResult(receipt)
    }))
    await this.#recovery.recoverCampaigns()
  }
  readonly migrateLegacyMediaStore = this.bind('migrateLegacyMediaStore')
  readonly cancelOperation = this.bind('cancelOperation')
  readonly reconcileCampaignItemProjectBinding = this.bind('reconcileCampaignItemProjectBinding')

  constructor(port: ImageRecoveryApplicationPort) {
    super(port)
    this.#recovery = port.recovery
  }
}
