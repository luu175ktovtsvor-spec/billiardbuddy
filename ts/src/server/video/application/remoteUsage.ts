import {
  defaultManagedModelForWorkload,
  managedModelsForWorkload,
} from '../../../../shared/product/modelCatalog.js'

/**
 * Provider-neutral admission policy for paid Video Relay calls.
 *
 * The Provider receipt remains the billing authority. These values are only
 * conservative pre-call reservations; keeping them in one module prevents
 * estimates and individual call paths from silently drifting apart.
 */
export const VIDEO_REMOTE_USAGE_POLICY = Object.freeze({
  revision: 'video-remote-usage-v2',
  textTokenMicros: 10,
  visualFrameMicros: 250,
  asrSecondMicros: 120,
  captionTranslationFixedMicros: 1_280,
  planningOutputTokenReserve: 4_096,
  captionTranslationOutputTokenReserve: 4_096,
  planningContextTokenReserve: 16_384,
  visualOutputTokenReserve: 512,
  requestOverheadBytes: 128 * 1024,
  semanticQueryTokenReserve: 1,
  semanticDocumentBatchSize: 2_000,
  semanticDocumentMaxItems: 10_000,
})

/** The embedding model is a catalog fact, not a second server-side model list. */
const longAsrModels = managedModelsForWorkload('video_speech_transcription')
const longAsrModel = longAsrModels.find(entry => entry.workload_bindings.some(binding => (
  binding.workload === 'video_speech_transcription' && binding.default_for_workload !== true
)))
if (!longAsrModel) throw new Error('video_speech_transcription must register a non-default long-ASR model')

/** The catalog binding is part of the paid request identity. A model change
 * must invalidate an old estimate and idempotency fence instead of silently
 * replaying the same logical operation against a different model. */
export const VIDEO_REMOTE_MODEL_BINDINGS = Object.freeze({
  visualEvidence: defaultManagedModelForWorkload('video_visual_evidence').model_id,
  mediaReasoning: defaultManagedModelForWorkload('video_media_reasoning').model_id,
  shortAsr: defaultManagedModelForWorkload('video_speech_transcription').model_id,
  longAsr: longAsrModel.model_id,
  semanticEmbedding: defaultManagedModelForWorkload('video_semantic_embedding').model_id,
})

export const VIDEO_SEMANTIC_EMBEDDING_MODEL = VIDEO_REMOTE_MODEL_BINDINGS.semanticEmbedding

/** A deliberately conservative token approximation for admission. ASCII uses
 * the usual four-byte average; non-ASCII code points reserve one token each
 * so Chinese/Japanese/Korean text is not understated by raw bytes / 4. */
export function estimatedTextTokens(value: string): number {
  let asciiBytes = 0
  let nonAsciiCodePoints = 0
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) asciiBytes += Buffer.byteLength(character, 'utf8')
    else nonAsciiCodePoints += 1
  }
  return Math.max(1, Math.ceil(asciiBytes / 4) + nonAsciiCodePoints)
}

export function estimatedTextAmountMicros(
  tokens: number,
  fixedMicros = 0,
): number {
  return Math.max(1, Math.ceil(Math.max(0, tokens) * VIDEO_REMOTE_USAGE_POLICY.textTokenMicros + fixedMicros))
}
