import {
  voiceErrorResponseSchema,
  voiceTranscriptionResponseSchema,
} from '../../../../shared/contracts/voice'
import { getServerBaseUrl } from '../../lib/desktopRuntime'

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

    const response = await fetch(`${getServerBaseUrl().replace(/\/$/, '')}${PRODUCT_VOICE_PATH}`, {
      method: 'POST',
      body: form,
      signal: options.signal,
    })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const parsed = voiceErrorResponseSchema.safeParse(body)
      throw new Error(parsed.success ? parsed.data.detail : '语音转写暂时无法完成，请稍后重试。')
    }
    return voiceTranscriptionResponseSchema.parse(body).text
  },
}
