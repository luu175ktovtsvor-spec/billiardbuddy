import { expect, test } from 'bun:test'
import { createFunAsrTranscriber, createGatewayTranscriber, GatewayTranscriptionError, parseFunAsrResult } from './transcription'

// Fun-ASR 成功响应:套两层 output.output.{text, sentence:{text, words}}。
function funAsrOk(words: Array<{ text: string; begin_time: number; end_time: number }>, text: string) {
  return Response.json({
    output: { output: { request_id: 'r1', text, sentence: { begin_time: words[0]?.begin_time ?? 0, end_time: words.at(-1)?.end_time ?? 0, text, words } } },
    usage: { audio_tokens: 100, seconds: 2 },
  })
}

test('Fun-ASR provider:verbose_json 请求带 format+enable_words,响应词级毫秒→秒级 segments', async () => {
  let sentBody: any = null
  let authorization = ''
  const transcribe = createFunAsrTranscriber({ GW_FUNASR_KEY: 'bailian-key' }, async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    sentBody = JSON.parse(String(init?.body))
    return funAsrOk(
      [{ text: '各位', begin_time: 120, end_time: 560 }, { text: '球', begin_time: 560, end_time: 760 }],
      '各位球',
    )
  })
  expect(transcribe).not.toBeNull()
  const result = await transcribe!(new File(['audio'], 'clip.flac', { type: 'audio/flac' }), {
    language: 'zh', responseFormat: 'verbose_json',
  })
  // key 只在服务端,格式放 parameters 顶层,要时间戳时 enable_words=true
  expect(authorization).toBe('Bearer bailian-key')
  expect(sentBody.parameters.format).toBe('flac')
  expect(sentBody.parameters.asr_options.enable_words).toBe(true)
  expect(sentBody.model).toBe('fun-asr-flash-2026-06-15')
  // 毫秒→秒,每个 word 一个 segment(视频端当词用)
  expect(result).toMatchObject({
    text: '各位球',
    segments: [
      { id: 0, start: 0.12, end: 0.56, text: '各位' },
      { id: 1, start: 0.56, end: 0.76, text: '球' },
    ],
  })
})

test('Fun-ASR provider:json 模式只要文字,不开 enable_words', async () => {
  let sentBody: any = null
  const transcribe = createFunAsrTranscriber({ GW_FUNASR_KEY: 'k' }, async (_i, init) => {
    sentBody = JSON.parse(String(init?.body))
    return funAsrOk([{ text: '你好', begin_time: 0, end_time: 400 }], '你好')
  })
  const result = await transcribe!(new File(['a'], 'voice.wav'), { language: 'zh', responseFormat: 'json' })
  expect(sentBody.parameters.asr_options.enable_words).toBe(false)
  expect(result).toEqual({ text: '你好' })
})

test('Fun-ASR 错误码不泄露内部,UNSUPPORTED_FORMAT→422', async () => {
  const transcribe = createFunAsrTranscriber({ GW_FUNASR_KEY: 'k' }, async () =>
    Response.json({ code: 'UNSUPPORTED_FORMAT', message: 'format is empty', request_id: 'x' }))
  await expect(transcribe!(new File(['a'], 'voice.wav'), { language: 'zh', responseFormat: 'json' }))
    .rejects.toMatchObject({ status: 422 })
})

test('Fun-ASR 无 key 时 provider 关闭(fail closed)', () => {
  expect(createFunAsrTranscriber({})).toBeNull()
})

test('createGatewayTranscriber defaults to Fun-ASR and rejects retired providers', () => {
  expect(createGatewayTranscriber({ GW_FUNASR_KEY: 'k' })).not.toBeNull()
  expect(createGatewayTranscriber({ GW_TRANSCRIBE_PROVIDER: 'funasr', GW_FUNASR_KEY: 'k' })).not.toBeNull()
  expect(createGatewayTranscriber({ GW_TRANSCRIBE_PROVIDER: 'funasr' })).toBeNull() // 缺 key 关闭
  expect(createGatewayTranscriber({ GW_TRANSCRIBE_PROVIDER: 'whisper', GW_FUNASR_KEY: 'k' })).toBeNull()
  expect(createGatewayTranscriber({ GW_TRANSCRIBE_PROVIDER: 'upstream', GW_FUNASR_KEY: 'k' })).toBeNull()
  expect(createGatewayTranscriber({ GW_TRANSCRIBE_PROVIDER: 'unknown', GW_FUNASR_KEY: 'k' })).toBeNull()
})

test('parseFunAsrResult:空文字关闭,不返回空结果', () => {
  expect(() => parseFunAsrResult({ output: { output: { text: '', sentence: {} } } }, 'json')).toThrow(GatewayTranscriptionError)
})
