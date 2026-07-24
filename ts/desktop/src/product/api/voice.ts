import {
  productVoiceTranscriptionResponseSchema,
  transcriptSchema,
  voiceConsumerEvidenceSchema,
  type ProductVoiceTranscriptionResponse,
  type Transcript,
  type VoiceConsumer,
  type VoiceConsumerEvidence,
} from '../../../../shared/contracts/voice'
import { productApi } from './client'

export type VoiceTranscriptionOptions = {
  language?: string
  signal?: AbortSignal
}

function audioExtension(type: string): string {
  if (type.includes('ogg')) return 'ogg'
  if (type.includes('mp4')) return 'm4a'
  if (type.includes('wav')) return 'wav'
  return 'webm'
}

const PRODUCT_VOICE_PATH = '/api/product/voice/transcribe'
const PRODUCT_VOICE_TIMEOUT_MS = 10 * 60_000

export const productVoiceApi = {
  async transcribe(
    blob: Blob,
    options: VoiceTranscriptionOptions = {},
  ): Promise<ProductVoiceTranscriptionResponse> {
    const form = new FormData()
    const type = blob.type || 'audio/webm'
    form.set('file', new File(
      [blob],
      `voice-${Date.now()}.${audioExtension(type)}`,
      { type },
    ))
    if (options.language) form.set('language', options.language)

    const response = await productApi.postForm<unknown>(PRODUCT_VOICE_PATH, form, {
      signal: options.signal,
      timeout: PRODUCT_VOICE_TIMEOUT_MS,
    })
    return productVoiceTranscriptionResponseSchema.parse(response)
  },

  async revise(
    transcriptId: string,
    parentRevisionId: string,
    text: string,
  ): Promise<Transcript> {
    const response = await productApi.post<unknown>(
      `/api/product/voice/transcripts/${encodeURIComponent(transcriptId)}/revisions`,
      { parent_revision_id: parentRevisionId, text },
    )
    return transcriptSchema.parse((response as { transcript?: unknown }).transcript)
  },

  async bind(
    transcriptId: string,
    revisionId: string,
    consumer: VoiceConsumer,
  ): Promise<Transcript> {
    const response = await productApi.post<unknown>(
      `/api/product/voice/transcripts/${encodeURIComponent(transcriptId)}/bindings`,
      { revision_id: revisionId, consumer },
    )
    return transcriptSchema.parse((response as { transcript?: unknown }).transcript)
  },

  async listEvidence(consumer: VoiceConsumer): Promise<VoiceConsumerEvidence[]> {
    const params = new URLSearchParams({ consumer_kind: consumer.kind, consumer_id: consumer.id })
    const response = await productApi.get<unknown>(`/api/product/voice/bindings?${params}`)
    const evidence = (response as { evidence?: unknown }).evidence
    return voiceConsumerEvidenceSchema.array().parse(evidence)
  },
}
