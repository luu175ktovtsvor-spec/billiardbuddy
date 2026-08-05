import { ImageApplication } from './imageApplication.js'
import type { ImageRecoveryApplicationPort } from '../runtime/imageApplicationPorts.js'

/** Migration, event recovery, Relay acknowledgement and trash/GC operations. */
export class ImageRecoveryApplication extends ImageApplication<ImageRecoveryApplicationPort> {
  readonly listDeletions = this.bind('listDeletions')
  readonly hasProjectHistory = this.bind('hasProjectHistory')
  readonly hasOperationHistory = this.bind('hasOperationHistory')
  readonly deleteProject = this.bind('deleteProject')
  readonly restoreProject = this.bind('restoreProject')
  readonly getOperation = this.bind('getOperation')
  readonly listOperationEvents = this.bind('listOperationEvents')
  readonly waitForOperationEvents = this.bind('waitForOperationEvents')
  readonly recoverInterruptedOperations = this.bind('recoverInterruptedOperations')
  readonly migrateLegacyMediaStore = this.bind('migrateLegacyMediaStore')
  readonly cancelOperation = this.bind('cancelOperation')
  readonly reconcileCampaignItemProjectBinding = this.bind('reconcileCampaignItemProjectBinding')

  constructor(port: ImageRecoveryApplicationPort) {
    super(port)
  }
}
