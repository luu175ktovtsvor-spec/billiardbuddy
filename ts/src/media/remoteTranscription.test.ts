import { expect, test } from 'bun:test'
import {
  RemoteTranscriptionError,
  resolveRemoteTranscriptionConfig,
  transcribeRemoteFile,
} from './remoteTranscription.js'

test('resolveRemoteTranscriptionConfig targets the product gateway', () => {
  expect(resolveRemoteTranscriptionConfig({
    QF_GATEWAY_URL: 'https://gateway.example/gw/',
    QF_GATEWAY_TOKEN: 'app-token',
    BB_INSTALLATION_ID: 'install-001',
  })).toEqual({
    endpoint: 'https://gateway.example/gw/v1/audio/transcriptions',
    token: 'app-token',
    clientId: 'install-001',
  })
  expect(resolveRemoteTranscriptionConfig({
    QF_GATEWAY_URL: 'file:///tmp/gateway',
    QF_GATEWAY_TOKEN: 'app-token',
  })).toBeNull()
  expect(resolveRemoteTranscriptionConfig({
    QF_GATEWAY_URL: 'http://39.106.214.21/gw',
    QF_GATEWAY_TOKEN: 'app-token',
  })).toBeNull()
})

test('transcribeRemoteFile forwards audio with server-side auth', async () => {
  let requestUrl = ''
  let request: RequestInit | undefined
  const result = await transcribeRemoteFile(
    new File(['audio'], 'voice.webm', { type: 'audio/webm' }),
    {
      env: {
        QF_GATEWAY_URL: 'https://gateway.example/gw',
        QF_GATEWAY_TOKEN: 'app-token',
        BB_INSTALLATION_ID: 'install-001',
      },
      fetchImpl: async (input, init) => {
        requestUrl = String(input)
        request = init
        return Response.json({ text: '开台检查' })
      },
    },
  )

  expect(requestUrl).toBe('https://gateway.example/gw/v1/audio/transcriptions')
  expect(new Headers(request?.headers).get('authorization')).toBe('Bearer app-token')
  expect(new Headers(request?.headers).get('x-qf-client-id')).toBe('install-001')
  expect(request?.body).toBeInstanceOf(FormData)
  expect(result).toEqual({ text: '开台检查' })
})

test('transcribeRemoteFile preserves safe gateway errors', async () => {
  await expect(transcribeRemoteFile(
    new File(['audio'], 'voice.wav', { type: 'audio/wav' }),
    {
      env: {
        QF_GATEWAY_URL: 'https://gateway.example/gw',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async () => Response.json(
        { detail: '今天的语音识别额度已用完' },
        { status: 429 },
      ),
    },
  )).rejects.toThrow('今天的语音识别额度已用完')
})

test('transcribeRemoteFile fails closed without a configured gateway', async () => {
  try {
    await transcribeRemoteFile(new File(['audio'], 'voice.webm'), { env: {} })
    throw new Error('expected transcription to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteTranscriptionError)
    expect((error as RemoteTranscriptionError).status).toBe(503)
  }
})
