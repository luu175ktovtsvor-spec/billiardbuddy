import { extname } from 'node:path'
import { defaultManagedModelForWorkload } from '../ts/shared/product/modelCatalog.js'
import { loadGatewayProviderCredentials, type GatewayProviderCredentials } from './providerCredentials'

type Env = Record<string, string | undefined>

export interface GatewayTranscriptionOptions {
  language: string
  responseFormat: 'json' | 'verbose_json'
  signal?: AbortSignal
  /** Capacity fence supplied by Gateway immediately before each provider call. */
  assertCurrent?: () => void | Promise<void>
}

export interface GatewayTranscriptionSegment {
  id: number
  start: number
  end: number
  text: string
}

export interface GatewayTranscriptionResult {
  text: string
  language?: string
  duration?: number
  segments?: GatewayTranscriptionSegment[]
}

export type GatewayTranscriber = (file: File, opts: GatewayTranscriptionOptions) => Promise<GatewayTranscriptionResult>
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export class GatewayTranscriptionError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function inputSuffix(file: File): string {
  const ext = extname(file.name || '').toLowerCase()
  if (/^\.(wav|wave|mp3|m4a|mp4|webm|ogg|oga|flac|aac)$/.test(ext)) return ext
  const type = file.type.toLowerCase()
  if (type.includes('wav')) return '.wav'
  if (type.includes('mpeg')) return '.mp3'
  if (type.includes('mp4')) return '.m4a'
  if (type.includes('ogg')) return '.ogg'
  if (type.includes('flac')) return '.flac'
  return '.webm'
}

// 阿里百炼 Fun-ASR：DashScope 多模态生成端点,同步一次返回文字 + 词级时间戳。
const DEFAULT_FUNASR_MODEL = defaultManagedModelForWorkload('speech_transcription').model_id

/** 文件后缀 → Fun-ASR 的 format 值(wav/mp3/flac/m4a…)。 */
function funAsrFormat(file: File): string {
  const fmt = inputSuffix(file).replace(/^\./, '').toLowerCase()
  if (fmt === 'wave') return 'wav'
  if (fmt === 'oga') return 'ogg'
  if (fmt === 'mp4') return 'm4a'
  return fmt || 'wav'
}

/**
 * 解析 Fun-ASR 响应:错误体是 {code,message};成功体套两层 output.output.{text, sentence:{text, words}}。
 * words 的 begin_time/end_time 是毫秒,映射成网关秒级 segments(视频端把每个 word 当一个词用)。
 */
export function parseFunAsrResult(raw: unknown, format: 'json' | 'verbose_json'): GatewayTranscriptionResult {
  if (!raw || typeof raw !== 'object') throw new GatewayTranscriptionError(502, '语音识别返回了无效结果')
  const body = raw as Record<string, unknown>
  const code = typeof body.code === 'string' ? body.code : ''
  if (code) {
    if (/FORMAT/i.test(code)) throw new GatewayTranscriptionError(422, '音频格式不支持,请换一种格式重试')
    if (/THROTTL|LIMIT|FLOW|QUOTA/i.test(code)) throw new GatewayTranscriptionError(429, '语音识别服务繁忙,请稍后重试')
    throw new GatewayTranscriptionError(502, '语音识别服务暂时不可用')
  }
  const outerRaw = body.output && typeof body.output === 'object' ? (body.output as Record<string, unknown>).output : undefined
  const inner = outerRaw && typeof outerRaw === 'object' ? (outerRaw as Record<string, unknown>) : {}
  const sentence = inner.sentence && typeof inner.sentence === 'object' ? (inner.sentence as Record<string, unknown>) : {}
  const text = (typeof inner.text === 'string' ? inner.text : typeof sentence.text === 'string' ? sentence.text : '').trim()
  if (!text) throw new GatewayTranscriptionError(422, '没有识别到清晰语音，请重新录制')
  if (format === 'json') return { text }
  const rawWords = Array.isArray(sentence.words) ? sentence.words : []
  const segments: GatewayTranscriptionSegment[] = []
  for (const item of rawWords) {
    if (!item || typeof item !== 'object') continue
    const word = item as Record<string, unknown>
    const start = Number(word.begin_time) / 1000
    const end = Number(word.end_time) / 1000
    const wordText = typeof word.text === 'string' ? word.text.trim() : ''
    if (!wordText || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue
    segments.push({ id: segments.length, start, end, text: wordText })
  }
  if (!segments.length) throw new GatewayTranscriptionError(502, '语音识别未返回时间戳')
  return { text, language: 'zh', duration: segments[segments.length - 1]!.end, segments }
}

export function createFunAsrTranscriber(
  env: Env,
  fetchImpl: FetchLike = fetch,
  credentials: GatewayProviderCredentials = loadGatewayProviderCredentials(env),
): GatewayTranscriber | null {
  const authorization = credentials.bearerAuthorization('funasr')
  if (!authorization) return null
  const endpoint = credentials.baseUrl('funasr')
  const model = env.GW_FUNASR_MODEL?.trim() || DEFAULT_FUNASR_MODEL
  const timeoutMs = positiveInt(env.GW_TRANSCRIBE_TIMEOUT_MS, 5 * 60_000)
  return async (file, opts) => {
    const format = funAsrFormat(file)
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    const requestBody = {
      model,
      input: { messages: [{ role: 'user', content: [{ audio: `data:audio/${format};base64,${base64}` }] }] },
      parameters: {
        format,
        asr_options: { enable_words: opts.responseFormat === 'verbose_json', language: opts.language || 'zh' },
      },
    }
    const wireBody = JSON.stringify(requestBody)
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      await opts.assertCurrent?.()
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: wireBody,
        signal: controller.signal,
      })
      const responseText = await response.text()
      if (responseText.length > 10 * 1024 * 1024) throw new GatewayTranscriptionError(502, '语音识别响应过大')
      let body: unknown = {}
      try { body = JSON.parse(responseText) as unknown } catch { /* code 分支/无效结果在下面处理 */ }
      if (!response.ok && response.status === 413) throw new GatewayTranscriptionError(413, '音频文件过大')
      // Fun-ASR 出错时也常用 200 + code；非 2xx 也交给 parse 从 code 提取语义。
      return parseFunAsrResult(body, opts.responseFormat)
    } catch (error) {
      if (error instanceof GatewayTranscriptionError) throw error
      if (opts.signal?.aborted) throw new GatewayTranscriptionError(499, '转写已取消')
      if (controller.signal.aborted) throw new GatewayTranscriptionError(504, '语音识别超时，请稍后重试')
      throw new GatewayTranscriptionError(502, '语音识别服务暂时不可用')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function createGatewayTranscriber(
  env: Env,
  credentials: GatewayProviderCredentials = loadGatewayProviderCredentials(env),
): GatewayTranscriber | null {
  const provider = env.GW_TRANSCRIBE_PROVIDER?.trim().toLowerCase()
  if (provider && provider !== 'funasr' && provider !== 'fun-asr') return null
  return createFunAsrTranscriber(env, fetch, credentials)
}
