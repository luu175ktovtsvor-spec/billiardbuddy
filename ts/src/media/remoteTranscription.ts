import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  voiceErrorResponseSchema,
  voiceRemoteTranscriptionResponseSchema,
  type VoiceVerboseTranscriptionResponse,
} from '../../shared/contracts/voice'

export type RemoteTranscriptionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RemoteTranscriptionConfig {
  endpoint: string
  token: string
}

export class RemoteTranscriptionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface RemoteTranscriptionOptions {
  env?: Record<string, string | undefined>
  language?: string
  responseFormat?: 'json' | 'verbose_json'
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: RemoteTranscriptionFetch
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function resolveRemoteTranscriptionConfig(env: Record<string, string | undefined>): RemoteTranscriptionConfig | null {
  if (env.QF_TRANSCRIBE_MODE?.trim().toLowerCase() === 'local') return null
  const base = nonEmpty(env.QF_TRANSCRIBE_URL) ?? nonEmpty(env.QF_GATEWAY_URL)
  const token = nonEmpty(env.QF_TRANSCRIBE_TOKEN) ?? nonEmpty(env.QF_GATEWAY_TOKEN)
  if (!base || !token || !/^https?:\/\//i.test(base)) return null
  const normalized = base.replace(/\/+$/, '')
  const endpoint = /\/audio\/transcriptions$/i.test(normalized)
    ? normalized
    : /\/v1$/i.test(normalized)
      ? `${normalized}/audio/transcriptions`
      : `${normalized}/v1/audio/transcriptions`
  return { endpoint, token }
}

export function localTranscriptionRequested(env: Record<string, string | undefined>): boolean {
  if (env.QF_TRANSCRIBE_MODE?.trim().toLowerCase() === 'local') return true
  return [
    env.WHISPER_TRANSCRIBE_COMMAND,
    env.WHISPER_CLI,
    env.WHISPER_CPP_BIN,
    env.WHISPER_MODEL_PATH,
    env.WHISPER_CPP_MODEL,
    env.WHISPER_MODEL_DIR,
  ].some(value => Boolean(value?.trim()))
}

function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

function contentTypeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4'
  return 'audio/webm'
}

export async function transcribeRemoteFile(
  file: File,
  opts: RemoteTranscriptionOptions = {},
): Promise<{ text: string } | VoiceVerboseTranscriptionResponse> {
  const env = opts.env ?? process.env
  const config = resolveRemoteTranscriptionConfig(env)
  if (!config) throw new RemoteTranscriptionError('语音识别服务器未配置', 503)
  if (!file.size) throw new RemoteTranscriptionError('没有收到音频内容', 400)
  const form = new FormData()
  form.set('file', file)
  form.set('language', opts.language || env.WHISPER_LANGUAGE || 'zh')
  form.set('response_format', opts.responseFormat ?? 'json')
  const combined = combineSignal(opts.signal, opts.timeoutMs ?? 30 * 60_000)
  try {
    const response = await (opts.fetchImpl ?? fetch)(config.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
      signal: combined.signal,
    })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = voiceErrorResponseSchema.safeParse(body)
      throw new RemoteTranscriptionError(error.success ? error.data.detail : '语音识别服务暂时不可用', response.status)
    }
    const parsed = voiceRemoteTranscriptionResponseSchema.safeParse(body)
    if (!parsed.success) throw new RemoteTranscriptionError('语音识别服务返回了无效结果', 502)
    return parsed.data
  } catch (error) {
    if (error instanceof RemoteTranscriptionError) throw error
    if (opts.signal?.aborted) throw new RemoteTranscriptionError('语音识别已取消', 499)
    if (combined.signal.aborted) throw new RemoteTranscriptionError('语音识别超时，请稍后重试', 504)
    throw new RemoteTranscriptionError('无法连接语音识别服务，请稍后重试', 503)
  } finally {
    combined.dispose()
  }
}

export async function transcribeRemotePath(
  path: string,
  opts: RemoteTranscriptionOptions = {},
): Promise<{ text: string } | VoiceVerboseTranscriptionResponse> {
  const bytes = await readFile(path)
  const name = basename(path)
  return transcribeRemoteFile(new File([bytes], name, { type: contentTypeFromName(name) }), opts)
}
