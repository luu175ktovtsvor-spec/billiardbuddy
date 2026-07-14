import { expect, test } from 'bun:test'
import { resolveRemoteTranscriptionConfig, transcribeRemoteFile } from './remoteTranscription'

test('resolveRemoteTranscriptionConfig uses the gateway endpoint unless local mode is explicit', () => {
  expect(resolveRemoteTranscriptionConfig({
    QF_GATEWAY_URL: 'https://gateway.example/gw/',
    QF_GATEWAY_TOKEN: 'app-token',
  })).toEqual({ endpoint: 'https://gateway.example/gw/v1/audio/transcriptions', token: 'app-token' })
  expect(resolveRemoteTranscriptionConfig({
    QF_TRANSCRIBE_MODE: 'local',
    QF_GATEWAY_URL: 'https://gateway.example/gw',
    QF_GATEWAY_TOKEN: 'app-token',
  })).toBeNull()
})

test('transcribeRemoteFile sends app auth and parses verbose timestamps', async () => {
  let request: RequestInit | undefined
  const result = await transcribeRemoteFile(new File(['audio'], 'voice.webm', { type: 'audio/webm' }), {
    env: { QF_GATEWAY_URL: 'https://gateway.example/gw', QF_GATEWAY_TOKEN: 'app-token' },
    responseFormat: 'verbose_json',
    fetchImpl: async (_input, init) => {
      request = init
      return Response.json({
        text: '开台检查', language: 'zh', duration: 1,
        segments: [{ id: 0, start: 0, end: 1, text: '开台检查' }],
      })
    },
  })
  expect((request?.headers as Record<string, string>).Authorization).toBe('Bearer app-token')
  expect(request?.body).toBeInstanceOf(FormData)
  expect(result).toMatchObject({ text: '开台检查', segments: [{ start: 0, end: 1 }] })
})

test('transcribeRemoteFile preserves safe server error text', async () => {
  await expect(transcribeRemoteFile(new File(['audio'], 'voice.wav', { type: 'audio/wav' }), {
    env: { QF_GATEWAY_URL: 'https://gateway.example/gw', QF_GATEWAY_TOKEN: 'app-token' },
    fetchImpl: async () => Response.json({ detail: '今天的语音识别额度已用完' }, { status: 429 }),
  })).rejects.toThrow('今天的语音识别额度已用完')
})
