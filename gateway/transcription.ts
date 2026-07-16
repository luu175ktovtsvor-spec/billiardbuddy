import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { spawn } from 'node:child_process'

type Env = Record<string, string | undefined>

export interface GatewayTranscriptionOptions {
  language: string
  responseFormat: 'json' | 'verbose_json'
  signal?: AbortSignal
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

interface WhisperSegment {
  offsets?: { from?: unknown; to?: unknown }
  text?: unknown
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

function trimProcessOutput(value: string): string {
  return value.length > 16_000 ? value.slice(-16_000) : value
}

function runProcess(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  if (opts.signal?.aborted) return Promise.reject(new GatewayTranscriptionError(499, '转写已取消'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(() => reject(new GatewayTranscriptionError(499, '转写已取消')))
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new GatewayTranscriptionError(504, '语音识别超时，请稍后重试')))
    }, opts.timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout = trimProcessOutput(stdout + String(chunk)) })
    child.stderr?.on('data', chunk => { stderr = trimProcessOutput(stderr + String(chunk)) })
    child.on('error', () => finish(() => reject(new GatewayTranscriptionError(503, '语音识别服务暂不可用'))))
    child.on('close', code => finish(() => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new GatewayTranscriptionError(502, '语音识别失败，请稍后重试'))
    }))
  })
}

export function parseWhisperJson(raw: unknown, language: string): GatewayTranscriptionResult {
  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const transcription = Array.isArray(root.transcription) ? root.transcription : []
  const segments: GatewayTranscriptionSegment[] = []
  for (const item of transcription) {
    if (!item || typeof item !== 'object') continue
    const segment = item as WhisperSegment
    const from = Number(segment.offsets?.from)
    const to = Number(segment.offsets?.to)
    const text = typeof segment.text === 'string' ? segment.text.trim() : ''
    if (!text || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    segments.push({ id: segments.length, start: from / 1000, end: to / 1000, text })
  }
  const text = segments.map(segment => segment.text).join(' ')
    .replace(/([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '$1')
    .trim()
  if (!text) throw new GatewayTranscriptionError(422, '没有识别到清晰语音，请重新录制')
  return {
    text,
    language,
    duration: segments.length ? segments[segments.length - 1]!.end : 0,
    segments,
  }
}

export function createWhisperTranscriber(env: Env): GatewayTranscriber | null {
  const whisperBin = env.GW_TRANSCRIBE_BIN?.trim() ?? ''
  const model = env.GW_TRANSCRIBE_MODEL?.trim() ?? ''
  const ffmpeg = env.GW_FFMPEG_BIN?.trim() || '/usr/bin/ffmpeg'
  if (!whisperBin || !model || !existsSync(whisperBin) || !existsSync(model) || !existsSync(ffmpeg)) return null
  const root = env.GW_TRANSCRIBE_TMP?.trim() || join(tmpdir(), 'qfgw-transcribe')
  const timeoutMs = positiveInt(env.GW_TRANSCRIBE_TIMEOUT_MS, 15 * 60_000)
  const threads = positiveInt(env.GW_TRANSCRIBE_THREADS, 2)

  return async (file, opts) => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const workDir = await mkdtemp(join(root, 'job-'))
    try {
      const input = join(workDir, `input${inputSuffix(file)}`)
      const wav = join(workDir, 'audio.wav')
      const outputBase = join(workDir, 'transcript')
      await writeFile(input, Buffer.from(await file.arrayBuffer()), { mode: 0o600 })
      await runProcess(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
      ], { cwd: workDir, timeoutMs: Math.min(timeoutMs, 5 * 60_000), signal: opts.signal })
      await runProcess(whisperBin, [
        '-m', model, '-f', wav, '-l', opts.language, '-t', String(threads), '-oj', '-of', outputBase,
      ], { cwd: workDir, timeoutMs, signal: opts.signal })
      const parsed = JSON.parse(await readFile(`${outputBase}.json`, 'utf8')) as unknown
      const result = parseWhisperJson(parsed, opts.language)
      return opts.responseFormat === 'verbose_json' ? result : { text: result.text }
    } catch (error) {
      if (error instanceof GatewayTranscriptionError) throw error
      throw new GatewayTranscriptionError(502, '语音识别失败，请稍后重试')
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function parseUpstreamResult(raw: unknown, format: 'json' | 'verbose_json'): GatewayTranscriptionResult {
  if (!raw || typeof raw !== 'object') throw new GatewayTranscriptionError(502, '语音识别上游返回了无效结果')
  const body = raw as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new GatewayTranscriptionError(422, '没有识别到清晰语音，请重新录制')
  if (format === 'json') return { text }
  const rawSegments = Array.isArray(body.segments) ? body.segments : []
  const segments: GatewayTranscriptionSegment[] = []
  for (const item of rawSegments) {
    if (!item || typeof item !== 'object') continue
    const segment = item as Record<string, unknown>
    const start = Number(segment.start)
    const end = Number(segment.end)
    const segmentText = typeof segment.text === 'string' ? segment.text.trim() : ''
    if (!segmentText || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue
    segments.push({ id: segments.length, start, end, text: segmentText })
  }
  if (!segments.length) throw new GatewayTranscriptionError(502, '语音识别上游未返回时间戳')
  const language = typeof body.language === 'string' && body.language.trim() ? body.language.trim() : 'zh'
  const duration = Number(body.duration)
  return {
    text,
    language,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : segments[segments.length - 1]!.end,
    segments,
  }
}

export function createUpstreamTranscriber(env: Env, fetchImpl: FetchLike = fetch): GatewayTranscriber | null {
  const endpoint = env.GW_TRANSCRIBE_UPSTREAM_URL?.trim() ?? ''
  if (!/^https?:\/\//i.test(endpoint)) return null
  const token = env.GW_TRANSCRIBE_UPSTREAM_TOKEN?.trim() ?? ''
  const timeoutMs = positiveInt(env.GW_TRANSCRIBE_TIMEOUT_MS, 15 * 60_000)
  return async (file, opts) => {
    const form = new FormData()
    form.set('file', file)
    form.set('language', opts.language)
    form.set('response_format', opts.responseFormat)
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
        signal: controller.signal,
      })
      const declaredSize = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declaredSize) && declaredSize > 10 * 1024 * 1024) {
        throw new GatewayTranscriptionError(502, '语音识别上游响应过大')
      }
      const responseText = await response.text()
      if (responseText.length > 10 * 1024 * 1024) throw new GatewayTranscriptionError(502, '语音识别上游响应过大')
      let body: unknown = {}
      try { body = JSON.parse(responseText) as unknown } catch { /* handled below */ }
      if (!response.ok) {
        if (response.status === 413) throw new GatewayTranscriptionError(413, '音频文件过大')
        if (response.status === 422) throw new GatewayTranscriptionError(422, '没有识别到清晰语音，请重新录制')
        if (response.status === 429) throw new GatewayTranscriptionError(429, '语音识别服务繁忙，请稍后重试')
        throw new GatewayTranscriptionError(502, '语音识别上游暂时不可用')
      }
      return parseUpstreamResult(body, opts.responseFormat)
    } catch (error) {
      if (error instanceof GatewayTranscriptionError) throw error
      if (opts.signal?.aborted) throw new GatewayTranscriptionError(499, '转写已取消')
      if (controller.signal.aborted) throw new GatewayTranscriptionError(504, '语音识别超时，请稍后重试')
      throw new GatewayTranscriptionError(502, '语音识别上游暂时不可用')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }
}

// 阿里百炼 Fun-ASR：DashScope 多模态生成端点,同步一次返回文字 + 词级时间戳。
const FUNASR_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
const DEFAULT_FUNASR_MODEL = 'fun-asr-flash-2026-06-15'

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

export function createFunAsrTranscriber(env: Env, fetchImpl: FetchLike = fetch): GatewayTranscriber | null {
  const key = env.GW_FUNASR_KEY?.trim() ?? ''
  if (!key) return null
  const endpoint = env.GW_FUNASR_URL?.trim() || FUNASR_ENDPOINT
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
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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

export function createGatewayTranscriber(env: Env): GatewayTranscriber | null {
  const provider = env.GW_TRANSCRIBE_PROVIDER?.trim().toLowerCase() || 'whisper'
  if (provider === 'whisper') return createWhisperTranscriber(env)
  if (provider === 'upstream') return createUpstreamTranscriber(env)
  if (provider === 'funasr' || provider === 'fun-asr') return createFunAsrTranscriber(env)
  return null
}
