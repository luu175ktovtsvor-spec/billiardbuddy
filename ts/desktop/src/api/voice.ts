import {
  voiceErrorResponseSchema,
  voiceTranscriptionResponseSchema,
} from '../../../shared/contracts/voice'
import { getAuthToken, getBaseUrl } from './client'

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

export const voiceApi = {
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

    const token = getAuthToken()
    const response = await fetch(`${getBaseUrl()}/api/voice/transcribe`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
      signal: options.signal,
    })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const parsed = voiceErrorResponseSchema.safeParse(body)
      throw new Error(parsed.success ? parsed.data.detail : '语音转写失败，请重试')
    }
    return voiceTranscriptionResponseSchema.parse(body).text
  },
}
