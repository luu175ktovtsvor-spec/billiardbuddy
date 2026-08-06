import type {
  ImageCreativePlanRuntimePort,
  ImageCanvasCommandRuntimePort,
  ImageExportDeliveryRuntimePort,
  ImageReferenceControlRuntimePort,
  ImageRecoveryRuntimePort,
  ImageWorkbenchRuntime,
} from '../../../services/imageWorkbenchRuntime.js'

type ImageProjectPortNames =
  | 'listProjects' | 'getProject' | 'getProjectProjection' | 'assertProjectOwner'
  | 'generationPreferencesCatalog'
  | 'createProject' | 'quickCreate' | 'updateProject' | 'addReferences' | 'compileBrief'
  | 'applyBriefOverrides' | 'addWorkflowReferences' | 'removeWorkflowReference'
  | 'getInspirationBoard' | 'upsertInspirationItems' | 'promoteInspirationItem'
  | 'listBrandKits' | 'getBrandKit' | 'createBrandKit' | 'reviseBrandKit' | 'trashBrandKit'
  | 'listTemplates' | 'getTemplate' | 'createTemplate' | 'reviseTemplate' | 'trashTemplate'
  | 'createAssetGrant' | 'revokeAssetGrant' | 'listAssetGrants'
  | 'saveBrandKitRevision' | 'saveTemplateRevision'

type ImageGenerationPortNames =
  | 'understandProject' | 'assessCandidateVisual' | 'assessVersionVisual'
  | 'getCreativePlan'
  | 'estimateGenerationRound' | 'createGenerationRound' | 'estimateDerivation' | 'estimateVersionDerivation'
  | 'deriveCandidate' | 'deriveVersion' | 'getGenerationOperation' | 'findGenerationOperation'
  | 'cancelGenerationOperation' | 'listGenerationOperations' | 'getGenerationRound'
  | 'getCandidateGroup' | 'getCandidate' | 'decideCandidate' | 'adoptCandidate'
  | 'readCandidateAsset' | 'submitProject' | 'startOperation'

type ImageCanvasPortNames =
  | 'getCanvas' | 'listCanvases' | 'createCanvas'
  | 'preflightCanvas' | 'renderCanvas' | 'selectArtboardVersion'

type ImageDeliveryPortNames =
  | 'listProjectLibrary' | 'listCampaigns' | 'getCampaign' | 'createCampaign'
  | 'replaceCampaignItems' | 'estimateCampaign' | 'confirmCampaign' | 'confirmCampaignRetry'
  | 'startCampaign' | 'cancelCampaign' | 'retryCampaignItem' | 'createDeliverySpecRevision'
  | 'currentDeliverySpec' | 'getDeliverySet' | 'getExportReceipt' | 'readMediaAsset'
  | 'readVersionAsset' | 'selectVersion' | 'commitVersion' | 'saveOutput'

type ImageRecoveryPortNames =
  | 'listDeletions' | 'hasProjectHistory' | 'hasOperationHistory' | 'deleteProject'
  | 'restoreProject' | 'getOperation' | 'listOperationEvents' | 'waitForOperationEvents'
  | 'migrateLegacyMediaStore' | 'cancelOperation'
  | 'reconcileCampaignItemProjectBinding'

export type ImageProjectApplicationPort = Pick<ImageWorkbenchRuntime, ImageProjectPortNames> & {
  /** The one Reference Control primitive owned by the Project Application. */
  referenceControl: ImageReferenceControlRuntimePort
}
export type ImageGenerationApplicationPort = Pick<ImageWorkbenchRuntime, ImageGenerationPortNames> & {
  /** The one Creative Plan primitive owned by the Generation Application. */
  creativePlan: ImageCreativePlanRuntimePort
}
export type ImageCanvasApplicationPort = Pick<ImageWorkbenchRuntime, ImageCanvasPortNames> & {
  /** The one SQLite-backed Canvas command primitive owned by Canvas Application. */
  canvasCommand: ImageCanvasCommandRuntimePort
}
export type ImageDeliveryApplicationPort = Pick<ImageWorkbenchRuntime, ImageDeliveryPortNames> & {
  /** Durable accept/schedule boundary owned by ImageDeliveryApplication. */
  exportDelivery: ImageExportDeliveryRuntimePort
}
export type ImageRecoveryApplicationPort = Pick<ImageWorkbenchRuntime, ImageRecoveryPortNames> & {
  /** Restart orchestration belongs to Recovery; Runtime exposes only mechanics. */
  recovery: ImageRecoveryRuntimePort
}

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
    project: Object.freeze({
      ...bindPort(runtime, [
        'listProjects', 'getProject', 'getProjectProjection', 'assertProjectOwner', 'generationPreferencesCatalog', 'createProject', 'quickCreate',
        'updateProject', 'addReferences', 'compileBrief', 'applyBriefOverrides', 'addWorkflowReferences',
        'removeWorkflowReference', 'getInspirationBoard', 'upsertInspirationItems', 'promoteInspirationItem',
        'listBrandKits', 'getBrandKit', 'createBrandKit', 'reviseBrandKit', 'trashBrandKit', 'listTemplates',
        'getTemplate', 'createTemplate', 'reviseTemplate', 'trashTemplate', 'createAssetGrant',
        'revokeAssetGrant', 'listAssetGrants', 'saveBrandKitRevision', 'saveTemplateRevision',
      ]),
      referenceControl: runtime.createReferenceControlPort(),
    }),
    generation: Object.freeze({
      ...bindPort(runtime, [
        'understandProject', 'assessCandidateVisual', 'assessVersionVisual',
        'getCreativePlan', 'estimateGenerationRound', 'createGenerationRound',
        'estimateDerivation', 'estimateVersionDerivation', 'deriveCandidate', 'deriveVersion', 'getGenerationOperation', 'findGenerationOperation',
        'cancelGenerationOperation', 'listGenerationOperations', 'getGenerationRound', 'getCandidateGroup',
        'getCandidate', 'decideCandidate', 'adoptCandidate', 'readCandidateAsset', 'submitProject', 'startOperation',
      ]),
      creativePlan: runtime.createCreativePlanPort(),
    }),
    canvas: Object.freeze({
      ...bindPort(runtime, [
        'getCanvas', 'listCanvases', 'createCanvas', 'preflightCanvas', 'renderCanvas', 'selectArtboardVersion',
      ]),
      canvasCommand: runtime.createCanvasCommandPort(),
    }),
    delivery: Object.freeze({
      ...bindPort(runtime, [
        'listProjectLibrary', 'listCampaigns', 'getCampaign', 'createCampaign', 'replaceCampaignItems',
        'estimateCampaign', 'confirmCampaign', 'confirmCampaignRetry', 'startCampaign', 'cancelCampaign',
        'retryCampaignItem', 'createDeliverySpecRevision', 'currentDeliverySpec', 'getDeliverySet',
        'getExportReceipt', 'readMediaAsset', 'readVersionAsset', 'selectVersion', 'commitVersion', 'saveOutput',
      ]),
      exportDelivery: runtime.createExportDeliveryPort(),
    }),
    recovery: Object.freeze({
      ...bindPort(runtime, [
        'listDeletions', 'hasProjectHistory', 'hasOperationHistory', 'deleteProject', 'restoreProject',
        'getOperation', 'listOperationEvents', 'waitForOperationEvents', 'migrateLegacyMediaStore',
        'cancelOperation', 'reconcileCampaignItemProjectBinding',
      ]),
      recovery: runtime.createRecoveryPort(),
    }),
  }
}
