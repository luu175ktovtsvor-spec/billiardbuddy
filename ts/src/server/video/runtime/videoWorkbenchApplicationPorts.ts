import type { VideoWorkbenchRuntime } from '../../services/videoWorkbenchRuntime.js'

/**
 * Application modules depend on these intentionally narrow ports instead of
 * importing the concrete runtime.  The composition root is the only place
 * that knows the runtime implementation and wires its capabilities together.
 */
export interface ProjectAssetsCommandPort extends Pick<VideoWorkbenchRuntime,
  | 'createProject'
  | 'addVideoSource'
  | 'sourceResponse'
  | 'restoreProject'
  | 'migrateLegacyMediaStore'
> {}

export interface AnalysisIndexCommandPort extends Pick<VideoWorkbenchRuntime,
  | 'estimateRemoteAnalysis'
  | 'grantRemoteAnalysisConsent'
  | 'revokeRemoteAnalysisConsent'
  | 'searchMediaFacts'
  | 'analyzeVideoProject'
  | 'analyzeVideoBeat'
  | 'createBeatSyncTimelineDraft'
  | 'analyzeVideoSubjectTrack'
> {}

export interface EditorialCommandPort extends Pick<VideoWorkbenchRuntime,
  | 'getEditorialTimeline'
  | 'getTimelineDraft'
  | 'applyEditorialTimelineCommands'
  | 'acceptTimelineDraft'
  | 'updateTimeline'
  | 'selectTimelineVersion'
  | 'lockScene'
  | 'applyAlternative'
> {}

export interface FinishingDeliveryCommandPort extends Pick<VideoWorkbenchRuntime,
  | 'getDeliveryVariant'
  | 'createDeliveryVariant'
  | 'applyDeliveryVariantCommands'
  | 'compileDeliveryVariant'
  | 'createCaptionDraft'
  | 'createCaptionRevision'
  | 'createCaptionTranslation'
  | 'createCompositionPlan'
  | 'createAudioFinishingPlan'
  | 'preflightDeliveryVariant'
  | 'previewVideo'
  | 'previewDeliveryVariant'
  | 'previewResponse'
  | 'previewSidecarResponse'
  | 'renderVideo'
  | 'renderDeliveryVariant'
  | 'confirmPostRenderQuality'
> {}

/** Process-local handles only; durable Operation rows stay in SQLite. */
export type ActiveVideoExecutionHandle = {
  controller: AbortController
  completion: Promise<void>
  output_path: string
  started?: boolean
  cancelledBeforeStart?: boolean
}

/** The application layer does not know the concrete service error class.
 * This small factory preserves the public API's existing error envelope. */
export interface VideoWorkbenchApplicationErrors {
  readonly create: (message: string, status: number, code: string) => Error
  readonly rethrowRepository: (error: unknown) => never
}
