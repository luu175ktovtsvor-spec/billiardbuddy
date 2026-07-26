import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleProductVoiceApi } from '../api/productVoice.js'
import {
  VoiceTranscriptionError,
  type VoiceTranscriptionOptions,
} from '../services/voiceTranscription.js'
import { handleApiRequest } from '../router.js'
import { VoiceOperationService } from '../services/voiceOperationService.js'

async function operations(): Promise<VoiceOperationService> {
  return new VoiceOperationService({ root: await mkdtemp(join(tmpdir(), 'bb-voice-api-')) })
}

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
    let received: { name: string; language?: string; signal?: AbortSignal; operationId?: string } | null = null
    const response = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm', { type: 'audio/webm' }), '  zh-Hans-CN-very-long  '),
      productVoiceSegments,
      {
        operations: await operations(),
        transcribe: async (file: File, opts: VoiceTranscriptionOptions = {}) => {
          received = { name: file.name, language: opts.language, signal: opts.signal, operationId: opts.operationId }
          return { text: '今天晚上八点开赛' }
        },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      text: '今天晚上八点开赛',
      operation: { status: 'succeeded' },
      transcript: { revisions: [{ kind: 'raw', text: '今天晚上八点开赛' }] },
    })
    expect(received).toEqual(expect.objectContaining({ name: 'voice.webm', language: 'zh-Hans-CN-very-' }))
    expect(received?.signal).toBeInstanceOf(AbortSignal)
    expect(received?.operationId).toMatch(/^voice_[a-f0-9]{32}$/)
  })

  it('rejects missing, empty and oversized recordings', async () => {
    const missing = await handleProductVoiceApi(
      voiceRequest(),
      productVoiceSegments,
    )
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_INVALID_AUDIO',
      message: '请先录制一段有效音频后重试。',
    })

    const empty = await handleProductVoiceApi(
      voiceRequest(new File([], 'empty.webm')),
      productVoiceSegments,
    )
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_INVALID_AUDIO',
      message: '请先录制一段有效音频后重试。',
    })

    const oversized = await handleProductVoiceApi(
      voiceRequest(new File(['12345'], 'large.webm')),
      productVoiceSegments,
      { env: { BB_TRANSCRIBE_MAX_BYTES: '4' } },
    )
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_TOO_LARGE',
      message: '录音文件过大，请缩短后重试。',
    })

    const declaredOversized = await handleProductVoiceApi(
      new Request('http://localhost/api/product/voice/transcribe', {
        method: 'POST',
        headers: { 'content-length': String(1024 * 1024 + 5) },
      }),
      productVoiceSegments,
      { env: { BB_TRANSCRIBE_MAX_BYTES: '4' } },
    )
    expect(declaredOversized.status).toBe(413)
    expect(await declaredOversized.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_TOO_LARGE',
      message: '录音文件过大，请缩短后重试。',
    })
  })

  it('uses only the configured gateway and returns safe product errors', async () => {
    const response = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm')),
      productVoiceSegments,
      { env: {}, operations: await operations() },
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_UNAVAILABLE',
      message: '语音转写暂时不可用，请稍后重试。',
    })

    const upstream = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm')),
      productVoiceSegments,
      {
        operations: await operations(),
        transcribe: async () => {
          throw new VoiceTranscriptionError('DeepSeek rejected a private gateway token', 503)
        },
      },
    )
    expect(upstream.status).toBe(503)
    const upstreamBody = await upstream.json()
    expect(upstreamBody).toEqual({
      error: 'VOICE_TRANSCRIPTION_UNAVAILABLE',
      message: '语音转写暂时不可用，请稍后重试。',
    })
    expect(JSON.stringify(upstreamBody)).not.toContain('DeepSeek')
    expect(JSON.stringify(upstreamBody)).not.toContain('private gateway token')

    const cancelled = await handleProductVoiceApi(
      voiceRequest(new File(['audio'], 'voice.webm')),
      productVoiceSegments,
      {
        operations: await operations(),
        transcribe: async () => {
          throw new VoiceTranscriptionError('gateway request aborted', 499)
        },
      },
    )
    expect(cancelled.status).toBe(499)
    expect(await cancelled.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_CANCELLED',
      message: '语音转写已取消。',
    })
  })

  it('exposes immutable revision, binding and cancellation resources', async () => {
    const voice = await operations()
    const started = await voice.begin(new File(['audio'], 'voice.webm'))
    const completed = await voice.complete(started.operation.id, '原始文本')

    const revisionResponse = await handleProductVoiceApi(
      new Request(`http://localhost/api/product/voice/transcripts/${completed.transcript.id}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parent_revision_id: completed.transcript.raw_revision_id,
          text: '校正文本',
        }),
      }),
      ['api', 'product', 'voice', 'transcripts', completed.transcript.id, 'revisions'],
      { operations: voice },
    )
    expect(revisionResponse.status).toBe(201)
    const revised = (await revisionResponse.json()).transcript
    expect(revised.revisions).toHaveLength(2)
    expect(revised.revisions[0].text).toBe('原始文本')

    const bindingResponse = await handleProductVoiceApi(
      new Request(`http://localhost/api/product/voice/transcripts/${completed.transcript.id}/bindings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision_id: revised.current_revision_id,
          consumer: { kind: 'composer', id: 'task_0123456789abcdef' },
        }),
      }),
      ['api', 'product', 'voice', 'transcripts', completed.transcript.id, 'bindings'],
      { operations: voice },
    )
    expect(bindingResponse.status).toBe(201)
    expect((await bindingResponse.json()).transcript.bindings).toHaveLength(1)

    const listResponse = await handleProductVoiceApi(
      new Request('http://localhost/api/product/voice/bindings?consumer_kind=composer&consumer_id=task_0123456789abcdef'),
      ['api', 'product', 'voice', 'bindings'],
      { operations: voice },
    )
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toMatchObject({
      evidence: [{ revision: { text: '校正文本' }, binding: { consumer: { kind: 'composer' } } }],
    })

    const pending = await voice.begin(new File(['audio'], 'pending.webm'))
    const cancelled = await handleProductVoiceApi(
      new Request(`http://localhost/api/product/voice/operations/${pending.operation.id}/cancel`, { method: 'POST' }),
      ['api', 'product', 'voice', 'operations', pending.operation.id, 'cancel'],
      { operations: voice },
    )
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ operation: { status: 'cancelled' } })
    expect(pending.signal.aborted).toBe(true)
  })

  it('retires the generic voice route after the product route is connected', async () => {
    const genericRequest = voiceRequest(undefined, undefined, '/api/voice/transcribe')
    const genericResponse = await handleApiRequest(genericRequest, new URL(genericRequest.url))
    expect(genericResponse.status).toBe(404)

    const productRequest = voiceRequest()
    const productResponse = await handleApiRequest(productRequest, new URL(productRequest.url))
    expect(productResponse.status).toBe(400)
    expect(await productResponse.json()).toEqual({
      error: 'VOICE_TRANSCRIPTION_INVALID_AUDIO',
      message: '请先录制一段有效音频后重试。',
    })
  })

  it('rejects unsupported methods and nested paths with product API errors', async () => {
    const method = await handleProductVoiceApi(
      new Request('http://localhost/api/product/voice/transcribe'),
      productVoiceSegments,
    )
    expect(method.status).toBe(405)
    expect(await method.json()).toEqual({
      error: 'METHOD_NOT_ALLOWED',
      message: '当前语音操作暂不支持',
    })

    const nested = await handleProductVoiceApi(
      voiceRequest(),
      [...productVoiceSegments, 'private'],
    )
    expect(nested.status).toBe(404)
    expect(await nested.json()).toEqual({
      error: 'NOT_FOUND',
      message: '当前语音操作不可用',
    })
  })
})
