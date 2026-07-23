/**
 * Product voice transcription API
 *
 * POST /api/product/voice/transcribe — transcribe a composer recording.
 * The gateway and transcription service remain private implementation details.
 */

import { voiceTranscriptionResponseSchema } from '../../../shared/contracts/voice.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  VoiceTranscriptionError,
  transcribeVoiceFile,
  type VoiceTranscriptionOptions,
} from '../services/voiceTranscription.js'
import { remoteDataEgressConsentService } from '../services/remoteDataEgressConsent.js'
import { PROVIDER_GATEWAY_PROTOCOL } from '../../../shared/product/dataEgress.js'

const DEFAULT_MAX_AUDIO_BYTES = 96 * 1024 * 1024

type ProductVoiceApiDependencies = Pick<VoiceTranscriptionOptions, 'env' | 'fetchImpl'> & {
  transcribe?: typeof transcribeVoiceFile
  consentReceiptId?: string | null
}

function maxAudioBytes(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.QF_TRANSCRIBE_MAX_BYTES ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AUDIO_BYTES
}

function invalidAudioError(): ApiError {
  return new ApiError(
    400,
    '请先录制一段有效音频后重试。',
    'VOICE_TRANSCRIPTION_INVALID_AUDIO',
  )
}

function audioTooLargeError(): ApiError {
  return new ApiError(
    413,
    '录音文件过大，请缩短后重试。',
    'VOICE_TRANSCRIPTION_TOO_LARGE',
  )
}

function transcriptionCancelledError(): ApiError {
  return new ApiError(499, '语音转写已取消。', 'VOICE_TRANSCRIPTION_CANCELLED')
}

function transcriptionUnavailableError(): ApiError {
  return new ApiError(
    503,
    '语音转写暂时不可用，请稍后重试。',
    'VOICE_TRANSCRIPTION_UNAVAILABLE',
  )
}

function productVoiceError(error: unknown, requestAborted: boolean): ApiError {
  if (error instanceof ApiError) return error
  if (requestAborted) return transcriptionCancelledError()
  if (!(error instanceof VoiceTranscriptionError)) return transcriptionUnavailableError()
  if (error.status === 400) return invalidAudioError()
  if (error.status === 413) return audioTooLargeError()
  if (error.status === 499) return transcriptionCancelledError()
  return transcriptionUnavailableError()
}

export async function handleProductVoiceApi(
  req: Request,
  segments: string[],
  deps: ProductVoiceApiDependencies = {},
): Promise<Response> {
  try {
    const action = segments[3]
    if (action !== 'transcribe' || segments[4]) {
      throw ApiError.notFound('当前语音操作不可用')
    }
    if (req.method !== 'POST') {
      throw new ApiError(405, '当前语音操作暂不支持', 'METHOD_NOT_ALLOWED')
    }

    const env = deps.env ?? process.env
    const maxBytes = maxAudioBytes(env)
    const declaredBytes = Number.parseInt(req.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes + 1024 * 1024) {
      throw audioTooLargeError()
    }

    const form = await req.formData().catch(() => {
      throw invalidAudioError()
    })
    const file = form.get('file')
    if (!(file instanceof File) || file.size === 0) throw invalidAudioError()

    if (file.size > maxBytes) throw audioTooLargeError()

    const languageValue = form.get('language')
    const language = typeof languageValue === 'string' && languageValue.trim()
      ? languageValue.trim().slice(0, 16)
      : undefined

    const consentReceiptId = deps.consentReceiptId === undefined
      ? (await remoteDataEgressConsentService.activeReceipt())?.receipt_id ?? null
      : deps.consentReceiptId
    if (!consentReceiptId) {
      throw new ApiError(428, '请先确认远程数据使用范围', 'REMOTE_DATA_EGRESS_REQUIRED')
    }

    const result = await (deps.transcribe ?? transcribeVoiceFile)(file, {
      env,
      fetchImpl: deps.fetchImpl,
      language,
      signal: req.signal,
      consentReceiptId,
      providerProtocol: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    })
    return Response.json(voiceTranscriptionResponseSchema.parse(result))
  } catch (error) {
    return errorResponse(productVoiceError(error, req.signal.aborted))
  }
}
