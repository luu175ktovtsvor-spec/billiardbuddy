import { expect, test } from 'bun:test'
import { createGatewayTranscriber, createUpstreamTranscriber, GatewayTranscriptionError, parseWhisperJson } from './transcription'

test('parseWhisperJson normalizes whisper.cpp offsets and Chinese spacing', () => {
  expect(parseWhisperJson({
    transcription: [
      { offsets: { from: 0, to: 900 }, text: ' 今天 ' },
      { offsets: { from: 1000, to: 1800 }, text: '检查球桌' },
      { offsets: { from: 'bad', to: 2000 }, text: 'ignored' },
    ],
  }, 'zh')).toEqual({
    text: '今天检查球桌',
    language: 'zh',
    duration: 1.8,
    segments: [
      { id: 0, start: 0, end: 0.9, text: '今天' },
      { id: 1, start: 1, end: 1.8, text: '检查球桌' },
    ],
  })
})

test('parseWhisperJson rejects empty model output without leaking internals', () => {
  expect(() => parseWhisperJson({ transcription: [] }, 'zh')).toThrow(GatewayTranscriptionError)
})

test('upstream provider preserves the public contract and server-only bearer', async () => {
  let authorization = ''
  const transcribe = createUpstreamTranscriber({
    GW_TRANSCRIBE_UPSTREAM_URL: 'http://127.0.0.1:8000/v1/audio/transcriptions',
    GW_TRANSCRIBE_UPSTREAM_TOKEN: 'internal-token',
  }, async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return Response.json({
      text: '检查球桌', language: 'zh', duration: 1,
      segments: [{ start: 0, end: 1, text: '检查球桌' }],
    })
  })
  expect(transcribe).not.toBeNull()
  const result = await transcribe!(new File(['audio'], 'voice.wav', { type: 'audio/wav' }), {
    language: 'zh', responseFormat: 'verbose_json',
  })
  expect(authorization).toBe('Bearer internal-token')
  expect(result).toMatchObject({ text: '检查球桌', segments: [{ id: 0, start: 0, end: 1 }] })
})

test('unknown provider fails closed', () => {
  expect(createGatewayTranscriber({ GW_TRANSCRIBE_PROVIDER: 'unknown' })).toBeNull()
})

test('upstream credentials and provider errors are not exposed to clients', async () => {
  const transcribe = createUpstreamTranscriber({
    GW_TRANSCRIBE_UPSTREAM_URL: 'https://provider.example/audio',
    GW_TRANSCRIBE_UPSTREAM_TOKEN: 'provider-secret',
  }, async () => Response.json({ error: { message: 'qwen internal key provider-secret is invalid' } }, { status: 401 }))
  await expect(transcribe!(new File(['audio'], 'voice.wav', { type: 'audio/wav' }), {
    language: 'zh', responseFormat: 'json',
  })).rejects.toMatchObject({ status: 502, publicMessage: '语音识别上游暂时不可用' })
})
