import type { ImageWorkbenchRuntime } from '../../../services/imageWorkbenchRuntime.js'

type ImageProjectPortNames =
  | 'listProjects' | 'getProject' | 'getProjectProjection' | 'assertProjectOwner'
  | 'createProject' | 'quickCreate' | 'updateProject' | 'addReferences' | 'compileBrief'
  | 'applyBriefOverrides' | 'addWorkflowReferences' | 'removeWorkflowReference'
  | 'getInspirationBoard' | 'upsertInspirationItems' | 'promoteInspirationItem'
  | 'listBrandKits' | 'getBrandKit' | 'createBrandKit' | 'reviseBrandKit' | 'trashBrandKit'
  | 'listTemplates' | 'getTemplate' | 'createTemplate' | 'reviseTemplate' | 'trashTemplate'
  | 'createAssetGrant' | 'revokeAssetGrant' | 'listAssetGrants'
  | 'saveBrandKitRevision' | 'saveTemplateRevision'

type ImageGenerationPortNames =
  | 'understandProject' | 'assessCandidateVisual' | 'assessVersionVisual'
  | 'updateReferenceControl' | 'createCreativePlan' | 'getCreativePlan'
  | 'estimateGenerationRound' | 'createGenerationRound' | 'estimateDerivation'
  | 'deriveCandidate' | 'getGenerationOperation' | 'findGenerationOperation'
  | 'cancelGenerationOperation' | 'listGenerationOperations' | 'getGenerationRound'
  | 'getCandidateGroup' | 'getCandidate' | 'decideCandidate' | 'adoptCandidate'
  | 'readCandidateAsset' | 'submitProject' | 'startOperation'

type ImageCanvasPortNames =
  | 'getCanvas' | 'listCanvases' | 'createCanvas' | 'applyCanvasCommand'
  | 'preflightCanvas' | 'renderCanvas' | 'selectArtboardVersion'

type ImageDeliveryPortNames =
  | 'listProjectLibrary' | 'listCampaigns' | 'getCampaign' | 'createCampaign'
  | 'replaceCampaignItems' | 'estimateCampaign' | 'confirmCampaign' | 'confirmCampaignRetry'
  | 'startCampaign' | 'cancelCampaign' | 'retryCampaignItem' | 'createDeliverySpecRevision'
  | 'currentDeliverySpec' | 'getDeliverySet' | 'getExportReceipt' | 'readMediaAsset'
  | 'readVersionAsset' | 'exportDelivery' | 'selectVersion' | 'commitVersion' | 'saveOutput'

type ImageRecoveryPortNames =
  | 'listDeletions' | 'hasProjectHistory' | 'hasOperationHistory' | 'deleteProject'
  | 'restoreProject' | 'getOperation' | 'listOperationEvents' | 'waitForOperationEvents'
  | 'recoverInterruptedOperations' | 'migrateLegacyMediaStore' | 'cancelOperation'
  | 'reconcileCampaignItemProjectBinding'

export type ImageProjectApplicationPort = Pick<ImageWorkbenchRuntime, ImageProjectPortNames>
export type ImageGenerationApplicationPort = Pick<ImageWorkbenchRuntime, ImageGenerationPortNames>
export type ImageCanvasApplicationPort = Pick<ImageWorkbenchRuntime, ImageCanvasPortNames>
export type ImageDeliveryApplicationPort = Pick<ImageWorkbenchRuntime, ImageDeliveryPortNames>
export type ImageRecoveryApplicationPort = Pick<ImageWorkbenchRuntime, ImageRecoveryPortNames>

export type ImageApplicationPorts = {
  project: ImageProjectApplicationPort
  generation: ImageGenerationApplicationPort
  canvas: ImageCanvasApplicationPort
  delivery: ImageDeliveryApplicationPort
  recovery: ImageRecoveryApplicationPort
}

function bindPort<Names extends keyof ImageWorkbenchRuntime>(runtime: ImageWorkbenchRuntime, names: readonly Names[]): Pick<ImageWorkbenchRuntime, Names> {
  const port: Partial<Pick<ImageWorkbenchRuntime, Names>> = {}
  for (const name of names) {
    const member = runtime[name]
    if (typeof member !== 'function') throw new Error(`Image runtime member ${String(name)} is not callable`)
    Reflect.set(port, name, member.bind(runtime))
  }
  return Object.freeze(port) as Pick<ImageWorkbenchRuntime, Names>
}

/** Only the image composition root may turn the shared runtime into scoped ports. */
export function createImageApplicationPorts(runtime: ImageWorkbenchRuntime): ImageApplicationPorts {
  return {
    project: bindPort(runtime, [
      'listProjects', 'getProject', 'getProjectProjection', 'assertProjectOwner', 'createProject', 'quickCreate',
      'updateProject', 'addReferences', 'compileBrief', 'applyBriefOverrides', 'addWorkflowReferences',
      'removeWorkflowReference', 'getInspirationBoard', 'upsertInspirationItems', 'promoteInspirationItem',
      'listBrandKits', 'getBrandKit', 'createBrandKit', 'reviseBrandKit', 'trashBrandKit', 'listTemplates',
      'getTemplate', 'createTemplate', 'reviseTemplate', 'trashTemplate', 'createAssetGrant',
      'revokeAssetGrant', 'listAssetGrants', 'saveBrandKitRevision', 'saveTemplateRevision',
    ]),
    generation: bindPort(runtime, [
      'understandProject', 'assessCandidateVisual', 'assessVersionVisual', 'updateReferenceControl',
      'createCreativePlan', 'getCreativePlan', 'estimateGenerationRound', 'createGenerationRound',
      'estimateDerivation', 'deriveCandidate', 'getGenerationOperation', 'findGenerationOperation',
      'cancelGenerationOperation', 'listGenerationOperations', 'getGenerationRound', 'getCandidateGroup',
      'getCandidate', 'decideCandidate', 'adoptCandidate', 'readCandidateAsset', 'submitProject', 'startOperation',
    ]),
    canvas: bindPort(runtime, [
      'getCanvas', 'listCanvases', 'createCanvas', 'applyCanvasCommand', 'preflightCanvas', 'renderCanvas',
      'selectArtboardVersion',
    ]),
    delivery: bindPort(runtime, [
      'listProjectLibrary', 'listCampaigns', 'getCampaign', 'createCampaign', 'replaceCampaignItems',
      'estimateCampaign', 'confirmCampaign', 'confirmCampaignRetry', 'startCampaign', 'cancelCampaign',
      'retryCampaignItem', 'createDeliverySpecRevision', 'currentDeliverySpec', 'getDeliverySet',
      'getExportReceipt', 'readMediaAsset', 'readVersionAsset', 'exportDelivery', 'selectVersion',
      'commitVersion', 'saveOutput',
    ]),
    recovery: bindPort(runtime, [
      'listDeletions', 'hasProjectHistory', 'hasOperationHistory', 'deleteProject', 'restoreProject',
      'getOperation', 'listOperationEvents', 'waitForOperationEvents', 'recoverInterruptedOperations',
      'migrateLegacyMediaStore', 'cancelOperation', 'reconcileCampaignItemProjectBinding',
    ]),
  }
}
