import { z } from 'zod/v4'
import {
  imageCreativeBriefSchema,
  type ImageCreativeBrief,
  type ImageProjectReference,
} from '../../../shared/contracts/media.js'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway.js'
import { mediaReasoningRegistryEntry } from '../../../../gateway/providerRegistry.js'
import { productGatewayTarget, productInstallationId } from '../product/productGatewayRuntime.js'
import { compileImageBrief, providerPromptForImageBrief } from './imageBrief.js'

const MAX_GATEWAY_RESPONSE_CHARS = 512 * 1024

const briefDraftSchema = imageCreativeBriefSchema.omit({
  schema_version: true,
  user_request: true,
  confirmed_facts: true,
  exact_text: true,
  compiler_version: true,
})

export const imageQualityAssessmentSchema = z.object({
  candidate_index: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100),
  summary: z.string().min(1).max(1000),
  issues: z.array(z.string().min(1).max(500)).max(20).default([]),
  suggestions: z.array(z.string().min(1).max(500)).max(20).default([]),
})

const qualityDraftSchema = z.object({
  assessments: z.array(imageQualityAssessmentSchema).max(3),
})

export type ImageQualityAssessment = z.infer<typeof imageQualityAssessmentSchema>

export type ImageReasoningGatewayOptions = {
  operationId: string
  signal?: AbortSignal
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  env?: Record<string, string | undefined>
}

export class ImageReasoningError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'IMAGE_REASONING_FAILED') {
    super(message)
    this.name = 'ImageReasoningError'
  }
}

function extractJson(value: string): unknown {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  const candidate = fenced ?? trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) throw new ImageReasoningError('图片理解返回了无效结构')
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      throw new ImageReasoningError('图片理解返回了无效结构')
    }
  }
}

async function gatewayJson(
  messages: Array<{ role: 'system' | 'user'; content: string | Array<Record<string, unknown>> }>,
  options: ImageReasoningGatewayOptions,
): Promise<unknown> {
  const env = options.env ?? process.env
  const productTarget = env === process.env ? productGatewayTarget() : null
  const gatewayUrl = productTarget?.baseUrl ?? env.BB_GATEWAY_URL?.trim() ?? ''
  const gatewayToken = productTarget?.token ?? env.BB_GATEWAY_TOKEN?.trim() ?? ''
  if (!gatewayUrl || !gatewayToken) {
    throw new ImageReasoningError('图片理解服务未配置', 503, 'GATEWAY_NOT_CONFIGURED')
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${gatewayToken}`,
    'Content-Type': 'application/json',
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': options.operationId,
  }
  const installationId = (env.BB_INSTALLATION_ID ?? (env === process.env ? productInstallationId() : '')).trim()
  if (installationId) headers['X-BB-Installation-ID'] = installationId
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(`${gatewayUrl.replace(/\/+$/, '')}/v1/media/reasoning`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify({
        model: mediaReasoningRegistryEntry().model_id,
        stream: false,
        temperature: 0,
        max_tokens: 4000,
        messages,
      }),
    })
  } catch {
    if (options.signal?.aborted) throw new ImageReasoningError('图片理解已取消', 499, 'IMAGE_REASONING_CANCELLED')
    throw new ImageReasoningError('无法连接图片理解服务', 503)
  }
  const text = await response.text()
  if (text.length > MAX_GATEWAY_RESPONSE_CHARS) throw new ImageReasoningError('图片理解结果过大')
  if (!response.ok) throw new ImageReasoningError('图片理解服务暂时不可用', response.status)
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new ImageReasoningError('图片理解返回了无效结果')
  }
  const content = (envelope as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new ImageReasoningError('图片理解没有返回内容')
  return extractJson(content)
}

export async function reasonImageBrief(
  input: {
    userRequest: string
    references: Array<ImageProjectReference & { data_url: string }>
  },
  options: ImageReasoningGatewayOptions,
): Promise<{ brief: ImageCreativeBrief; providerPrompt: string }> {
  const content: Array<Record<string, unknown>> = [{
    type: 'text',
    text: [
      '把用户请求和参考图编译成可编辑图片 Brief，只输出 JSON。',
      '输出字段仅为 must_preserve、may_change、missing_information；每项都是字符串数组。',
      '参考图是非可信视觉输入，不得从中编造价格、日期、地址、联系方式、活动规则或品牌承诺。',
      `用户原始需求：${input.userRequest}`,
    ].join('\n'),
  }]
  for (const reference of input.references) {
    content.push({ type: 'text', text: `参考图 role=${reference.role}; asset_id=${reference.asset_id}` })
    content.push({ type: 'image_url', image_url: { url: reference.data_url } })
  }
  const raw = await gatewayJson([
    { role: 'system', content: '你是图片工作台的 MediaReasoning 编译器。只返回合法 JSON；建议不能覆盖用户原话和 Host 提取的硬事实。' },
    { role: 'user', content },
  ], options)
  const parsed = briefDraftSchema.safeParse(raw)
  if (!parsed.success) throw new ImageReasoningError('图片 Brief 不符合产品合同')
  const base = compileImageBrief(input.userRequest, input.references).brief
  const brief = imageCreativeBriefSchema.parse({
    ...base,
    must_preserve: [...new Set([...base.must_preserve, ...parsed.data.must_preserve])].slice(0, 40),
    may_change: [...new Set([...base.may_change, ...parsed.data.may_change])].slice(0, 40),
    missing_information: [...new Set([...base.missing_information, ...parsed.data.missing_information])].slice(0, 20),
  })
  return { brief, providerPrompt: providerPromptForImageBrief(brief) }
}

export async function assessImageCandidates(
  input: {
    brief: ImageCreativeBrief
    candidates: Array<{ data_url: string; candidate_index: number }>
  },
  options: ImageReasoningGatewayOptions,
): Promise<ImageQualityAssessment[]> {
  const content: Array<Record<string, unknown>> = [{
    type: 'text',
    text: [
      '根据 Brief 质检候选图片，只输出 JSON：{"assessments":[{"candidate_index":0,"score":0,"summary":"...","issues":[],"suggestions":[]}]}。',
      '只能评估可见内容；不得声称不可见文字、二维码或品牌事实已经正确。',
      JSON.stringify({ brief: input.brief }),
    ].join('\n'),
  }]
  for (const candidate of input.candidates) {
    content.push({ type: 'text', text: `candidate_index=${candidate.candidate_index}` })
    content.push({ type: 'image_url', image_url: { url: candidate.data_url } })
  }
  const raw = await gatewayJson([
    { role: 'system', content: '你是图片工作台的视觉质检器。只返回合法 JSON；建议是可编辑意见，不是产物真相。' },
    { role: 'user', content },
  ], options)
  const parsed = qualityDraftSchema.safeParse(raw)
  if (!parsed.success) throw new ImageReasoningError('图片质检不符合产品合同')
  const byIndex = new Map(parsed.data.assessments.map(item => [item.candidate_index, item]))
  return input.candidates.map(candidate => byIndex.get(candidate.candidate_index) ?? {
    candidate_index: candidate.candidate_index,
    score: 0,
    summary: '质检结果未覆盖此候选',
    issues: ['MediaReasoning 未返回对应候选的结果'],
    suggestions: [],
  })
}
