import { describe, expect, it } from 'bun:test'
import { handleVoiceApi } from '../api/voice.js'
import type { VoiceTranscriptionOptions } from '../services/voiceTranscription.js'

function voiceRequest(file?: File, language?: string): Request {
  const form = new FormData()
  if (file) form.set('file', file)
  if (language) form.set('language', language)
  return new Request('http://localhost/api/voice/transcribe', {
    method: 'POST',
    body: form,
  })
}

describe('voice API', () => {
  it('forwards the recording and returns transcript text', async () => {
    let received: { name: string; language?: string } | null = null
    const response = await handleVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm', { type: 'audio/webm' }), 'zh'),
      ['api', 'voice', 'transcribe'],
      {
        transcribe: async (file: File, opts: VoiceTranscriptionOptions = {}) => {
          received = { name: file.name, language: opts.language }
          return { text: '今天晚上八点开赛' }
        },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: '今天晚上八点开赛' })
    expect(received).toEqual({ name: 'voice.webm', language: 'zh' })
  })

  it('rejects missing, empty and oversized recordings', async () => {
    const missing = await handleVoiceApi(
      voiceRequest(),
      ['api', 'voice', 'transcribe'],
    )
    expect(missing.status).toBe(400)

    const empty = await handleVoiceApi(
      voiceRequest(new File([], 'empty.webm')),
      ['api', 'voice', 'transcribe'],
    )
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ detail: '没收到录音内容，请重新录一次' })

    const oversized = await handleVoiceApi(
      voiceRequest(new File(['12345'], 'large.webm')),
      ['api', 'voice', 'transcribe'],
      { env: { QF_TRANSCRIBE_MAX_BYTES: '4' } },
    )
    expect(oversized.status).toBe(413)
  })

  it('uses only the configured gateway and fails closed without it', async () => {
    const response = await handleVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm')),
      ['api', 'voice', 'transcribe'],
      { env: {} },
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: '语音识别服务器未配置' })
  })
})
