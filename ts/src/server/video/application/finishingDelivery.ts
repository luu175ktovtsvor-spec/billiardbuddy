import type { VideoQualityReport, VideoStudioProject } from '../../../../shared/contracts/media.js'
import type { FinishingDeliveryApplication } from '../domain/finishingDelivery/finishingDeliveryApplication.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type {
  ActiveVideoExecutionHandle,
  FinishingDeliveryCommandPort,
  VideoWorkbenchApplicationErrors,
} from '../runtime/videoWorkbenchApplicationPorts.js'

/** In-flight worker handles are intentionally separate from durable render
 * Operations. Restart recovery always reconstructs work from SQLite. */
export class FinishingDeliveryOperationState {
  readonly activePreviews = new Map<string, ActiveVideoExecutionHandle>()
  readonly activeRenders = new Map<string, ActiveVideoExecutionHandle>()
  renderTail: Promise<void> = Promise.resolve()
}

/**
 * Owns immutable delivery versions, frozen execution plans, render lifecycle
 * and post-render publication checks. It never rebuilds a plan from a head
 * Timeline outside the existing CommandSet/version chain.
 */
export class FinishingDelivery {
  constructor(
    private readonly commands: FinishingDeliveryCommandPort,
    readonly projectStore: VideoProjectStore,
    readonly operationState: FinishingDeliveryOperationState,
    readonly rules: FinishingDeliveryApplication,
    private readonly errors: VideoWorkbenchApplicationErrors,
  ) {}

  private async requireVideoProject(projectId: string): Promise<VideoStudioProject> {
    let project: VideoStudioProject
    try {
      project = await this.projectStore.repository.getProject(projectId)
    } catch (error) {
      return this.errors.rethrowRepository(error)
    }
    if (project.kind !== 'video') throw this.errors.create('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return project
  }

  readonly getDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['getDeliveryVariant']>) => this.commands.getDeliveryVariant(...args)
  readonly createDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['createDeliveryVariant']>) => this.commands.createDeliveryVariant(...args)
  readonly applyDeliveryVariantCommands = (...args: Parameters<FinishingDeliveryCommandPort['applyDeliveryVariantCommands']>) => this.commands.applyDeliveryVariantCommands(...args)
  readonly compileDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['compileDeliveryVariant']>) => this.commands.compileDeliveryVariant(...args)
  readonly createCaptionDraft = (...args: Parameters<FinishingDeliveryCommandPort['createCaptionDraft']>) => this.commands.createCaptionDraft(...args)
  readonly createCaptionRevision = (...args: Parameters<FinishingDeliveryCommandPort['createCaptionRevision']>) => this.commands.createCaptionRevision(...args)
  readonly createCaptionTranslation = (...args: Parameters<FinishingDeliveryCommandPort['createCaptionTranslation']>) => this.commands.createCaptionTranslation(...args)
  readonly createCompositionPlan = (...args: Parameters<FinishingDeliveryCommandPort['createCompositionPlan']>) => this.commands.createCompositionPlan(...args)
  readonly createAudioFinishingPlan = (...args: Parameters<FinishingDeliveryCommandPort['createAudioFinishingPlan']>) => this.commands.createAudioFinishingPlan(...args)
  readonly preflightDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['preflightDeliveryVariant']>) => this.commands.preflightDeliveryVariant(...args)

  async getQualityReport(projectId: string, reportId: string): Promise<VideoQualityReport> {
    const project = await this.requireVideoProject(projectId)
    const report = project.quality_reports.find(candidate => candidate.id === reportId)
    if (!report) throw this.errors.create('质量报告不存在', 404, 'VIDEO_QUALITY_REPORT_NOT_FOUND')
    return report
  }

  readonly previewVideo = (...args: Parameters<FinishingDeliveryCommandPort['previewVideo']>) => this.commands.previewVideo(...args)
  readonly previewDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['previewDeliveryVariant']>) => this.commands.previewDeliveryVariant(...args)
  readonly previewResponse = (...args: Parameters<FinishingDeliveryCommandPort['previewResponse']>) => this.commands.previewResponse(...args)
  readonly previewSidecarResponse = (...args: Parameters<FinishingDeliveryCommandPort['previewSidecarResponse']>) => this.commands.previewSidecarResponse(...args)
  readonly renderVideo = (...args: Parameters<FinishingDeliveryCommandPort['renderVideo']>) => this.commands.renderVideo(...args)
  readonly renderDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['renderDeliveryVariant']>) => this.commands.renderDeliveryVariant(...args)
  readonly confirmPostRenderQuality = (...args: Parameters<FinishingDeliveryCommandPort['confirmPostRenderQuality']>) => this.commands.confirmPostRenderQuality(...args)
}
