import { mediaSafeError } from '../../../shared/contracts/media.js'
import type {
  VideoWorkbenchIpcResponse,
  VideoWorkbenchPreloadBridge,
} from '../../../shared/contracts/videoWorkbenchPreload.js'
import type { VideoWorkbenchBridge, VideoWorkbenchResult } from './contracts.js'

function unavailable<Value>(): VideoWorkbenchResult<Value> {
  return { ok: false, error: mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE') }
}
async function invoke<Value>(action: () => Promise<VideoWorkbenchIpcResponse<Value>>): Promise<VideoWorkbenchResult<Value>> {
  try {
    return await action()
  } catch {
    return unavailable()
  }
}

/**
 * Renderer adapter over the typed Preload capability. It keeps Electron out of
 * the product state machine and makes an unavailable Main bridge a safe,
 * recoverable media failure rather than an unhandled IPC rejection.
 */
export function createVideoWorkbenchElectronBridge(
  preload: VideoWorkbenchPreloadBridge | undefined = window.billiardBuddyNative?.media?.videos,
): VideoWorkbenchBridge {
  if (!preload) {
    const noBridge = async <Value>(): Promise<VideoWorkbenchResult<Value>> => unavailable()
    return {
      listProjects: noBridge,
      createProject: noBridge,
      loadWorkspace: noBridge,
      loadOperationEvents: noBridge,
      loadFacts: noBridge,
      searchFacts: noBridge,
      loadReviewNotes: noBridge,
      createReviewNote: noBridge,
      resolveReviewNote: noBridge,
      createApprovalDecision: noBridge,
      chooseSources: noBridge,
      addSources: noBridge,
      estimateRemoteAnalysis: noBridge,
      grantRemoteAnalysisConsent: noBridge,
      createQuickDraft: noBridge,
      applyEditorialCommandSet: noBridge,
      createDeliveryVariant: noBridge,
      applyDeliveryVariantCommandSet: noBridge,
      createCaptionDraft: noBridge,
      createCaptionRevision: noBridge,
      createCaptionTranslation: noBridge,
      createCompositionPlan: noBridge,
      createAudioFinishingPlan: noBridge,
      analyzeBeat: noBridge,
      createBeatSyncDraft: noBridge,
      analyzeSubjectTrack: noBridge,
      preflightVariant: noBridge,
      previewVariant: noBridge,
      chooseExportDestination: noBridge,
      renderVariant: noBridge,
      confirmPostRenderQuality: noBridge,
      cancelOperation: noBridge,
    }
  }
  return {
    listProjects: async () => await invoke(() => preload.listProjects()),
    createProject: async input => await invoke(() => preload.createProject(input)),
    loadWorkspace: async (projectId, eventCursor) => await invoke(() => preload.loadWorkspace(projectId, eventCursor)),
    loadOperationEvents: async (projectId, cursor) => await invoke(() => preload.loadOperationEvents(projectId, cursor)),
    loadFacts: async (projectId, kind, request) => await invoke(() => preload.loadFacts(projectId, kind, request)),
    searchFacts: async (projectId, query, request) => await invoke(() => preload.searchFacts(projectId, query, request)),
    loadReviewNotes: async (projectId, timelineVersionId) => await invoke(() => preload.loadReviewNotes(projectId, timelineVersionId)),
    createReviewNote: async (projectId, timelineVersionId, command) => await invoke(() => preload.createReviewNote(projectId, timelineVersionId, command)),
    resolveReviewNote: async (projectId, timelineVersionId, reviewNoteId, command) => await invoke(() => preload.resolveReviewNote(projectId, timelineVersionId, reviewNoteId, command)),
    createApprovalDecision: async (projectId, timelineVersionId, command) => await invoke(() => preload.createApprovalDecision(projectId, timelineVersionId, command)),
    chooseSources: async projectId => await invoke(() => preload.chooseSources(projectId)),
    addSources: async (projectId, selectionIds, idempotencyKey) => await invoke(() => preload.addSources(projectId, selectionIds, idempotencyKey)),
    estimateRemoteAnalysis: async (projectId, command) => await invoke(() => preload.estimateRemoteAnalysis(projectId, command)),
    grantRemoteAnalysisConsent: async (projectId, command) => await invoke(() => preload.grantRemoteAnalysisConsent(projectId, command)),
    createQuickDraft: async (projectId, command) => await invoke(() => preload.createQuickDraft(projectId, command)),
    applyEditorialCommandSet: async (projectId, command) => await invoke(() => preload.applyEditorialCommandSet(projectId, command)),
    createDeliveryVariant: async (projectId, command) => await invoke(() => preload.createDeliveryVariant(projectId, command)),
    applyDeliveryVariantCommandSet: async (projectId, variantId, command) => await invoke(() => preload.applyDeliveryVariantCommandSet(projectId, variantId, command)),
    createCaptionDraft: async (projectId, command) => await invoke(() => preload.createCaptionDraft(projectId, command)),
    createCaptionRevision: async (projectId, documentId, command) => await invoke(() => preload.createCaptionRevision(projectId, documentId, command)),
    createCaptionTranslation: async (projectId, documentId, command) => await invoke(() => preload.createCaptionTranslation(projectId, documentId, command)),
    createCompositionPlan: async (projectId, command) => await invoke(() => preload.createCompositionPlan(projectId, command)),
    createAudioFinishingPlan: async (projectId, command) => await invoke(() => preload.createAudioFinishingPlan(projectId, command)),
    analyzeBeat: async (projectId, command) => await invoke(() => preload.analyzeBeat(projectId, command)),
    createBeatSyncDraft: async (projectId, command) => await invoke(() => preload.createBeatSyncDraft(projectId, command)),
    analyzeSubjectTrack: async (projectId, command) => await invoke(() => preload.analyzeSubjectTrack(projectId, command)),
    preflightVariant: async (projectId, variantId, command) => await invoke(() => preload.preflightVariant(projectId, variantId, command)),
    previewVariant: async (projectId, variantId, command) => await invoke(() => preload.previewVariant(projectId, variantId, command)),
    chooseExportDestination: async (projectId, variantId) => await invoke(() => preload.chooseExportDestination(projectId, variantId)),
    renderVariant: async (projectId, variantId, destination, command) => await invoke(() => preload.renderVariant(projectId, variantId, destination.destination_grant_id, command)),
    confirmPostRenderQuality: async (projectId, operationId, command) => await invoke(() => preload.confirmPostRenderQuality(projectId, operationId, command)),
    cancelOperation: async operationId => await invoke(() => preload.cancelOperation(operationId)),
  }
}
