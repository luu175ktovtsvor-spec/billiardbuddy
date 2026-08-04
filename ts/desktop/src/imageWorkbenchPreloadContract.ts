import type {
  ImageProjectResponse,
  ImageTaskResponse,
} from '../../shared/contracts/media.js'
import type {
  ImageCandidateAdoptionResponse,
  ImageCandidateDecisionResponse,
  ImageCandidateDerivationResponse,
  ImageCreativePlanResponse,
  ImageDerivationEstimateResponse,
  ImageGenerationCancelResponse,
  ImageGenerationRoundEstimateResponse,
  ImageGenerationRoundResponse,
  ImageReferenceControlResponse,
  ImageSaveOutputResponse,
} from '../../shared/contracts/imageGeneration.js'
import type { ImageWorkbenchIpcResponse, ImageWorkbenchPreloadBridge } from '../../shared/contracts/imageWorkbenchPreload.js'
import type { ImageWorkbenchIpcMethodResponse } from '../../shared/contracts/imageWorkbenchPreload.js'

type Equal<Left, Right> = (
  <Value>() => Value extends Left ? 1 : 2
) extends (
  <Value>() => Value extends Right ? 1 : 2
) ? true : false
type Assert<Value extends true> = Value
type ImagePreload = Window['billiardBuddyNative']['media']['images']

/** Compile-time renderer contract: no exposed image command may regress to Promise<unknown>. */
export type ImageWorkbenchPreloadTypeContract = [
  Assert<Equal<ImagePreload, ImageWorkbenchPreloadBridge>>,
  Assert<Equal<ReturnType<ImagePreload['submitProject']>, Promise<ImageWorkbenchIpcResponse<ImageTaskResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['startOperation']>, Promise<ImageWorkbenchIpcResponse<ImageTaskResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['updateUnknownProject']>, Promise<ImageWorkbenchIpcResponse<ImageProjectResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['saveOutput']>, Promise<ImageWorkbenchIpcResponse<ImageSaveOutputResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['createCreativePlan']>, Promise<ImageWorkbenchIpcResponse<ImageCreativePlanResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateGenerationRound']>, Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundEstimateResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateDerivation']>, Promise<ImageWorkbenchIpcResponse<ImageDerivationEstimateResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['createGenerationRound']>, Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['decideCandidate']>, Promise<ImageWorkbenchIpcResponse<ImageCandidateDecisionResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['adoptCandidate']>, Promise<ImageWorkbenchIpcResponse<ImageCandidateAdoptionResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['deriveCandidate']>, Promise<ImageWorkbenchIpcResponse<ImageCandidateDerivationResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['cancelGenerationOperation']>, Promise<ImageWorkbenchIpcResponse<ImageGenerationCancelResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['updateReferenceControl']>, Promise<ImageWorkbenchIpcResponse<ImageReferenceControlResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['listProjects']>, Promise<ImageWorkbenchIpcMethodResponse<'listProjects'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getProject']>, Promise<ImageWorkbenchIpcMethodResponse<'getProject'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getProjectProjection']>, Promise<ImageWorkbenchIpcMethodResponse<'getProjectProjection'>>>>,
  Assert<Equal<ReturnType<ImagePreload['listOperationEvents']>, Promise<ImageWorkbenchIpcMethodResponse<'listOperationEvents'>>>>,
  Assert<Equal<ReturnType<ImagePreload['quickCreate']>, Promise<ImageWorkbenchIpcMethodResponse<'quickCreate'>>>>,
  Assert<Equal<ReturnType<ImagePreload['compileBrief']>, Promise<ImageWorkbenchIpcMethodResponse<'compileBrief'>>>>,
  Assert<Equal<ReturnType<ImagePreload['applyBriefOverrides']>, Promise<ImageWorkbenchIpcMethodResponse<'applyBriefOverrides'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getInspirationBoard']>, Promise<ImageWorkbenchIpcMethodResponse<'getInspirationBoard'>>>>,
  Assert<Equal<ReturnType<ImagePreload['upsertInspirationItems']>, Promise<ImageWorkbenchIpcMethodResponse<'upsertInspirationItems'>>>>,
  Assert<Equal<ReturnType<ImagePreload['promoteInspirationItem']>, Promise<ImageWorkbenchIpcMethodResponse<'promoteInspirationItem'>>>>,
  Assert<Equal<ReturnType<ImagePreload['addReferences']>, Promise<ImageWorkbenchIpcMethodResponse<'addReferences'>>>>,
  Assert<Equal<ReturnType<ImagePreload['removeReference']>, Promise<ImageWorkbenchIpcMethodResponse<'removeReference'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getCandidateGroup']>, Promise<ImageWorkbenchIpcMethodResponse<'getCandidateGroup'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getCandidatePreview']>, Promise<ImageWorkbenchIpcMethodResponse<'getCandidatePreview'>>>>,
  Assert<Equal<ReturnType<ImagePreload['listCanvases']>, Promise<ImageWorkbenchIpcMethodResponse<'listCanvases'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getCanvas']>, Promise<ImageWorkbenchIpcMethodResponse<'getCanvas'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getDeliverySet']>, Promise<ImageWorkbenchIpcMethodResponse<'getDeliverySet'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getProjectLibrary']>, Promise<ImageWorkbenchIpcMethodResponse<'getProjectLibrary'>>>>,
  Assert<Equal<ReturnType<ImagePreload['listBrandKits']>, Promise<ImageWorkbenchIpcMethodResponse<'listBrandKits'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getBrandKit']>, Promise<ImageWorkbenchIpcMethodResponse<'getBrandKit'>>>>,
  Assert<Equal<ReturnType<ImagePreload['createBrandKit']>, Promise<ImageWorkbenchIpcMethodResponse<'createBrandKit'>>>>,
  Assert<Equal<ReturnType<ImagePreload['reviseBrandKit']>, Promise<ImageWorkbenchIpcMethodResponse<'reviseBrandKit'>>>>,
  Assert<Equal<ReturnType<ImagePreload['deleteBrandKit']>, Promise<ImageWorkbenchIpcMethodResponse<'deleteBrandKit'>>>>,
  Assert<Equal<ReturnType<ImagePreload['listTemplates']>, Promise<ImageWorkbenchIpcMethodResponse<'listTemplates'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getTemplate']>, Promise<ImageWorkbenchIpcMethodResponse<'getTemplate'>>>>,
  Assert<Equal<ReturnType<ImagePreload['createTemplate']>, Promise<ImageWorkbenchIpcMethodResponse<'createTemplate'>>>>,
  Assert<Equal<ReturnType<ImagePreload['reviseTemplate']>, Promise<ImageWorkbenchIpcMethodResponse<'reviseTemplate'>>>>,
  Assert<Equal<ReturnType<ImagePreload['deleteTemplate']>, Promise<ImageWorkbenchIpcMethodResponse<'deleteTemplate'>>>>,
  Assert<Equal<ReturnType<ImagePreload['createAssetGrant']>, Promise<ImageWorkbenchIpcMethodResponse<'createAssetGrant'>>>>,
  Assert<Equal<ReturnType<ImagePreload['revokeAssetGrant']>, Promise<ImageWorkbenchIpcMethodResponse<'revokeAssetGrant'>>>>,
  Assert<Equal<ReturnType<ImagePreload['listAssetGrants']>, Promise<ImageWorkbenchIpcMethodResponse<'listAssetGrants'>>>>,
  Assert<Equal<ReturnType<ImagePreload['listCampaigns']>, Promise<ImageWorkbenchIpcMethodResponse<'listCampaigns'>>>>,
  Assert<Equal<ReturnType<ImagePreload['getCampaign']>, Promise<ImageWorkbenchIpcMethodResponse<'getCampaign'>>>>,
  Assert<Equal<ReturnType<ImagePreload['createCampaign']>, Promise<ImageWorkbenchIpcMethodResponse<'createCampaign'>>>>,
  Assert<Equal<ReturnType<ImagePreload['replaceCampaignItems']>, Promise<ImageWorkbenchIpcMethodResponse<'replaceCampaignItems'>>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateCampaign']>, Promise<ImageWorkbenchIpcMethodResponse<'estimateCampaign'>>>>,
  Assert<Equal<ReturnType<ImagePreload['confirmCampaign']>, Promise<ImageWorkbenchIpcMethodResponse<'confirmCampaign'>>>>,
  Assert<Equal<ReturnType<ImagePreload['confirmCampaignRetry']>, Promise<ImageWorkbenchIpcMethodResponse<'confirmCampaignRetry'>>>>,
  Assert<Equal<ReturnType<ImagePreload['startCampaign']>, Promise<ImageWorkbenchIpcMethodResponse<'startCampaign'>>>>,
  Assert<Equal<ReturnType<ImagePreload['cancelCampaign']>, Promise<ImageWorkbenchIpcMethodResponse<'cancelCampaign'>>>>,
  Assert<Equal<ReturnType<ImagePreload['retryCampaignItem']>, Promise<ImageWorkbenchIpcMethodResponse<'retryCampaignItem'>>>>,
]
