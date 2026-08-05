import { randomUUID } from 'node:crypto'
import {
  applyDeliveryVariantCommandsInputSchema,
  createDeliveryVariantInputSchema,
  timelineCommandSetSchema,
  videoStudioProjectSchema,
  type ApplyDeliveryVariantCommandsInput,
  type CreateDeliveryVariantInput,
  type DeliveryVariantCommand,
  type DeliveryVariant,
  type DeliveryVariantVersion,
  type VideoQualityReport,
  type VideoStudioProject,
} from '../../../../shared/contracts/media.js'
import { EditorialApplication, EditorialValidationError } from '../domain/editorial/editorialApplication.js'
import { FinishingDeliveryValidationError, type FinishingDeliveryApplication } from '../domain/finishingDelivery/finishingDeliveryApplication.js'
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
    if (error instanceof FinishingDeliveryValidationError) {
      const status = error.code === 'VIDEO_FINISHING_STALE' ? 409
        : error.code === 'VIDEO_QUALITY_BLOCKED' ? 409
          : error.code === 'VIDEO_FINISHING_UNAVAILABLE' ? 422
            : 400
      throw this.errors.create(error.message, status, error.code)
    }
    throw error
  }

  async getDeliveryVariant(projectId: string, variantId: string): Promise<{ variant: DeliveryVariant; version: DeliveryVariantVersion }> {
    const project = await this.commands.prepareEditorialProject(projectId)
    const variant = project.delivery_variants.find(candidate => candidate.id === variantId)
    const version = variant && project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)
    if (!variant || !version) throw this.errors.create('交付变体不存在', 404, 'VIDEO_DELIVERY_VARIANT_NOT_FOUND')
    return { variant, version }
  }

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
  /** Delivery accepts only immutable CommandSets; it never mutates the
   * Variant head or a Timeline projection in place. */
  async applyDeliveryVariantCommands(
    projectId: string,
    variantId: string,
    raw: ApplyDeliveryVariantCommandsInput,
    idempotencyKey: string,
  ): Promise<{ project: VideoStudioProject; version: DeliveryVariantVersion; reused: boolean }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = applyDeliveryVariantCommandsInputSchema.parse(raw)
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        const commandSet = timelineCommandSetSchema.parse({
          id: `command_${randomUUID().replaceAll('-', '')}`,
          project_id: project.id,
          actor_id: 'local_workbench',
          idempotency_key: idempotencyKey,
          created_at: this.now().toISOString(),
          target: { kind: 'delivery_variant', variant_id: variantId, base_variant_version_id: input.base_variant_version_id },
          commands: input.commands,
        })
        const applied = this.editorialRules.applyCommandSet(project, commandSet, await this.commands.editorialSourceBounds(project))
        const version = applied.version as DeliveryVariantVersion
        const acceptedAudioPlan = version.audio_finishing_plan_id
          ? applied.project.audio_finishing_plans.find(candidate => candidate.id === version.audio_finishing_plan_id)
          : undefined
        await this.commands.assertAudioFiltersSupported([
          ...input.commands,
          ...(acceptedAudioPlan?.proposed_commands ?? []),
        ] as DeliveryVariantCommand[])
        const saved = applied.reused ? project : await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse(applied.project))
        return { project: saved, version, reused: applied.reused }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }

  async compileDeliveryVariant(projectId: string, variantId: string) {
    return await this.projectStore.mutate(projectId, async () => {
      const project = await this.commands.prepareEditorialProject(projectId)
      try {
        const compiled = this.editorialRules.compile(project, variantId, await this.commands.editorialSourceBounds(project))
        const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse(compiled.project))
        return { project: saved, plan: compiled.plan }
      } catch (error) {
        return this.editorialError(error)
      }
    })
  }
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
