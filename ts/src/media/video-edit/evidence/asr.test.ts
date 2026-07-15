import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WhisperCppAsrAdapter } from './asr'

test('ASR evidence identifies the remote gateway instead of claiming local Whisper execution', () => {
  const adapter = new WhisperCppAsrAdapter({
    QF_GATEWAY_URL: 'https://gateway.example/v1',
    QF_GATEWAY_TOKEN: 'app-token',
  })

  expect(adapter.id).toBe('gateway-asr')
  expect(adapter.version).toBe('remote-v1')
})

test('ASR unavailability reports the actual configuration gap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-asr-unavailable-'))
  try {
    const adapter = new WhisperCppAsrAdapter({ PATH: '', QF_TRANSCRIBE_MODE: 'remote' })
    const result = await adapter.transcribe(join(root, 'missing.mp4'), join(root, 'work'))

    expect(result).toMatchObject({
      transcript: null,
      provider: 'gateway-asr',
      providerVersion: 'remote-v1',
      warning: '语音识别服务器未配置',
    })
    expect(result.warning).not.toContain('本地语音转写组件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
