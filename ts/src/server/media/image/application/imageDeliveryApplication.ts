import { ImageApplication } from './imageApplication.js'
import type { ImageDeliveryApplicationPort } from '../runtime/imageApplicationPorts.js'

/** Delivery specifications, immutable exports, Library reuse and Campaign orchestration. */
export class ImageDeliveryApplication extends ImageApplication<ImageDeliveryApplicationPort> {
  readonly listProjectLibrary = this.bind('listProjectLibrary')
  readonly listCampaigns = this.bind('listCampaigns')
  readonly getCampaign = this.bind('getCampaign')
  readonly createCampaign = this.bind('createCampaign')
  readonly replaceCampaignItems = this.bind('replaceCampaignItems')
  readonly estimateCampaign = this.bind('estimateCampaign')
  readonly confirmCampaign = this.bind('confirmCampaign')
  readonly confirmCampaignRetry = this.bind('confirmCampaignRetry')
  readonly startCampaign = this.bind('startCampaign')
  readonly cancelCampaign = this.bind('cancelCampaign')
  readonly retryCampaignItem = this.bind('retryCampaignItem')
  readonly createDeliverySpecRevision = this.bind('createDeliverySpecRevision')
  readonly currentDeliverySpec = this.bind('currentDeliverySpec')
  readonly getDeliverySet = this.bind('getDeliverySet')
  readonly getExportReceipt = this.bind('getExportReceipt')
  readonly readMediaAsset = this.bind('readMediaAsset')
  readonly readVersionAsset = this.bind('readVersionAsset')
  readonly exportDelivery = this.bind('exportDelivery')
  readonly selectVersion = this.bind('selectVersion')
  readonly commitVersion = this.bind('commitVersion')
  readonly saveOutput = this.bind('saveOutput')

  constructor(port: ImageDeliveryApplicationPort) {
    super(port)
  }
}
