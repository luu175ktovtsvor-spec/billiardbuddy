import {
  voiceErrorResponseSchema,
  voiceTranscriptionResponseSchema,
  type VoiceTranscriptionResponse,
} from '../../shared/contracts/voice.js'

export type RemoteTranscriptionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type RemoteTranscriptionConfig = {
  endpoint: string
  token: string
  clientId?: string
}

export class RemoteTranscriptionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'RemoteTranscriptionError'
  }
}

export type RemoteTranscriptionOptions = {
  env?: Record<string, string | undefined>
  language?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: RemoteTranscriptionFetch
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function resolveRemoteTranscriptionConfig(
  env: Record<string, string | undefined>,
): RemoteTranscriptionConfig | null {
  const base = nonEmpty(env.QF_GATEWAY_URL)
  const token = nonEmpty(env.QF_GATEWAY_TOKEN)
  if (!base || !token) return null

  let url: URL
  try {
    url = new URL(base)
  } catch {
    return null
  }
  // Audio and the revocable app token must never travel over a public clear-text
  // gateway connection. The managed desktop validates the same rule at startup.
  if (url.protocol !== 'https:') return null

  const normalized = url.toString().replace(/\/+$/, '')
  const endpoint = /\/audio\/transcriptions$/i.test(normalized)
    ? normalized
    : /\/v1$/i.test(normalized)
      ? `${normalized}/audio/transcriptions`
      : `${normalized}/v1/audio/transcriptions`
  const clientId = nonEmpty(env.BB_INSTALLATION_ID) ?? undefined
  return { endpoint, token, ...(clientId ? { clientId } : {}) }
}

function combineSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
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

export async function transcribeRemoteFile(
  file: File,
  opts: RemoteTranscriptionOptions = {},
): Promise<VoiceTranscriptionResponse> {
  const env = opts.env ?? process.env
  const config = resolveRemoteTranscriptionConfig(env)
  if (!config) throw new RemoteTranscriptionError('语音识别服务器未配置', 503)
  if (!file.size) throw new RemoteTranscriptionError('没有收到音频内容', 400)

  const form = new FormData()
  form.set('file', file)
  form.set('language', opts.language || env.QF_TRANSCRIBE_LANGUAGE || 'zh')
  form.set('response_format', 'json')
  const combined = combineSignal(opts.signal, opts.timeoutMs ?? 10 * 60_000)

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
    }
    if (config.clientId) headers['X-QF-Client-ID'] = config.clientId

    const response = await (opts.fetchImpl ?? fetch)(config.endpoint, {
      method: 'POST',
      headers,
      body: form,
      signal: combined.signal,
    })
    const body: unknown = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = voiceErrorResponseSchema.safeParse(body)
      throw new RemoteTranscriptionError(
        error.success ? error.data.detail : '语音识别服务暂时不可用',
        response.status,
      )
    }
    const parsed = voiceTranscriptionResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new RemoteTranscriptionError('语音识别服务返回了无效结果', 502)
    }
    return parsed.data
  } catch (error) {
    if (error instanceof RemoteTranscriptionError) throw error
    if (opts.signal?.aborted) throw new RemoteTranscriptionError('语音识别已取消', 499)
    if (combined.signal.aborted) {
      throw new RemoteTranscriptionError('语音识别超时，请稍后重试', 504)
    }
    throw new RemoteTranscriptionError('无法连接语音识别服务，请稍后重试', 503)
  } finally {
    combined.dispose()
  }
}
