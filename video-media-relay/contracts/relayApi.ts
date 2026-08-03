// Relay is a separately-built runtime, while the repository's Bun dependency
// closure currently lives under ts/. Keep the contract source shared without
// making the Relay resolve through a project-local filesystem at runtime.
import { z } from '../../ts/node_modules/zod/v4'
import { createHash } from 'node:crypto'

/**
 * The only wire contract shared by the Video Sidecar and Video Media Relay.
 * It deliberately contains no project, filesystem, provider key, model tuning
 * or client supplied owner field.
 */
export const VIDEO_MEDIA_RELAY_SCHEMA_VERSION = 1 as const
export const videoMediaRelaySchemaHeader = 'X-BB-Video-Media-Schema'
export const videoMediaRelaySchemaValue = 'bb-video-media/1'

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const opaqueId = z.string().regex(/^[a-z][a-z0-9_]{7,127}$/)
const iso = z.string().datetime({ offset: true })
const sourceTime = z.object({ ticks: z.string().regex(/^-?(?:0|[1-9]\d*)$/), tick_rate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }) })

export const createMediaObjectLeaseRequestSchema = z.object({
  local_operation_id: opaqueId,
  purpose: z.enum(['visual_frames', 'proxy_video', 'audio_for_asr', 'transcript_for_reasoning']),
  content_hash: hash,
  byte_size: z.number().int().positive().max(5 * 1024 * 1024 * 1024),
  content_type: z.string().min(3).max(160),
  consent_revision_id: opaqueId,
  consent_scope_hash: hash,
}).strict()
export type CreateMediaObjectLeaseRequest = z.infer<typeof createMediaObjectLeaseRequestSchema>

export const mediaObjectLeaseSchema = z.object({
  lease_id: opaqueId,
  state: z.enum(['awaiting_upload', 'ready', 'bound', 'expired', 'deleted']),
  put_url: z.string().url().optional(),
  required_headers: z.record(z.string(), z.string()).optional(),
  object_ref: opaqueId.optional(),
  expires_at: iso,
}).strict()
export type MediaObjectLease = z.infer<typeof mediaObjectLeaseSchema>

const operationBase = z.object({
  local_operation_id: opaqueId,
  consent_revision_id: opaqueId,
  consent_scope_hash: hash,
  local_budget_reservation_id: opaqueId,
  request_hash: hash,
})
const evidenceItem = z.object({
  id: opaqueId,
  kind: z.enum(['transcript', 'visual_fact', 'user_constraint', 'delivery_intent']),
  text: z.string().min(1).max(32_000),
  source_range_id: opaqueId.optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict()

export const createVideoRelayOperationRequestSchema = z.discriminatedUnion('capability', [
  operationBase.extend({ capability: z.literal('visual_evidence'), application_role: z.literal('shot_evidence'), input: z.object({ object_refs: z.array(opaqueId).min(1).max(64), evidence_window_id: opaqueId, facts_basis_hash: hash, language: z.string().min(1).max(32), output_schema_version: z.number().int().positive() }).strict() }),
  operationBase.extend({ capability: z.literal('media_reasoning'), application_role: z.enum(['planning', 'caption_translation']), input: z.object({ object_refs: z.array(opaqueId).max(64), facts_basis_hash: hash, evidence: z.array(evidenceItem).max(2_000), language: z.string().min(1).max(32), output_schema_version: z.number().int().positive() }).strict() }),
  operationBase.extend({ capability: z.literal('speech_transcription'), application_role: z.literal('asr'), input: z.object({ mode: z.enum(['short_sync', 'long_async']), audio_object_ref: opaqueId, source_offset: sourceTime, language: z.string().min(1).max(32).optional(), hotwords: z.array(z.string().min(1).max(200)).max(200), speaker_diarization: z.boolean(), sentence_timestamps: z.literal(true), word_timestamps: z.literal(true) }).strict() }),
  operationBase.extend({ capability: z.literal('semantic_embedding'), application_role: z.literal('search_index'), input: z.object({ embedding_role: z.enum(['document', 'query']), items: z.array(z.object({ id: opaqueId, text: z.string().min(1).max(32_000) }).strict()).min(1).max(2_000), model: z.literal('text-embedding-v4'), dimension: z.literal(768), instruction_version: z.string().min(1).max(160) }).strict() }),
])
export type CreateVideoRelayOperationRequest = z.infer<typeof createVideoRelayOperationRequestSchema>

export const providerUsageSchema = z.object({ requests: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative(), input_bytes: z.number().int().nonnegative(), visual_frames: z.number().int().nonnegative(), proxy_seconds: z.number().nonnegative(), asr_seconds: z.number().nonnegative(), estimated_amount_micros: z.number().int().nonnegative() }).strict()
export const providerExecutionReceiptSchema = z.object({ id: opaqueId, capability: z.enum(['visual_evidence', 'media_reasoning', 'speech_transcription', 'semantic_embedding']), model_snapshot: z.string().min(1).max(200), region: z.literal('cn-beijing'), request_schema_version: z.number().int().positive(), prompt_version: z.string().min(1).max(160), input_basis_hash: hash, usage: providerUsageSchema, cache_hit: z.boolean(), upstream_receipt_hash: hash.optional(), created_at: iso }).strict()
export type ProviderExecutionReceipt = z.infer<typeof providerExecutionReceiptSchema>

export const videoRelayOperationProjectionSchema = z.object({ id: opaqueId, state: z.enum(['accepted', 'submitted', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'expired']), provider_task_id: z.string().min(1).max(500).optional(), result_object_refs: z.array(opaqueId).max(64).optional(), provider_receipt: providerExecutionReceiptSchema.optional(), account_quota_reservation_id: opaqueId, safe_error_code: z.string().min(1).max(160).optional(), retry_after_ms: z.number().int().positive().max(24 * 60 * 60_000).optional(), created_at: iso, updated_at: iso }).strict()
export type VideoRelayOperationProjection = z.infer<typeof videoRelayOperationProjectionSchema>

export const operationAcknowledgementSchema = z.object({ result_hashes: z.array(hash).max(64), receipt_id: opaqueId }).strict()
export function canonicalRelayRequestHash(value: unknown): `sha256:${string}` {
  const stable = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(stable).join(',')}]`
    if (item && typeof item === 'object') return `{${Object.keys(item as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stable((item as Record<string, unknown>)[key])}`).join(',')}}`
    return JSON.stringify(item)
  }
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`
}
