// Relay is a separately-built runtime, while the repository's Bun dependency
// closure currently lives under ts/. Keep the contract source shared without
// making the Relay resolve through a project-local filesystem at runtime.
import { z } from '../../ts/node_modules/zod/v4'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The only wire contract shared by the Video Sidecar and Video Media Relay.
 * It deliberately contains no project, filesystem, provider key, model tuning
 * or client supplied owner field.
 */
export const VIDEO_MEDIA_RELAY_SCHEMA_VERSION = 1 as const
export const videoMediaRelaySchemaHeader = 'X-BB-Video-Media-Schema'
export const videoMediaRelaySchemaValue = 'bb-video-media/1'
/** Read-only crash-recovery lookup for a client that durably recorded its
 * local operation fence but lost the Relay operation id in transit. */
export function videoMediaOperationByLocalOperationPath(localOperationId: string): string {
  return `/v1/video-media/operations/by-local-operation/${encodeURIComponent(localOperationId)}`
}
/**
 * Every Relay result is read and JSON-decoded by the Sidecar. This cap is a
 * wire-level safety boundary, not a storage preference: it still leaves room
 * for long ASR transcripts and a 2,000 x 768 embedding batch, while preventing
 * a compromised/buggy provider response from becoming an unbounded desktop
 * allocation.
 */
export const VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES = 32 * 1024 * 1024
/** Multipart signed URLs are returned in one control response. */
export const VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS = 512

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const opaqueId = z.string().regex(/^[a-z][a-z0-9_]{7,127}$/)
const iso = z.string().datetime({ offset: true })
const sourceTime = z.object({ ticks: z.string().regex(/^-?(?:0|[1-9]\d*)$/), tick_rate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }) })

/**
 * A Relay never has the Project database, so an authenticated desktop bearer
 * alone cannot prove that a local RemoteAnalysisConsent authorized this exact
 * remote call.  The Sidecar therefore signs this short-lived, least-privilege
 * envelope with its separately configured consent-issuer secret.  Relay
 * independently verifies the signature and binds its token fingerprint to the
 * bearer it just introspected through Gateway.
 *
 * The compact form deliberately contains no bearer, path, provider key or
 * object URL.  A fresh claim may be attached to an idempotent replay: it is an
 * authorization envelope, not part of the logical paid request hash.
 */
export const VIDEO_REMOTE_CONSENT_CLAIM_MAX_TTL_MS = 5 * 60_000
export const videoRemoteConsentPurposeSchema = z.enum([
  'visual_evidence',
  'planning',
  'caption_translation',
  'asr',
  'semantic_search',
])
export type VideoRemoteConsentPurpose = z.infer<typeof videoRemoteConsentPurposeSchema>

export const videoRemoteConsentClaimPayloadSchema = z.object({
  v: z.literal(1),
  identity_token_hash: hash,
  project_id: opaqueId,
  /** A deterministic, non-empty source set makes project-wide planning
   * explicit rather than silently unscoped. */
  source_ids: z.array(opaqueId).min(1).max(64)
    .refine(value => new Set(value).size === value.length, { message: 'remote_consent_source_ids_duplicate' })
    .refine(value => value.every((item, index) => index === 0 || value[index - 1]! < item), { message: 'remote_consent_source_ids_not_sorted' }),
  purpose: videoRemoteConsentPurposeSchema,
  consent_revision_id: opaqueId,
  consent_scope_hash: hash,
  region: z.literal('cn-beijing'),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
}).strict()
export type VideoRemoteConsentClaimPayload = z.infer<typeof videoRemoteConsentClaimPayloadSchema>

/** A compact JWS-like value without algorithm negotiation: HMAC-SHA-256 is
 * fixed by this private Sidecar-to-Relay contract. */
export const videoRemoteConsentClaimSchema = z.string()
  .regex(/^[A-Za-z0-9_-]{16,8192}\.[A-Za-z0-9_-]{16,128}$/)

function stableJson(item: unknown): string {
  if (Array.isArray(item)) return `[${item.map(stableJson).join(',')}]`
  if (item && typeof item === 'object') return `{${Object.keys(item as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((item as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(item)
}

export function installationAccessTokenHash(accessToken: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(accessToken).digest('hex')}`
}

export function issueVideoRemoteConsentClaim(
  payload: VideoRemoteConsentClaimPayload,
  signingKey: string,
): string {
  const parsed = videoRemoteConsentClaimPayloadSchema.parse(payload)
  if (signingKey.trim().length < 32) throw new Error('remote consent signing key must be at least 32 characters')
  const encoded = Buffer.from(stableJson(parsed)).toString('base64url')
  const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

/** `null` is intentionally non-diagnostic: callers turn every malformed,
 * forged, future or expired envelope into the same safe Relay error. */
export function verifyVideoRemoteConsentClaim(
  claim: string,
  signingKey: string,
  now: number,
): VideoRemoteConsentClaimPayload | null {
  if (signingKey.trim().length < 32) return null
  if (!videoRemoteConsentClaimSchema.safeParse(claim).success) return null
  const [encoded, signature, extra] = claim.split('.')
  if (!encoded || !signature || extra !== undefined) return null
  const expected = createHmac('sha256', signingKey).update(encoded).digest()
  let presented: Buffer
  try { presented = Buffer.from(signature, 'base64url') } catch { return null }
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) return null
  let payload: unknown
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { return null }
  const parsed = videoRemoteConsentClaimPayloadSchema.safeParse(payload)
  if (!parsed.success) return null
  const value = parsed.data
  if (value.issued_at > now || value.expires_at <= now || value.expires_at - value.issued_at > VIDEO_REMOTE_CONSENT_CLAIM_MAX_TTL_MS) return null
  return value
}

export const createMediaObjectLeaseRequestSchema = z.object({
  local_operation_id: opaqueId,
  purpose: z.enum(['visual_frames', 'proxy_video', 'audio_for_asr', 'transcript_for_reasoning']),
  content_hash: hash,
  byte_size: z.number().int().positive().max(5 * 1024 * 1024 * 1024),
  content_type: z.string().min(3).max(160),
  consent_revision_id: opaqueId,
  consent_scope_hash: hash,
  remote_consent_claim: videoRemoteConsentClaimSchema,
}).strict()
export type CreateMediaObjectLeaseRequest = z.infer<typeof createMediaObjectLeaseRequestSchema>

export const multipartUploadedPartSchema = z.object({
  part_number: z.number().int().positive().max(VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS),
  etag: z.string().min(1).max(256),
}).strict()
export type MultipartUploadedPart = z.infer<typeof multipartUploadedPartSchema>

const multipartLeaseSchema = z.object({
  upload_id: z.string().min(1).max(1_000),
  part_size: z.number().int().positive(),
  parts: z.array(z.object({
    part_number: z.number().int().positive().max(VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS),
    put_url: z.string().url(),
    required_headers: z.record(z.string(), z.string()).optional(),
  }).strict()).min(1).max(VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS),
  uploaded_parts: z.array(multipartUploadedPartSchema).max(VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS),
}).strict()

export const completeMediaObjectLeaseRequestSchema = z.object({
  parts: z.array(multipartUploadedPartSchema).max(VIDEO_MEDIA_RELAY_MAX_MULTIPART_PARTS).optional(),
}).strict()
export type CompleteMediaObjectLeaseRequest = z.infer<typeof completeMediaObjectLeaseRequestSchema>

export const mediaObjectLeaseSchema = z.object({
  lease_id: opaqueId,
  state: z.enum(['awaiting_upload', 'ready', 'bound', 'expired', 'deleted']),
  put_url: z.string().url().optional(),
  required_headers: z.record(z.string(), z.string()).optional(),
  multipart_upload: multipartLeaseSchema.optional(),
  object_ref: opaqueId.optional(),
  expires_at: iso,
}).strict()
export type MediaObjectLease = z.infer<typeof mediaObjectLeaseSchema>

const operationBase = z.object({
  local_operation_id: opaqueId,
  consent_revision_id: opaqueId,
  consent_scope_hash: hash,
  remote_consent_claim: videoRemoteConsentClaimSchema,
  local_budget_reservation_id: opaqueId,
  request_hash: hash,
})
const evidenceItem = z.object({
  id: opaqueId,
  kind: z.enum(['transcript', 'visual_fact', 'user_constraint', 'delivery_intent']),
  text: z.string().min(1).max(32_000),
  /** Planning needs the Host-owned anchor to emit a valid source/time range.
   * These fields are facts only; they are never interpreted as instructions. */
  source_id: opaqueId.optional(),
  in_ms: z.number().int().nonnegative().optional(),
  out_ms: z.number().int().positive().optional(),
  source_range_id: opaqueId.optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict()

const planningSource = z.object({
  id: opaqueId,
  name: z.string().min(1).max(500),
  fingerprint: hash,
  duration_ms: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  rotation: z.number().int(),
  has_audio: z.boolean(),
}).strict()

const planningInput = z.object({
  object_refs: z.array(opaqueId).max(64),
  facts_basis_hash: hash,
  /** Only sources covered by the signed consent scope may be included. */
  sources: z.array(planningSource).max(200).default([]),
  evidence: z.array(evidenceItem).max(2_000),
  /** User intent is context, not citable evidence. The Sidecar still binds it
   * into the request hash so a replay cannot silently change the goal. */
  user_goal: z.string().max(8_000).default(''),
  analysis_gaps: z.array(z.string().min(1).max(500)).max(40).default([]),
  language: z.string().min(1).max(32),
  output_schema_version: z.number().int().positive(),
}).strict()

/** Caption translation is text-only. A caller cannot repurpose this role to
 * attach media objects or planning/user-instruction evidence. */
const captionTranslationEvidenceItem = z.object({
  id: opaqueId,
  kind: z.literal('transcript'),
  text: z.string().min(1).max(32_000),
  source_range_id: opaqueId,
  confidence: z.number().min(0).max(1).optional(),
}).strict()

const captionTranslationInput = z.object({
  object_refs: z.array(opaqueId).length(0),
  facts_basis_hash: hash,
  evidence: z.array(captionTranslationEvidenceItem).min(1).max(2_000),
  language: z.string().min(1).max(32),
  output_schema_version: z.literal(1),
}).strict()

/** Exact bytes written to a caption-translation result object. The Sidecar
 * owns anchors/timing, so Relay may return only cue identity and translated
 * text; planning envelopes, ranges and arbitrary provider fields are refused. */
export const captionTranslationRelayResultSchema = z.object({
  kind: z.literal('caption_translation'),
  translations: z.array(z.object({
    cue_id: opaqueId,
    text: z.string().trim().min(1).max(16_000),
  }).strict()).min(1).max(2_000),
}).strict().refine(value => new Set(value.translations.map(item => item.cue_id)).size === value.translations.length, {
  message: 'caption_translation_duplicate_cue_id',
  path: ['translations'],
})
export type CaptionTranslationRelayResult = z.infer<typeof captionTranslationRelayResultSchema>

/** `media_reasoning` has two independently strict role variants, so this
 * cannot be a capability-only discriminated union. Each alternative still
 * rejects every unsupported capability/role/input combination. */
export const createVideoRelayOperationRequestSchema = z.union([
  operationBase.extend({ capability: z.literal('visual_evidence'), application_role: z.literal('shot_evidence'), input: z.object({ object_refs: z.array(opaqueId).min(1).max(64), evidence_window_id: opaqueId, facts_basis_hash: hash, language: z.string().min(1).max(32), output_schema_version: z.number().int().positive() }).strict() }),
  operationBase.extend({ capability: z.literal('media_reasoning'), application_role: z.literal('planning'), input: planningInput }),
  operationBase.extend({ capability: z.literal('media_reasoning'), application_role: z.literal('caption_translation'), input: captionTranslationInput }),
  operationBase.extend({ capability: z.literal('speech_transcription'), application_role: z.literal('asr'), input: z.object({ mode: z.enum(['short_sync', 'long_async']), audio_object_ref: opaqueId, source_offset: sourceTime, language: z.string().min(1).max(32).optional(), hotwords: z.array(z.string().min(1).max(200)).max(200), speaker_diarization: z.boolean(), sentence_timestamps: z.literal(true), word_timestamps: z.literal(true) }).strict() }),
  operationBase.extend({ capability: z.literal('semantic_embedding'), application_role: z.literal('search_index'), input: z.object({ embedding_role: z.enum(['document', 'query']), items: z.array(z.object({ id: opaqueId, text: z.string().min(1).max(32_000) }).strict()).min(1).max(2_000), model: z.literal('text-embedding-v4'), dimension: z.literal(768), instruction_version: z.string().min(1).max(160) }).strict() }),
])
export type CreateVideoRelayOperationRequest = z.infer<typeof createVideoRelayOperationRequestSchema>

export const providerUsageSchema = z.object({ requests: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative(), input_bytes: z.number().int().nonnegative(), visual_frames: z.number().int().nonnegative(), proxy_seconds: z.number().nonnegative(), asr_seconds: z.number().nonnegative(), estimated_amount_micros: z.number().int().nonnegative() }).strict()
export const providerExecutionReceiptSchema = z.object({ id: opaqueId, capability: z.enum(['visual_evidence', 'media_reasoning', 'speech_transcription', 'semantic_embedding']), model_snapshot: z.string().min(1).max(200), region: z.literal('cn-beijing'), request_schema_version: z.number().int().positive(), prompt_version: z.string().min(1).max(160), input_basis_hash: hash, usage: providerUsageSchema, cache_hit: z.boolean(), upstream_receipt_hash: hash.optional(), created_at: iso }).strict()
export type ProviderExecutionReceipt = z.infer<typeof providerExecutionReceiptSchema>

/** Result bytes never travel through the Relay control plane.  A result object
 * is readable only for the short lease below and is released by ACK. */
export const relayResultObjectSchema = z.object({
  object_ref: opaqueId,
  content_hash: hash,
  byte_size: z.number().int().positive().max(VIDEO_MEDIA_RELAY_RESULT_MAX_BYTES),
  content_type: z.string().min(3).max(160),
  get_url: z.string().url(),
  expires_at: iso,
}).strict()
export type RelayResultObject = z.infer<typeof relayResultObjectSchema>

export const videoRelayOperationProjectionSchema = z.object({ id: opaqueId, state: z.enum(['accepted', 'submitted', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown', 'expired']), provider_task_id: z.string().min(1).max(500).optional(), result_object_refs: z.array(opaqueId).max(64).optional(), result_objects: z.array(relayResultObjectSchema).max(64).optional(), provider_receipt: providerExecutionReceiptSchema.optional(), account_quota_reservation_id: opaqueId, safe_error_code: z.string().min(1).max(160).optional(), retry_after_ms: z.number().int().positive().max(24 * 60 * 60_000).optional(), created_at: iso, updated_at: iso }).strict()
export type VideoRelayOperationProjection = z.infer<typeof videoRelayOperationProjectionSchema>

export const operationAcknowledgementSchema = z.object({ result_hashes: z.array(hash).max(64), receipt_id: opaqueId }).strict()
export function canonicalRelayRequestHash(value: unknown): `sha256:${string}` {
  // Credentials rotate faster than a durable idempotency fence.  Deliberately
  // exclude only this signed authorization envelope so a restarted Sidecar
  // can prove the same logical request with a fresh short-lived claim.
  const logical = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'remote_consent_claim'))
    : value
  return `sha256:${createHash('sha256').update(stableJson(logical)).digest('hex')}`
}
