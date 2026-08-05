import { ImageApplication } from './imageApplication.js'
import type { ImageGenerationApplicationPort } from '../runtime/imageApplicationPorts.js'

/** Paid generation, candidate decisions, derivation and non-blocking Qwen advice. */
export class ImageGenerationApplication extends ImageApplication<ImageGenerationApplicationPort> {
  readonly understandProject = this.bind('understandProject')
  readonly assessCandidateVisual = this.bind('assessCandidateVisual')
  readonly assessVersionVisual = this.bind('assessVersionVisual')
  readonly updateReferenceControl = this.bind('updateReferenceControl')
  readonly createCreativePlan = this.bind('createCreativePlan')
  readonly getCreativePlan = this.bind('getCreativePlan')
  readonly estimateGenerationRound = this.bind('estimateGenerationRound')
  readonly createGenerationRound = this.bind('createGenerationRound')
  readonly estimateDerivation = this.bind('estimateDerivation')
  readonly deriveCandidate = this.bind('deriveCandidate')
  readonly getGenerationOperation = this.bind('getGenerationOperation')
  readonly findGenerationOperation = this.bind('findGenerationOperation')
  readonly cancelGenerationOperation = this.bind('cancelGenerationOperation')
  readonly listGenerationOperations = this.bind('listGenerationOperations')
  readonly getGenerationRound = this.bind('getGenerationRound')
  readonly getCandidateGroup = this.bind('getCandidateGroup')
  readonly getCandidate = this.bind('getCandidate')
  readonly decideCandidate = this.bind('decideCandidate')
  readonly adoptCandidate = this.bind('adoptCandidate')
  readonly readCandidateAsset = this.bind('readCandidateAsset')
  readonly submitProject = this.bind('submitProject')
  readonly startOperation = this.bind('startOperation')

  constructor(port: ImageGenerationApplicationPort) {
    super(port)
  }
}
