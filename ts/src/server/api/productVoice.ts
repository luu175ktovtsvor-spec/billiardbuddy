/**
 * Product voice transcription API
 *
 * POST /api/product/voice/transcribe — transcribe a composer recording.
 * The gateway and transcription service remain private implementation details.
 */

import {
  bindTranscriptInputSchema,
  createTranscriptRevisionInputSchema,
  productVoiceTranscriptionResponseSchema,
  voiceConsumerSchema,
} from '../../../shared/contracts/voice.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  VoiceTranscriptionError,
  transcribeVoiceFile,
  type VoiceTranscriptionOptions,
} from '../services/voiceTranscription.js'
import { remoteDataEgressConsentService } from '../services/remoteDataEgressConsent.js'
import { PROVIDER_GATEWAY_PROTOCOL } from '../../../shared/product/dataEgress.js'
import {
  VoiceOperationError,
  voiceOperationService,
  type VoiceOperationService,
} from '../services/voiceOperationService.js'

const DEFAULT_MAX_AUDIO_BYTES = 96 * 1024 * 1024

type ProductVoiceApiDependencies = Pick<VoiceTranscriptionOptions, 'env' | 'fetchImpl'> & {
  transcribe?: typeof transcribeVoiceFile
  consentReceiptId?: string | null
  operations?: Pick<
    VoiceOperationService,
    'begin' | 'complete' | 'fail' | 'cancel' | 'getOperation' | 'getTranscript' | 'revise' | 'bind' | 'listBound'
  >
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
  if (error instanceof VoiceOperationError) return new ApiError(error.status, error.message, error.code)
  if (requestAborted) return transcriptionCancelledError()
  if (!(error instanceof VoiceTranscriptionError)) return transcriptionUnavailableError()
  if (error.status === 400) return invalidAudioError()
  if (error.status === 413) return audioTooLargeError()
  if (error.status === 499) return transcriptionCancelledError()
  return transcriptionUnavailableError()
}

async function readJson(req: Request): Promise<unknown> {
  return await req.json().catch(() => {
    throw new ApiError(400, '语音操作参数无效', 'VOICE_OPERATION_INVALID')
  })
}

export async function handleProductVoiceApi(
  req: Request,
  segments: string[],
  deps: ProductVoiceApiDependencies = {},
): Promise<Response> {
  try {
    const action = segments[3]
    const operations = deps.operations ?? voiceOperationService

    if (action === 'operations') {
      const operationId = segments[4]
      if (!operationId || segments[6]) throw ApiError.notFound('当前语音操作不可用')
      if (!segments[5] && req.method === 'GET') {
        return Response.json({ operation: await operations.getOperation(operationId) })
      }
      if (segments[5] === 'cancel' && req.method === 'POST') {
        return Response.json({ operation: await operations.cancel(operationId) })
      }
      throw new ApiError(405, '当前语音操作暂不支持', 'METHOD_NOT_ALLOWED')
    }

    if (action === 'transcripts') {
      const transcriptId = segments[4]
      const nested = segments[5]
      if (!transcriptId || segments[6]) throw ApiError.notFound('当前转写记录不可用')
      if (!nested && req.method === 'GET') {
        return Response.json({ transcript: await operations.getTranscript(transcriptId) })
      }
      if (nested === 'revisions' && req.method === 'POST') {
        const input = createTranscriptRevisionInputSchema.safeParse(await readJson(req))
        if (!input.success) throw new ApiError(400, '转写编辑参数无效', 'TRANSCRIPT_REVISION_INVALID')
        return Response.json({ transcript: await operations.revise(transcriptId, input.data) }, { status: 201 })
      }
      if (nested === 'bindings' && req.method === 'POST') {
        const input = bindTranscriptInputSchema.safeParse(await readJson(req))
        if (!input.success) throw new ApiError(400, '转写绑定参数无效', 'TRANSCRIPT_BINDING_INVALID')
        return Response.json({ transcript: await operations.bind(transcriptId, input.data) }, { status: 201 })
      }
      throw new ApiError(405, '当前转写操作暂不支持', 'METHOD_NOT_ALLOWED')
    }

    if (action === 'bindings') {
      if (segments[4] || req.method !== 'GET') {
        throw new ApiError(405, '当前转写操作暂不支持', 'METHOD_NOT_ALLOWED')
      }
      const url = new URL(req.url)
      const consumer = voiceConsumerSchema.safeParse({
        kind: url.searchParams.get('consumer_kind'),
        id: url.searchParams.get('consumer_id'),
      })
      if (!consumer.success) throw new ApiError(400, '转写绑定查询参数无效', 'TRANSCRIPT_BINDING_INVALID')
      return Response.json({ evidence: await operations.listBound(consumer.data) })
    }

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

    const started = await operations.begin(file, consentReceiptId)
    const onRequestAbort = () => { void operations.cancel(started.operation.id) }
    req.signal.addEventListener('abort', onRequestAbort, { once: true })
    if (req.signal.aborted) onRequestAbort()
    try {
      const result = await (deps.transcribe ?? transcribeVoiceFile)(file, {
        env,
        fetchImpl: deps.fetchImpl,
        language,
        signal: started.signal,
        consentReceiptId,
        providerProtocol: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        operationId: started.operation.id,
      })
      const completed = await operations.complete(started.operation.id, result.text)
      return Response.json(productVoiceTranscriptionResponseSchema.parse({
        text: completed.transcript.revisions.find(revision => revision.id === completed.transcript.raw_revision_id)?.text,
        ...completed,
      }))
    } catch (error) {
      if (req.signal.aborted || started.signal.aborted) {
        await operations.cancel(started.operation.id).catch(() => undefined)
      } else {
        await operations.fail(started.operation.id).catch(() => undefined)
      }
      throw error
    } finally {
      req.signal.removeEventListener('abort', onRequestAbort)
    }
  } catch (error) {
    return errorResponse(productVoiceError(error, req.signal.aborted))
  }
}
