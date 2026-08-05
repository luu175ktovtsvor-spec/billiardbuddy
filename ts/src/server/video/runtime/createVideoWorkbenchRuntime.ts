import {
  VideoWorkbenchRuntime,
  VideoWorkbenchServiceError,
  type VideoWorkbenchRuntimeOptions,
} from '../../services/videoWorkbenchRuntime.js'
import { VideoWorkbenchRepositoryError } from '../../services/videoWorkbenchRepository.js'
import { AnalysisIndex, VideoAnalysisOperationState } from '../application/analysisIndex.js'
import { Editorial } from '../application/editorial.js'
import { FinishingDelivery, FinishingDeliveryOperationState } from '../application/finishingDelivery.js'
import { ProjectAssets } from '../application/projectAssets.js'
import { EditorialApplication } from '../domain/editorial/editorialApplication.js'
import { FinishingDeliveryApplication } from '../domain/finishingDelivery/finishingDeliveryApplication.js'
import type { VideoWorkbenchApplicationErrors } from './videoWorkbenchApplicationPorts.js'
import { VideoProjectStore } from './videoProjectStore.js'

/**
 * The only composition point for the video domain. Every application receives
 * a narrow runtime port plus the same VideoProjectStore/SQLite writer; none
 * can create a second Project, Timeline, Variant or recovery state.
 */
export class VideoWorkbenchCompositionRoot {
  readonly runtime: VideoWorkbenchRuntime
  readonly projectAssets: ProjectAssets
  readonly analysisIndex: AnalysisIndex
  readonly editorial: Editorial
  readonly finishingDelivery: FinishingDelivery

  constructor(options: VideoWorkbenchRuntimeOptions = {}) {
    const now = options.now ?? (() => new Date())
    const projectStore = new VideoProjectStore({ root: options.root, now })
    const analysisState = new VideoAnalysisOperationState()
    const finishingState = new FinishingDeliveryOperationState()
    const editorialRules = new EditorialApplication(now)
    const finishingRules = new FinishingDeliveryApplication(now)
    const errors: VideoWorkbenchApplicationErrors = {
      create: (message, status, code) => new VideoWorkbenchServiceError(message, status, code),
      rethrowRepository: (error): never => {
        if (error instanceof VideoWorkbenchRepositoryError) {
          throw new VideoWorkbenchServiceError(error.message, error.status, error.code)
        }
        throw error
      },
    }
    this.runtime = new VideoWorkbenchRuntime({
      ...options,
      now,
      projectStore,
      analysisState,
      finishingState,
      editorialRules,
      finishingRules,
    })
    this.projectAssets = new ProjectAssets(this.runtime, projectStore, errors)
    this.analysisIndex = new AnalysisIndex(this.runtime, projectStore, analysisState, errors)
    this.editorial = new Editorial(this.runtime, editorialRules)
    this.finishingDelivery = new FinishingDelivery(this.runtime, projectStore, finishingState, finishingRules, errors)
  }

  get repository() {
    return this.runtime.repository
  }

  readonly getOperation = (...args: Parameters<VideoWorkbenchRuntime['getOperation']>) => this.runtime.getOperation(...args)
  readonly toolchainStatus = (...args: Parameters<VideoWorkbenchRuntime['toolchainStatus']>) => this.runtime.toolchainStatus(...args)
  readonly cancelOperation = (...args: Parameters<VideoWorkbenchRuntime['cancelOperation']>) => this.runtime.cancelOperation(...args)
  readonly recoverInterruptedOperations = (...args: Parameters<VideoWorkbenchRuntime['recoverInterruptedOperations']>) => this.runtime.recoverInterruptedOperations(...args)
}

export function createVideoWorkbenchCompositionRoot(
  options: VideoWorkbenchRuntimeOptions = {},
): VideoWorkbenchCompositionRoot {
  return new VideoWorkbenchCompositionRoot(options)
}
