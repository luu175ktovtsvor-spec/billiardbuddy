import {
  createVideoWorkbenchCompositionRoot,
  type VideoWorkbenchCompositionRoot,
} from '../video/runtime/createVideoWorkbenchRuntime.js'
import type { VideoWorkbenchRuntimeOptions } from './videoWorkbenchRuntime.js'

export { VideoWorkbenchServiceError } from './videoWorkbenchRuntime.js'
export type { LocalPcmDecoder, VideoWorkbenchRuntimeOptions } from './videoWorkbenchRuntime.js'

/**
 * API compatibility facade for the video workbench. The composition root owns
 * the runtime and injects its one Project store into ProjectAssets,
 * AnalysisIndex, Editorial and FinishingDelivery. Keep this class free of
 * repository writes, process handles, provider clients and recovery state.
 */
export class VideoWorkbenchService {
  readonly repository: VideoWorkbenchCompositionRoot['repository']
  private readonly root: VideoWorkbenchCompositionRoot

  constructor(options: VideoWorkbenchRuntimeOptions = {}) {
    this.root = createVideoWorkbenchCompositionRoot(options)
    this.repository = this.root.repository
  }

  async listProjects(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['listProjects']>) {
    return await this.root.projectAssets.listProjects(...args)
  }

  async getProject(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['getProject']>) {
    return await this.root.projectAssets.getProject(...args)
  }

  async assertProjectOwner(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['assertProjectOwner']>) {
    return await this.root.projectAssets.assertProjectOwner(...args)
  }

  async createProject(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['createProject']>) {
    return await this.root.projectAssets.createProject(...args)
  }

  async addVideoSource(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['addVideoSource']>) {
    return await this.root.projectAssets.addVideoSource(...args)
  }

  async sourceResponse(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['sourceResponse']>) {
    return await this.root.projectAssets.sourceResponse(...args)
  }

  async listDeletions(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['listDeletions']>) {
    return await this.root.projectAssets.listDeletions(...args)
  }

  async hasProjectHistory(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['hasProjectHistory']>) {
    return await this.root.projectAssets.hasProjectHistory(...args)
  }

  async hasOperationHistory(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['hasOperationHistory']>) {
    return await this.root.projectAssets.hasOperationHistory(...args)
  }

  async deleteProject(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['deleteProject']>) {
    return await this.root.projectAssets.deleteProject(...args)
  }

  async restoreProject(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['restoreProject']>) {
    return await this.root.projectAssets.restoreProject(...args)
  }

  async migrateLegacyMediaStore(...args: Parameters<VideoWorkbenchCompositionRoot['projectAssets']['migrateLegacyMediaStore']>) {
    return await this.root.projectAssets.migrateLegacyMediaStore(...args)
  }

  async getWorkspaceSnapshotData(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['getWorkspaceSnapshotData']>) {
    return await this.root.analysisIndex.getWorkspaceSnapshotData(...args)
  }

  async estimateRemoteAnalysis(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['estimateRemoteAnalysis']>) {
    return await this.root.analysisIndex.estimateRemoteAnalysis(...args)
  }

  async grantRemoteAnalysisConsent(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['grantRemoteAnalysisConsent']>) {
    return await this.root.analysisIndex.grantRemoteAnalysisConsent(...args)
  }

  async revokeRemoteAnalysisConsent(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['revokeRemoteAnalysisConsent']>) {
    return await this.root.analysisIndex.revokeRemoteAnalysisConsent(...args)
  }

  async pageMediaFacts(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['pageMediaFacts']>) {
    return await this.root.analysisIndex.pageMediaFacts(...args)
  }

  async searchMediaFacts(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['searchMediaFacts']>) {
    return await this.root.analysisIndex.searchMediaFacts(...args)
  }

  async reclaimDerivativeCache(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['reclaimDerivativeCache']>) {
    return await this.root.analysisIndex.reclaimDerivativeCache(...args)
  }

  async waitForOperationEvents(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['waitForOperationEvents']>) {
    return await this.root.analysisIndex.waitForOperationEvents(...args)
  }

  async analyzeVideoProject(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['analyzeVideoProject']>) {
    return await this.root.analysisIndex.analyzeVideoProject(...args)
  }

  async analyzeVideoBeat(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['analyzeVideoBeat']>) {
    return await this.root.analysisIndex.analyzeVideoBeat(...args)
  }

  async createBeatSyncTimelineDraft(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['createBeatSyncTimelineDraft']>) {
    return await this.root.analysisIndex.createBeatSyncTimelineDraft(...args)
  }

  async analyzeVideoSubjectTrack(...args: Parameters<VideoWorkbenchCompositionRoot['analysisIndex']['analyzeVideoSubjectTrack']>) {
    return await this.root.analysisIndex.analyzeVideoSubjectTrack(...args)
  }

  async getEditorialTimeline(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['getEditorialTimeline']>) {
    return await this.root.editorial.getEditorialTimeline(...args)
  }

  async getTimelineDraft(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['getTimelineDraft']>) {
    return await this.root.editorial.getTimelineDraft(...args)
  }

  async applyEditorialTimelineCommands(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['applyEditorialTimelineCommands']>) {
    return await this.root.editorial.applyEditorialTimelineCommands(...args)
  }

  async acceptTimelineDraft(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['acceptTimelineDraft']>) {
    return await this.root.editorial.acceptTimelineDraft(...args)
  }

  async updateTimeline(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['updateTimeline']>) {
    return await this.root.editorial.updateTimeline(...args)
  }

  async selectTimelineVersion(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['selectTimelineVersion']>) {
    return await this.root.editorial.selectTimelineVersion(...args)
  }

  async lockScene(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['lockScene']>) {
    return await this.root.editorial.lockScene(...args)
  }

  async applyAlternative(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['applyAlternative']>) {
    return await this.root.editorial.applyAlternative(...args)
  }

  async updateDeliveryIntent(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['updateDeliveryIntent']>) {
    return await this.root.editorial.updateDeliveryIntent(...args)
  }

  async getDurationFeasibility(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['getDurationFeasibility']>) {
    return await this.root.editorial.getDurationFeasibility(...args)
  }

  async createSourceRangeDecision(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['createSourceRangeDecision']>) {
    return await this.root.editorial.createSourceRangeDecision(...args)
  }

  async createEditorialPlans(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['createEditorialPlans']>) {
    return await this.root.editorial.createEditorialPlans(...args)
  }

  async quickCreate(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['quickCreate']>) {
    return await this.root.editorial.quickCreate(...args)
  }

  async createCreativeSession(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['createCreativeSession']>) {
    return await this.root.editorial.createCreativeSession(...args)
  }

  async postCreativeMessage(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['postCreativeMessage']>) {
    return await this.root.editorial.postCreativeMessage(...args)
  }

  async getCreativeProposal(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['getCreativeProposal']>) {
    return await this.root.editorial.getCreativeProposal(...args)
  }

  async acceptCreativeProposal(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['acceptCreativeProposal']>) {
    return await this.root.editorial.acceptCreativeProposal(...args)
  }

  async rejectCreativeProposal(...args: Parameters<VideoWorkbenchCompositionRoot['editorial']['rejectCreativeProposal']>) {
    return await this.root.editorial.rejectCreativeProposal(...args)
  }

  async getDeliveryVariant(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['getDeliveryVariant']>) {
    return await this.root.finishingDelivery.getDeliveryVariant(...args)
  }

  async createDeliveryVariant(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['createDeliveryVariant']>) {
    return await this.root.finishingDelivery.createDeliveryVariant(...args)
  }

  async applyDeliveryVariantCommands(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['applyDeliveryVariantCommands']>) {
    return await this.root.finishingDelivery.applyDeliveryVariantCommands(...args)
  }

  async compileDeliveryVariant(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['compileDeliveryVariant']>) {
    return await this.root.finishingDelivery.compileDeliveryVariant(...args)
  }

  async createCaptionDraft(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['createCaptionDraft']>) {
    return await this.root.finishingDelivery.createCaptionDraft(...args)
  }

  async createCaptionRevision(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['createCaptionRevision']>) {
    return await this.root.finishingDelivery.createCaptionRevision(...args)
  }

  async createCaptionTranslation(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['createCaptionTranslation']>) {
    return await this.root.finishingDelivery.createCaptionTranslation(...args)
  }

  async createCompositionPlan(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['createCompositionPlan']>) {
    return await this.root.finishingDelivery.createCompositionPlan(...args)
  }

  async createAudioFinishingPlan(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['createAudioFinishingPlan']>) {
    return await this.root.finishingDelivery.createAudioFinishingPlan(...args)
  }

  async preflightDeliveryVariant(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['preflightDeliveryVariant']>) {
    return await this.root.finishingDelivery.preflightDeliveryVariant(...args)
  }

  async getQualityReport(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['getQualityReport']>) {
    return await this.root.finishingDelivery.getQualityReport(...args)
  }

  async previewVideo(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['previewVideo']>) {
    return await this.root.finishingDelivery.previewVideo(...args)
  }

  async previewDeliveryVariant(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['previewDeliveryVariant']>) {
    return await this.root.finishingDelivery.previewDeliveryVariant(...args)
  }

  async previewResponse(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['previewResponse']>) {
    return await this.root.finishingDelivery.previewResponse(...args)
  }

  async previewSidecarResponse(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['previewSidecarResponse']>) {
    return await this.root.finishingDelivery.previewSidecarResponse(...args)
  }

  async renderVideo(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['renderVideo']>) {
    return await this.root.finishingDelivery.renderVideo(...args)
  }

  async renderDeliveryVariant(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['renderDeliveryVariant']>) {
    return await this.root.finishingDelivery.renderDeliveryVariant(...args)
  }

  async confirmPostRenderQuality(...args: Parameters<VideoWorkbenchCompositionRoot['finishingDelivery']['confirmPostRenderQuality']>) {
    return await this.root.finishingDelivery.confirmPostRenderQuality(...args)
  }

  async getOperation(...args: Parameters<VideoWorkbenchCompositionRoot['getOperation']>) {
    return await this.root.getOperation(...args)
  }

  async toolchainStatus(...args: Parameters<VideoWorkbenchCompositionRoot['toolchainStatus']>) {
    return await this.root.toolchainStatus(...args)
  }

  async cancelOperation(...args: Parameters<VideoWorkbenchCompositionRoot['cancelOperation']>) {
    return await this.root.cancelOperation(...args)
  }

  async recoverInterruptedOperations(...args: Parameters<VideoWorkbenchCompositionRoot['recoverInterruptedOperations']>) {
    return await this.root.recoverInterruptedOperations(...args)
  }
}

/** Production code and tests can use this explicit factory to make the single
 * composition point visible without changing existing API constructor calls. */
export function createVideoWorkbenchService(options: VideoWorkbenchRuntimeOptions = {}): VideoWorkbenchService {
  return new VideoWorkbenchService(options)
}
