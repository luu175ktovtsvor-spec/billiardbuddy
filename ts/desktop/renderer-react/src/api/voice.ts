import { voiceErrorResponseSchema, voiceTranscriptionResponseSchema } from '../../../../shared/contracts/voice'
import { getAuthToken, getBaseUrl } from './client'

export const voiceApi = {
  async transcribe(blob: Blob): Promise<string> {
    const form = new FormData()
    const extension = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'
    form.set('file', new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type || 'audio/webm' }))
    const token = getAuthToken()
    const response = await fetch(`${getBaseUrl()}/api/v1/voice/transcribe`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const parsed = voiceErrorResponseSchema.safeParse(body)
      throw new Error(parsed.success ? parsed.data.detail : '语音转写失败，请重试')
    }
    return voiceTranscriptionResponseSchema.parse(body).text
  },
}
