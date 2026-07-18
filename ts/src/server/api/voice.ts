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

type VoiceApiDependencies = Pick<VoiceTranscriptionOptions, 'env' | 'fetchImpl'> & {
  transcribe?: typeof transcribeVoiceFile
}

function detailResponse(detail: string, status: number): Response {
  return Response.json(voiceErrorResponseSchema.parse({ detail }), { status })
}

function maxAudioBytes(env: Record<string, string | undefined>): number {
  const parsed = Number.parseInt(env.QF_TRANSCRIBE_MAX_BYTES ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AUDIO_BYTES
}

export async function handleVoiceApi(
  req: Request,
  segments: string[],
  deps: VoiceApiDependencies = {},
): Promise<Response> {
  const action = segments[2]
  if (action !== 'transcribe') {
    return detailResponse(`Unknown voice endpoint: ${action ?? '(root)'}`, 404)
  }
  if (req.method !== 'POST') {
    return detailResponse('Method not allowed', 405)
  }

  const env = deps.env ?? process.env
  const maxBytes = maxAudioBytes(env)
  const declaredBytes = Number.parseInt(req.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes + 1024 * 1024) {
    return detailResponse('录音文件过大', 413)
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) return detailResponse('file required', 400)

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
    const detail = error instanceof VoiceTranscriptionError
      ? error.message
      : '语音转写失败，请重试'
    return detailResponse(detail, status)
  }
}
