import { voiceTranscriptionResponseSchema } from '../../../../shared/contracts/voice'
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
  ): Promise<string> {
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
    return voiceTranscriptionResponseSchema.parse(response).text
  },
}
