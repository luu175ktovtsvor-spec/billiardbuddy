import { createHash } from 'node:crypto'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
  PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER,
  PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER,
  PROVIDER_OPERATION_RESULT_ID_HEADER,
  PROVIDER_IMAGE_ADVICE_RESULT_PATH,
} from '../../../shared/product/providerGateway.js'
import {
  imageVisualReasoningRequestSchema,
  imageVisualReasoningResponseSchema,
  type ImageVisualReasoningRequest,
  type ImageVisualReasoningResponse,
} from '../../../shared/product/imageVisualReasoning.js'
import { productGatewayTarget } from '../product/productGatewayRuntime.js'

const MAX_RESPONSE_BYTES = 64 * 1024
export type QwenImageReasoningRequest = ImageVisualReasoningRequest
export type QwenImageReasoningResponse = ImageVisualReasoningResponse
export type QwenImageReasoningResult = {
  response: ImageVisualReasoningResponse
  gateway_result: {
    operation_id: string
    capability: 'ImageAdvice'
    fingerprint: string
  }
}
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class QwenImageReasoningError extends Error {
  constructor(message: string, readonly status = 503, readonly code = 'IMAGE_QWEN_UNAVAILABLE') {
    super(message)
    this.name = 'QwenImageReasoningError'
  }
}

/**
 * The Image Module only sends a bounded, schema-locked evidence envelope to
 * Gateway. It cannot select a model, inject a provider prompt, or learn keys.
 */
export async function requestQwenImageReasoning(
  raw: QwenImageReasoningRequest,
  options: { operationId: string; signal?: AbortSignal; fetchImpl?: FetchLike; env?: Record<string, string | undefined> },
): Promise<QwenImageReasoningResult> {
  const request = imageVisualReasoningRequestSchema.parse(raw)
  const env = options.env ?? process.env
  const productTarget = env === process.env ? productGatewayTarget() : null
  const baseUrl = productTarget?.baseUrl ?? env.BB_GATEWAY_URL?.trim() ?? ''
  const token = productTarget?.token ?? env.BB_GATEWAY_TOKEN?.trim() ?? ''
  if (!baseUrl || !token) throw new QwenImageReasoningError('Qwen 图片理解服务未配置', 503, 'GATEWAY_NOT_CONFIGURED')
  let response: Response
  const body = JSON.stringify(request)
  const fingerprint = createHash('sha256').update(`ImageAdvice\0${body}`).digest('hex')
  const parseBody = async (candidate: Response): Promise<unknown> => {
    const bytes = await candidate.arrayBuffer()
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new QwenImageReasoningError('Qwen 图片理解响应超过资源上限', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
    try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new QwenImageReasoningError('Qwen 图片理解返回无效 JSON', 502, 'IMAGE_QWEN_RESPONSE_INVALID') }
  }
  const responseHeaders = (candidate: Response): { operationId: string; capability: string; fingerprint: string } => ({
    operationId: candidate.headers.get(PROVIDER_OPERATION_RESULT_ID_HEADER)?.trim() ?? '',
    capability: candidate.headers.get(PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER)?.trim() ?? '',
    fingerprint: candidate.headers.get(PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER)?.trim() ?? '',
  })
  const parseSuccess = (candidate: Response, value: unknown): QwenImageReasoningResult => {
    const parsed = imageVisualReasoningResponseSchema.safeParse(value)
    if (!parsed.success || parsed.data.application_role !== request.application_role) {
      throw new QwenImageReasoningError('Qwen 图片理解响应不符合合同', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
    }
    const headers = responseHeaders(candidate)
    if (headers.operationId !== options.operationId || headers.capability !== 'ImageAdvice' || headers.fingerprint !== fingerprint) {
      throw new QwenImageReasoningError('Qwen 图片理解缺少可确认回执', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
    }
    return { response: parsed.data, gateway_result: { operation_id: headers.operationId, capability: 'ImageAdvice', fingerprint: headers.fingerprint } }
  }
  const recoverReadOnly = async (initial: Response, initialValue: unknown): Promise<Response> => {
    const initialCode = typeof initialValue === 'object' && initialValue !== null && !Array.isArray(initialValue)
      ? String((initialValue as { error?: unknown }).error ?? '')
      : ''
    if (initial.status !== 409 || (initialCode !== 'OPERATION_IN_PROGRESS' && initialCode !== 'OPERATION_OUTCOME_UNKNOWN')) return initial
    let recovery: Response
    try {
      recovery = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}${PROVIDER_IMAGE_ADVICE_RESULT_PATH}`, {
        method: 'GET', signal: options.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
          [PROVIDER_OPERATION_RESULT_ID_HEADER]: options.operationId,
          [PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER]: 'ImageAdvice',
          [PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER]: fingerprint,
        },
      })
    } catch {
      if (options.signal?.aborted) throw new QwenImageReasoningError('Qwen 图片理解已取消', 499, 'IMAGE_QWEN_CANCELLED')
      throw new QwenImageReasoningError('无法查询 Qwen 图片理解结果')
    }
    if (recovery.status === 409) {
      const recoveryValue = await parseBody(recovery)
      const code = typeof recoveryValue === 'object' && recoveryValue !== null && !Array.isArray(recoveryValue)
        ? String((recoveryValue as { error?: unknown }).error ?? '')
        : ''
      if (code === 'OPERATION_IN_PROGRESS') throw new QwenImageReasoningError('Qwen 图片理解仍在处理中，请稍后刷新结果', 409, 'IMAGE_QWEN_IN_PROGRESS')
      if (code === 'OPERATION_OUTCOME_UNKNOWN') throw new QwenImageReasoningError('Qwen 图片理解结果未知，已阻止重复扣费请求', 409, 'IMAGE_QWEN_OUTCOME_UNKNOWN')
    }
    if (!recovery.ok) {
      if (recovery.status === 404) throw new QwenImageReasoningError('Qwen 图片理解结果尚未可恢复，请稍后刷新', 409, 'IMAGE_QWEN_IN_PROGRESS')
      throw new QwenImageReasoningError('无法查询 Qwen 图片理解结果', recovery.status, 'IMAGE_QWEN_UNAVAILABLE')
    }
    return recovery
  }
  try {
    // Image advice is its own bounded capability.  It must never share the
    // generic media-reasoning endpoint: doing so lets an image-only contract
    // select or perturb MiMo's unrelated media route.
    response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/v1/image/reasoning`, {
      method: 'POST', signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        'X-BB-Operation-ID': options.operationId,
      },
      body,
    })
  } catch {
    if (options.signal?.aborted) throw new QwenImageReasoningError('Qwen 图片理解已取消', 499, 'IMAGE_QWEN_CANCELLED')
    throw new QwenImageReasoningError('无法连接 Qwen 图片理解服务')
  }
  const value = await parseBody(response)
  const recovered = await recoverReadOnly(response, value)
  if (!recovered.ok) throw new QwenImageReasoningError('Qwen 图片理解服务暂时不可用', recovered.status, 'IMAGE_QWEN_UNAVAILABLE')
  const recoveredValue = recovered === response ? value : await parseBody(recovered)
  return parseSuccess(recovered, recoveredValue)
}
