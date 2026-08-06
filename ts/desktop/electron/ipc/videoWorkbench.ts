import { z } from 'zod/v4'
import {
  analyzeVideoBeatInputSchema,
  analyzeVideoProjectInputSchema,
  analyzeVideoSubjectTrackInputSchema,
  applyDeliveryVariantCommandsInputSchema,
  applyEditorialTimelineCommandsInputSchema,
  confirmVideoPostRenderQualityInputSchema,
  createDeliveryVariantInputSchema,
  createRemoteAnalysisConsentInputSchema,
  createVideoAudioFinishingPlanInputSchema,
  createVideoBeatSyncDraftInputSchema,
  createVideoCaptionDraftInputSchema,
  createVideoCaptionRevisionInputSchema,
  createVideoCaptionTranslationInputSchema,
  createVideoCompositionPlanInputSchema,
  createVideoReviewNoteInputSchema,
  createVideoApprovalDecisionInputSchema,
  createVideoProjectInputSchema,
  estimateRemoteAnalysisInputSchema,
  mediaIdSchema,
  preflightVideoVariantInputSchema,
  previewVideoVariantInputSchema,
  renderVideoVariantInputSchema,
  resolveVideoReviewNoteInputSchema,
} from '../../../shared/contracts/media.js'

const idempotencyKeySchema = z.string().trim().min(16).max(160)
const sourceSelectionIdSchema = z.string().regex(/^vsg_[a-f0-9]{32}$/)
const destinationGrantIdSchema = z.string().regex(/^vdg_[a-f0-9]{32}$/)
const factKindSchema = z.enum([
  'source',
  'derivative',
  'transcript',
  'transcript_revision',
  'camera_shot',
  'content_segment',
  'evidence_window',
  'evidence',
])
const factPageRequestSchema = z.object({
  source_id: mediaIdSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict()
const factSearchRequestSchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()

function command<Input extends z.ZodType>(input: Input) {
  return z.object({
    idempotency_key: idempotencyKeySchema,
    input,
  }).strict()
}

/**
 * One narrow, discriminated video IPC surface.  Paths, arbitrary URLs and
 * capability values are intentionally absent: only Main can resolve source
 * and destination grants before it calls the local Sidecar.
 */
export const videoWorkbenchIpcPayloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list_projects') }).strict(),
  z.object({ action: z.literal('create_project'), input: createVideoProjectInputSchema.omit({ workspace_root: true }).strict() }).strict(),
  z.object({ action: z.literal('load_workspace'), projectId: mediaIdSchema, eventCursor: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('load_operation_events'), projectId: mediaIdSchema, cursor: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('load_facts'), projectId: mediaIdSchema, kind: factKindSchema, request: factPageRequestSchema.optional() }).strict(),
  z.object({ action: z.literal('search_facts'), projectId: mediaIdSchema, query: z.string().trim().min(1).max(1000), request: factSearchRequestSchema.optional() }).strict(),
  z.object({ action: z.literal('load_review_notes'), projectId: mediaIdSchema, timelineVersionId: mediaIdSchema }).strict(),
  z.object({ action: z.literal('create_review_note'), projectId: mediaIdSchema, timelineVersionId: mediaIdSchema, command: command(createVideoReviewNoteInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('resolve_review_note'), projectId: mediaIdSchema, timelineVersionId: mediaIdSchema, reviewNoteId: mediaIdSchema, command: command(resolveVideoReviewNoteInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_approval_decision'), projectId: mediaIdSchema, timelineVersionId: mediaIdSchema, command: command(createVideoApprovalDecisionInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('choose_sources'), projectId: mediaIdSchema }).strict(),
  z.object({ action: z.literal('add_sources'), projectId: mediaIdSchema, selectionIds: z.array(sourceSelectionIdSchema).min(1).max(200), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ action: z.literal('estimate_remote_analysis'), projectId: mediaIdSchema, command: command(estimateRemoteAnalysisInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('grant_remote_analysis_consent'), projectId: mediaIdSchema, command: command(createRemoteAnalysisConsentInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_quick_draft'), projectId: mediaIdSchema, command: command(analyzeVideoProjectInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('apply_editorial_command_set'), projectId: mediaIdSchema, command: command(applyEditorialTimelineCommandsInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_delivery_variant'), projectId: mediaIdSchema, command: command(createDeliveryVariantInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('apply_delivery_variant_command_set'), projectId: mediaIdSchema, variantId: mediaIdSchema, command: command(applyDeliveryVariantCommandsInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_caption_draft'), projectId: mediaIdSchema, command: command(createVideoCaptionDraftInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_caption_revision'), projectId: mediaIdSchema, captionDocumentId: mediaIdSchema, command: command(createVideoCaptionRevisionInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_caption_translation'), projectId: mediaIdSchema, captionDocumentId: mediaIdSchema, command: command(createVideoCaptionTranslationInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_composition_plan'), projectId: mediaIdSchema, command: command(createVideoCompositionPlanInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_audio_finishing_plan'), projectId: mediaIdSchema, command: command(createVideoAudioFinishingPlanInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('analyze_beat'), projectId: mediaIdSchema, command: command(analyzeVideoBeatInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('create_beat_sync_draft'), projectId: mediaIdSchema, command: command(createVideoBeatSyncDraftInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('analyze_subject_track'), projectId: mediaIdSchema, command: command(analyzeVideoSubjectTrackInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('preflight_variant'), projectId: mediaIdSchema, variantId: mediaIdSchema, command: command(preflightVideoVariantInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('preview_variant'), projectId: mediaIdSchema, variantId: mediaIdSchema, command: command(previewVideoVariantInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('choose_export_destination'), projectId: mediaIdSchema, variantId: mediaIdSchema }).strict(),
  z.object({ action: z.literal('render_variant'), projectId: mediaIdSchema, variantId: mediaIdSchema, destinationGrantId: destinationGrantIdSchema, command: command(renderVideoVariantInputSchema.omit({ output_path: true }).strict()) }).strict(),
  z.object({ action: z.literal('confirm_post_render_quality'), projectId: mediaIdSchema, operationId: mediaIdSchema, command: command(confirmVideoPostRenderQualityInputSchema.strict()) }).strict(),
  z.object({ action: z.literal('cancel_operation'), operationId: mediaIdSchema }).strict(),
])

export type VideoWorkbenchIpcPayload = z.infer<typeof videoWorkbenchIpcPayloadSchema>
