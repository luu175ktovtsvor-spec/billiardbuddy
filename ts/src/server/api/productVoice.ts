/**
 * Product voice transcription API
 *
 * POST /api/product/voice/transcribe — transcribe a composer recording.
 * The gateway and transcription service remain private implementation details.
 */

import {
  voiceErrorResponseSchema,
  voiceTranscriptionResponseSchema,
} from '../../../shared/contracts/voice.js'
import {
  VoiceTranscriptionError,
  transcribeVoiceFile,
  type VoiceTranscriptionOptions,
} from '../services/voiceTranscription.js'

const DEFAULT_MAX_AUDIO_BYTES = 96 * 1024 * 1024

type ProductVoiceApiDependencies = Pick<VoiceTranscriptionOptions, 'env' | 'fetchImpl'> & {
  transcribe?: typeof transcribeVoiceFile
}

const PRODUCT_VOICE_FALLBACK_ERROR = '语音转写暂时无法完成，请稍后重试。'

function detailResponse(detail: string, status: number): Response {
  return Response.json(voiceErrorResponseSchema.parse({ detail }), { status })
}

function maxAudioBytes(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.QF_TRANSCRIBE_MAX_BYTES ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AUDIO_BYTES
}

export async function handleProductVoiceApi(
  req: Request,
  segments: string[],
  deps: ProductVoiceApiDependencies = {},
): Promise<Response> {
  const action = segments[3]
  if (action !== 'transcribe' || segments[4]) {
    return detailResponse('当前语音操作不可用', 404)
  }
  if (req.method !== 'POST') {
    return detailResponse('当前语音操作暂不支持', 405)
  }

  const env = deps.env ?? process.env
  const maxBytes = maxAudioBytes(env)
  const declaredBytes = Number.parseInt(req.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes + 1024 * 1024) {
    return detailResponse('录音文件过大', 413)
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return detailResponse('请先录制一段音频', 400)

  if (file.size > maxBytes) {
    return detailResponse('录音文件过大', 413)
  }

  const languageValue = form?.get('language')
  const language = typeof languageValue === 'string' && languageValue.trim()
    ? languageValue.trim().slice(0, 16)
    : undefined

  try {
    const result = await (deps.transcribe ?? transcribeVoiceFile)(file, {
      env,
      fetchImpl: deps.fetchImpl,
      language,
      signal: req.signal,
    })
    return Response.json(voiceTranscriptionResponseSchema.parse(result))
  } catch (error) {
    const status = error instanceof VoiceTranscriptionError ? error.status : 500
    return detailResponse(productVoiceErrorDetail(error), status)
  }
}

function productVoiceErrorDetail(error: unknown): string {
  if (!(error instanceof VoiceTranscriptionError)) return PRODUCT_VOICE_FALLBACK_ERROR

  if (error.status === 400) return '没有录到声音，请重新录一次'
  if (error.status === 413) return '录音文件过大，请缩短后重试。'
  if (error.status === 499) return '语音转写已取消'
  return PRODUCT_VOICE_FALLBACK_ERROR
}
