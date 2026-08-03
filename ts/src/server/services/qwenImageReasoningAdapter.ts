import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
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
): Promise<QwenImageReasoningResponse> {
  const request = imageVisualReasoningRequestSchema.parse(raw)
  const env = options.env ?? process.env
  const productTarget = env === process.env ? productGatewayTarget() : null
  const baseUrl = productTarget?.baseUrl ?? env.BB_GATEWAY_URL?.trim() ?? ''
  const token = productTarget?.token ?? env.BB_GATEWAY_TOKEN?.trim() ?? ''
  if (!baseUrl || !token) throw new QwenImageReasoningError('Qwen 图片理解服务未配置', 503, 'GATEWAY_NOT_CONFIGURED')
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/v1/media/reasoning`, {
      method: 'POST', signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        'X-BB-Operation-ID': options.operationId,
      },
      body: JSON.stringify(request),
    })
  } catch {
    if (options.signal?.aborted) throw new QwenImageReasoningError('Qwen 图片理解已取消', 499, 'IMAGE_QWEN_CANCELLED')
    throw new QwenImageReasoningError('无法连接 Qwen 图片理解服务')
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new QwenImageReasoningError('Qwen 图片理解响应超过资源上限', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new QwenImageReasoningError('Qwen 图片理解返回无效 JSON', 502, 'IMAGE_QWEN_RESPONSE_INVALID') }
  if (!response.ok) throw new QwenImageReasoningError('Qwen 图片理解服务暂时不可用', response.status, 'IMAGE_QWEN_UNAVAILABLE')
  const parsed = imageVisualReasoningResponseSchema.safeParse(value)
  if (!parsed.success || parsed.data.application_role !== request.application_role) {
    throw new QwenImageReasoningError('Qwen 图片理解响应不符合合同', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
  }
  return parsed.data
}
