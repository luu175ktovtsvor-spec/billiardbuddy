import { describe, expect, it } from 'bun:test'
import { handleProductVoiceApi } from '../api/productVoice.js'
import {
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
} from '../services/voiceTranscription.js'
import { handleApiRequest } from '../router.js'

function voiceRequest(
  file?: File,
  language?: string,
  path = '/api/product/voice/transcribe',
): Request {
  const form = new FormData()
  if (file) form.set('file', file)
  if (language) form.set('language', language)
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: form,
  })
}

const productVoiceSegments = ['api', 'product', 'voice', 'transcribe']

describe('product voice API', () => {
  it('forwards the recording and returns transcript text', async () => {
    let received: { name: string; language?: string; signal?: AbortSignal } | null = null
    const response = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm', { type: 'audio/webm' }), 'zh'),
      productVoiceSegments,
      {
        transcribe: async (file: File, opts: VoiceTranscriptionOptions = {}) => {
          received = { name: file.name, language: opts.language, signal: opts.signal }
          return { text: '今天晚上八点开赛' }
        },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: '今天晚上八点开赛' })
    expect(received).toEqual(expect.objectContaining({ name: 'voice.webm', language: 'zh' }))
    expect(received?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects missing, empty and oversized recordings', async () => {
    const missing = await handleProductVoiceApi(
      voiceRequest(),
      productVoiceSegments,
    )
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ detail: '请先录制一段音频' })

    const empty = await handleProductVoiceApi(
      voiceRequest(new File([], 'empty.webm')),
      productVoiceSegments,
    )
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ detail: '没有录到声音，请重新录一次' })

    const oversized = await handleProductVoiceApi(
      voiceRequest(new File(['12345'], 'large.webm')),
      productVoiceSegments,
      { env: { QF_TRANSCRIBE_MAX_BYTES: '4' } },
    )
    expect(oversized.status).toBe(413)
  })

  it('uses only the configured gateway and returns safe product errors', async () => {
    const response = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm')),
      productVoiceSegments,
      { env: {} },
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: '语音转写暂时无法完成，请稍后重试。' })

    const upstream = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm')),
      productVoiceSegments,
      {
        transcribe: async () => {
          throw new VoiceTranscriptionError('DeepSeek rejected a private gateway token', 503)
        },
      },
    )
    expect(upstream.status).toBe(503)
    expect(await upstream.json()).toEqual({ detail: '语音转写暂时无法完成，请稍后重试。' })
  })

  it('retires the generic voice route after the product route is connected', async () => {
    const genericRequest = voiceRequest(undefined, undefined, '/api/voice/transcribe')
    const genericResponse = await handleApiRequest(genericRequest, new URL(genericRequest.url))
    expect(genericResponse.status).toBe(404)

    const productRequest = voiceRequest()
    const productResponse = await handleApiRequest(productRequest, new URL(productRequest.url))
    expect(productResponse.status).toBe(400)
    expect(await productResponse.json()).toEqual({ detail: '请先录制一段音频' })
  })
})
