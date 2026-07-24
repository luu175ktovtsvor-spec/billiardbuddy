import { z } from 'zod'

export const voiceIdSchema = z.string().regex(/^(?:voice|transcript|revision|binding)_[a-f0-9]{32}$/)
export const voiceIsoDateSchema = z.string().datetime()

export const voiceConsumerSchema = z.object({
  kind: z.enum(['composer', 'video_evidence']),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{7,79}$/),
})

export const transcriptRevisionSchema = z.object({
  id: voiceIdSchema,
  transcript_id: voiceIdSchema,
  parent_revision_id: voiceIdSchema.optional(),
  kind: z.enum(['raw', 'edit']),
  text: z.string().min(1).max(20_000),
  created_at: voiceIsoDateSchema,
})

export const transcriptBindingSchema = z.object({
  id: voiceIdSchema,
  revision_id: voiceIdSchema,
  consumer: voiceConsumerSchema,
  created_at: voiceIsoDateSchema,
})

export const transcriptSchema = z.object({
  schema_version: z.literal(1),
  id: voiceIdSchema,
  operation_id: voiceIdSchema,
  raw_revision_id: voiceIdSchema,
  current_revision_id: voiceIdSchema,
  revisions: z.array(transcriptRevisionSchema).min(1).max(1000),
  bindings: z.array(transcriptBindingSchema).max(1000),
  created_at: voiceIsoDateSchema,
  updated_at: voiceIsoDateSchema,
})

export const voiceOperationSchema = z.object({
  schema_version: z.literal(1),
  id: voiceIdSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  source: z.object({
    name: z.string().min(1).max(500),
    mime_type: z.string().min(1).max(160),
    byte_size: z.number().int().positive(),
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  transcript_id: voiceIdSchema.optional(),
  raw_revision_id: voiceIdSchema.optional(),
  error_code: z.enum(['TRANSCRIPTION_FAILED', 'INTERRUPTED']).optional(),
  consent_receipt_id: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: voiceIsoDateSchema,
  updated_at: voiceIsoDateSchema,
  finished_at: voiceIsoDateSchema.optional(),
})

export const publicVoiceOperationSchema = voiceOperationSchema.omit({
  consent_receipt_id: true,
})

export const voiceTranscriptionResponseSchema = z.object({
  text: z.string().min(1).max(20_000),
  operation: publicVoiceOperationSchema.optional(),
  transcript: transcriptSchema.optional(),
})

export const productVoiceTranscriptionResponseSchema = voiceTranscriptionResponseSchema.extend({
  operation: publicVoiceOperationSchema,
  transcript: transcriptSchema,
})

export const voiceConsumerEvidenceSchema = z.object({
  transcript: transcriptSchema,
  binding: transcriptBindingSchema,
  revision: transcriptRevisionSchema,
})

export const createTranscriptRevisionInputSchema = z.object({
  parent_revision_id: voiceIdSchema,
  text: z.string().trim().min(1).max(20_000),
})

export const bindTranscriptInputSchema = z.object({
  revision_id: voiceIdSchema,
  consumer: voiceConsumerSchema,
})

export const voiceErrorResponseSchema = z.object({
  detail: z.string().min(1).max(2_000),
})

export type VoiceTranscriptionResponse = z.infer<typeof voiceTranscriptionResponseSchema>
export type ProductVoiceTranscriptionResponse = z.infer<typeof productVoiceTranscriptionResponseSchema>
export type VoiceErrorResponse = z.infer<typeof voiceErrorResponseSchema>
export type VoiceConsumer = z.infer<typeof voiceConsumerSchema>
export type VoiceOperation = z.infer<typeof voiceOperationSchema>
export type PublicVoiceOperation = z.infer<typeof publicVoiceOperationSchema>
export type Transcript = z.infer<typeof transcriptSchema>
export type TranscriptRevision = z.infer<typeof transcriptRevisionSchema>
export type TranscriptBinding = z.infer<typeof transcriptBindingSchema>
export type VoiceConsumerEvidence = z.infer<typeof voiceConsumerEvidenceSchema>
