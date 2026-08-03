import type {
  ImageProjectResponse,
  ImageTaskResponse,
  SaveImageOutputResult,
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
} from '../../shared/contracts/imageGeneration.js'
import type { ImageWorkbenchIpcResponse, ImageWorkbenchPreloadBridge } from '../../shared/contracts/imageWorkbenchPreload.js'

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
  Assert<Equal<ReturnType<ImagePreload['saveOutput']>, Promise<ImageWorkbenchIpcResponse<SaveImageOutputResult>>>>,
  Assert<Equal<ReturnType<ImagePreload['createCreativePlan']>, Promise<ImageWorkbenchIpcResponse<ImageCreativePlanResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateGenerationRound']>, Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundEstimateResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateDerivation']>, Promise<ImageWorkbenchIpcResponse<ImageDerivationEstimateResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['createGenerationRound']>, Promise<ImageWorkbenchIpcResponse<ImageGenerationRoundResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['decideCandidate']>, Promise<ImageWorkbenchIpcResponse<ImageCandidateDecisionResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['adoptCandidate']>, Promise<ImageWorkbenchIpcResponse<ImageCandidateAdoptionResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['deriveCandidate']>, Promise<ImageWorkbenchIpcResponse<ImageCandidateDerivationResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['cancelGenerationOperation']>, Promise<ImageWorkbenchIpcResponse<ImageGenerationCancelResponse>>>>,
  Assert<Equal<ReturnType<ImagePreload['updateReferenceControl']>, Promise<ImageWorkbenchIpcResponse<ImageReferenceControlResponse>>>>,
]
