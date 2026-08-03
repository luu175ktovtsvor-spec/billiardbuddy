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
import type { ImageWorkbenchPreloadBridge } from '../../shared/contracts/imageWorkbenchPreload.js'

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
  Assert<Equal<ReturnType<ImagePreload['submitProject']>, Promise<ImageTaskResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['startOperation']>, Promise<ImageTaskResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['updateUnknownProject']>, Promise<ImageProjectResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['saveOutput']>, Promise<SaveImageOutputResult>>>,
  Assert<Equal<ReturnType<ImagePreload['createCreativePlan']>, Promise<ImageCreativePlanResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateGenerationRound']>, Promise<ImageGenerationRoundEstimateResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['estimateDerivation']>, Promise<ImageDerivationEstimateResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['createGenerationRound']>, Promise<ImageGenerationRoundResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['decideCandidate']>, Promise<ImageCandidateDecisionResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['adoptCandidate']>, Promise<ImageCandidateAdoptionResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['deriveCandidate']>, Promise<ImageCandidateDerivationResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['cancelGenerationOperation']>, Promise<ImageGenerationCancelResponse>>>,
  Assert<Equal<ReturnType<ImagePreload['updateReferenceControl']>, Promise<ImageReferenceControlResponse>>>,
]
