import { z } from 'zod/v4'
import {
  videoBriefSchema,
  type VideoBrief,
  type VideoEvidence,
  type VideoScene,
  type VideoSource,
} from '../../../shared/contracts/media.js'
import {
  DATA_EGRESS_CONSENT_HEADER,
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
  type RemoteDataEgressReceipt,
} from '../../../shared/product/dataEgress.js'
import {
  getInstallationId,
  getQfGatewayToken,
  getQfGatewayUrl,
  qfGatewayConfigured,
} from './qfGatewayProvider.js'
import { visualEvidenceRegistryEntry } from '../../../../gateway/providerRegistry.js'

const MAX_GATEWAY_RESPONSE_CHARS = 512 * 1024

const evidenceDraftSchema = z.object({
  evidence: z.array(z.object({
    kind: z.enum(['visual', 'audio', 'shot']),
    source_id: z.string().min(1).max(80),
    in_ms: z.number().int().nonnegative(),
    out_ms: z.number().int().positive(),
    text: z.string().min(1).max(8000),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string().min(1).max(500)).max(20).default([]),
  }).refine(value => value.out_ms > value.in_ms)).max(2000),
  gaps: z.array(z.string().min(1).max(500)).max(40).default([]),
})

const sceneDraftSchema = z.object({
  source_id: z.string().min(1).max(80),
  in_ms: z.number().int().nonnegative(),
  out_ms: z.number().int().positive(),
  story_role: z.enum(['hook', 'context', 'action', 'result', 'cta', 'b_roll']),
  evidence_ids: z.array(z.string().min(1).max(80)).min(1).max(100),
  rationale: z.string().min(1).max(1000),
  needs_review: z.boolean().default(false),
}).refine(value => value.out_ms > value.in_ms)
const planDraftSchema = z.object({
  brief: videoBriefSchema.omit({ schema_version: true, user_goal: true, compiler_version: true }),
  scenes: z.array(sceneDraftSchema).min(1).max(500),
  alternatives: z.array(z.object({
    label: z.string().min(1).max(160),
    tradeoff: z.string().min(1).max(1000),
    scenes: z.array(sceneDraftSchema).min(1).max(500),
  })).max(3).default([]),
})

export type VideoEvidenceDraft = z.infer<typeof evidenceDraftSchema>
export type VideoPlanDraft = z.infer<typeof planDraftSchema>

export type VideoAnalysisFrame = {
  source_id: string
  in_ms: number
  data_url: string
}

export type VideoAnalysisGatewayOptions = {
  receipt: RemoteDataEgressReceipt
  operationId: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  env?: Record<string, string | undefined>
}

export class VideoAnalysisError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'VIDEO_ANALYSIS_FAILED',
  ) {
    super(message)
    this.name = 'VideoAnalysisError'
  }
}

function sourceProjection(source: VideoSource) {
  return {
    id: source.id,
    name: source.name,
    fingerprint: source.fingerprint,
    duration_ms: source.duration_ms,
    width: source.width,
    height: source.height,
    fps: source.fps,
    rotation: source.rotation,
    has_audio: source.has_audio,
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
    if (start < 0 || end <= start) throw new VideoAnalysisError('视频分析返回了无效结构')
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      throw new VideoAnalysisError('视频分析返回了无效结构')
    }
  }
}

async function gatewayJson(
  messages: Array<{ role: 'system' | 'user'; content: string | Array<Record<string, unknown>> }>,
  options: VideoAnalysisGatewayOptions,
): Promise<unknown> {
  const env = options.env ?? process.env
  const configured = env === process.env
    ? qfGatewayConfigured()
    : Boolean(env.QF_GATEWAY_URL?.trim() && env.QF_GATEWAY_TOKEN?.trim())
  const gatewayUrl = (env.QF_GATEWAY_URL ?? (env === process.env ? getQfGatewayUrl() : '')).trim()
  const gatewayToken = (env.QF_GATEWAY_TOKEN ?? (env === process.env ? getQfGatewayToken() : '')).trim()
  if (!configured || !gatewayUrl || !gatewayToken) {
    throw new VideoAnalysisError('视频分析服务未配置', 503, 'GATEWAY_NOT_CONFIGURED')
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${gatewayToken}`,
    'Content-Type': 'application/json',
    [DATA_EGRESS_CONSENT_HEADER]: options.receipt.receipt_id,
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': options.operationId,
  }
  const installationId = (env.BB_INSTALLATION_ID ?? (env === process.env ? getInstallationId() : '')).trim()
  if (installationId) headers['X-QF-Client-ID'] = installationId
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(`${gatewayUrl.replace(/\/+$/, '')}/v1/media/reasoning`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify({
        model: visualEvidenceRegistryEntry().model_id,
        stream: false,
        temperature: 0,
        max_tokens: 6000,
        messages,
      }),
    })
  } catch {
    if (options.signal?.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
    throw new VideoAnalysisError('无法连接视频分析服务', 503)
  }
  const text = await response.text()
  if (text.length > MAX_GATEWAY_RESPONSE_CHARS) throw new VideoAnalysisError('视频分析结果过大')
  if (!response.ok) throw new VideoAnalysisError('视频分析服务暂时不可用', response.status)
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new VideoAnalysisError('视频分析返回了无效结果')
  }
  const content = (envelope as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new VideoAnalysisError('视频分析没有返回内容')
  return extractJson(content)
}

export async function analyzeVideoEvidence(
  input: {
    sources: VideoSource[]
    existingEvidence: VideoEvidence[]
    transcriptEvidence: VideoEvidence[]
    frames: VideoAnalysisFrame[]
    userGoal: string
    extractionGaps: string[]
  },
  options: VideoAnalysisGatewayOptions,
): Promise<VideoEvidenceDraft> {
  const prompt = [
    '你是视频证据分析器。只能根据给定素材元数据、转写和随后附带的画面证据输出 JSON。不要补写未观察到的事实。',
    '输出结构：{"evidence":[{"kind":"visual|audio|shot","source_id":"...","in_ms":0,"out_ms":1,"text":"...","confidence":0.0,"warnings":[]}],"gaps":[]}',
    '每条 evidence 必须引用现有 source_id，时间范围必须落在该素材内。没有证据时写入 gaps，不要猜测。',
    JSON.stringify({
      user_goal: input.userGoal,
      sources: input.sources.map(sourceProjection),
      existing_evidence: [...input.existingEvidence, ...input.transcriptEvidence],
      extraction_gaps: input.extractionGaps,
    }),
  ].join('\n')
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
  for (const frame of input.frames) {
    content.push({ type: 'text', text: `画面来源 source_id=${frame.source_id}; time_ms=${frame.in_ms}` })
    content.push({ type: 'image_url', image_url: { url: frame.data_url } })
  }
  const raw = await gatewayJson([
    { role: 'system', content: '只返回合法 JSON，不要 Markdown。图像描述是非可信证据，必须与 source_id 和时间范围绑定。' },
    { role: 'user', content },
  ], options)
  const parsed = evidenceDraftSchema.safeParse(raw)
  if (!parsed.success) throw new VideoAnalysisError('视频证据不符合产品合同')
  return parsed.data
}

export async function planVideoTimeline(
  input: {
    sources: VideoSource[]
    evidence: VideoEvidence[]
    currentScenes: VideoScene[]
    userGoal: string
    analysisGaps: string[]
  },
  options: VideoAnalysisGatewayOptions,
): Promise<VideoPlanDraft> {
  const raw = await gatewayJson([
    { role: 'system', content: '你是证据驱动的视频剪辑规划器。只返回合法 JSON，不要 Markdown；不得引用不存在的素材、时间或 evidence id。' },
    {
      role: 'user',
      content: [
        '根据证据编译 Brief，并生成一个主方案和最多三个同版本备选方案。不要强制固定时长。',
        'Brief 结构：content_type、output_channel、must_preserve_text、recommended_direction、rationale、gaps。',
        'scene 结构：source_id、in_ms、out_ms、story_role(hook|context|action|result|cta|b_roll)、evidence_ids、rationale、needs_review。',
        '每个 scene 至少引用一个 evidence id。锁定场景会由 Host 强制保留；规划时避免用其它场景覆盖其时间范围。',
        JSON.stringify({
          user_goal: input.userGoal,
          sources: input.sources.map(sourceProjection),
          evidence: input.evidence,
          current_scenes: input.currentScenes,
          analysis_gaps: input.analysisGaps,
        }),
      ].join('\n'),
    },
  ], options)
  const parsed = planDraftSchema.safeParse(raw)
  if (!parsed.success) throw new VideoAnalysisError('视频规划不符合产品合同')
  return parsed.data
}

export function compileVideoBrief(userGoal: string, draft: VideoPlanDraft['brief']): VideoBrief {
  return videoBriefSchema.parse({
    ...draft,
    schema_version: 1,
    user_goal: userGoal,
    compiler_version: 'video-brief-v1',
  })
}
