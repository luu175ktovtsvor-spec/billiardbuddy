import { randomUUID } from 'node:crypto'
import {
  createDeliveryVariantInputSchema,
  videoStudioProjectSchema,
  type CreateDeliveryVariantInput,
  type DeliveryVariant,
  type DeliveryVariantVersion,
  type VideoQualityReport,
  type VideoStudioProject,
} from '../../../../shared/contracts/media.js'
import { EditorialApplication, EditorialValidationError } from '../domain/editorial/editorialApplication.js'
import type { FinishingDeliveryApplication } from '../domain/finishingDelivery/finishingDeliveryApplication.js'
import { factBasisHash } from '../domain/mediaFacts/model.js'
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
    readonly editorialRules: EditorialApplication,
    readonly rules: FinishingDeliveryApplication,
    private readonly errors: VideoWorkbenchApplicationErrors,
    private readonly now: () => Date,
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

  private editorialError(error: unknown): never {
    if (error instanceof EditorialValidationError) {
      const status = error.code === 'VIDEO_EDITORIAL_STALE'
        || error.code === 'VIDEO_EDITORIAL_LOCKED'
        || error.code === 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT'
        || error.code === 'VIDEO_SOURCE_FINGERPRINT_PENDING'
        ? 409
        : 400
      throw this.errors.create(error.message, status, error.code)
    }
    throw error
  }

  readonly getDeliveryVariant = (...args: Parameters<FinishingDeliveryCommandPort['getDeliveryVariant']>) => this.commands.getDeliveryVariant(...args)

  /** A delivery creation receipt freezes the first Variant Version. Replays
   * must return that immutable version even after the Variant head advances. */
  async createDeliveryVariant(
    projectId: string,
    raw: CreateDeliveryVariantInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; variant: DeliveryVariant; version: DeliveryVariantVersion; reused: boolean }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = createDeliveryVariantInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      const requestHash = factBasisHash(input)
      const existing = project.delivery_variant_creation_receipts.find(receipt => receipt.idempotency_key === idempotencyKey)
      if (existing) {
        if (existing.request_hash !== requestHash) throw this.errors.create('同一幂等键不能创建不同交付变体', 409, 'VIDEO_EDITORIAL_IDEMPOTENCY_CONFLICT')
        const variant = project.delivery_variants.find(candidate => candidate.id === existing.variant_id)
        if (!existing.version_id) throw this.errors.create('交付变体幂等记录缺少首次版本，不能安全重放', 500, 'VIDEO_EDITORIAL_INVALID')
        const version = project.delivery_variant_versions.find(candidate => candidate.id === existing.version_id)
        if (
          !variant
          || !version
          || !existing.command_set_id
          || version.created_by_command_set_id !== existing.command_set_id
          || (existing.editorial_timeline_version_id && version.editorial_timeline_version_id !== existing.editorial_timeline_version_id)
          || (existing.export_profile_revision_id && version.export_profile_revision_id !== existing.export_profile_revision_id)
          || (existing.export_profile_hash && version.export_profile_hash !== existing.export_profile_hash)
        ) throw this.errors.create('交付变体幂等记录损坏', 500, 'VIDEO_EDITORIAL_INVALID')
        return { project, variant, version, reused: true }
      }
      try {
        const createdAt = this.now().toISOString()
        const commandSetId = `command_${randomUUID().replaceAll('-', '')}`
        const created = this.editorialRules.createDeliveryVariant(project, input, commandSetId)
        const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
          ...created.project,
          editorial_command_receipts: [...created.project.editorial_command_receipts, {
            idempotency_key: idempotencyKey,
            command_set_id: commandSetId,
            request_hash: requestHash,
            target_kind: 'delivery_variant' as const,
            created_version_id: created.version.id,
            created_at: createdAt,
          }],
          delivery_variant_creation_receipts: [...created.project.delivery_variant_creation_receipts, {
            idempotency_key: idempotencyKey,
            request_hash: requestHash,
            command_set_id: commandSetId,
            variant_id: created.variant.id,
            version_id: created.version.id,
            editorial_timeline_version_id: created.version.editorial_timeline_version_id,
            export_profile_revision_id: created.version.export_profile_revision_id,
            export_profile_hash: created.version.export_profile_hash,
            created_at: createdAt,
          }],
        }))
        return { project: saved, variant: created.variant, version: created.version, reused: false }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }
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
