import { expect, test } from 'bun:test'

import { createFunAsrTranscriber, GatewayTranscriptionError } from './transcription.ts'

test('Fun-ASR adapter checks the supplied capacity fence before its real fetch', async () => {
  let fetches = 0
  const transcribe = createFunAsrTranscriber({
    GW_FUNASR_KEY: 'funasr-test-key',
    GW_FUNASR_BASE: 'https://funasr.example.test/api/v1/services/aigc/multimodal-generation/generation',
  }, async () => {
    fetches += 1
    return Response.json({})
  })!
  await expect(transcribe(new File(['audio'], 'clip.wav', { type: 'audio/wav' }), {
    language: 'zh', responseFormat: 'json',
    assertCurrent: () => { throw new Error('lease expired before fetch') },
  })).rejects.toBeInstanceOf(GatewayTranscriptionError)
  expect(fetches).toBe(0)
})
