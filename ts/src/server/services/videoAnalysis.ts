import { z } from 'zod/v4'
import {
  videoBriefSchema,
  type VideoBrief,
  type VideoEvidence,
  type VideoScene,
  type VideoSource,
} from '../../../shared/contracts/media.js'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway.js'
import { productGatewayTarget } from '../product/productGatewayRuntime.js'
import { mediaReasoningRegistryEntry } from '../../../../gateway/providerRegistry.js'

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

const visualEvidenceBatchSchema = z.object({
  schema: z.literal('bb.visual-evidence-batch.v1'),
  evidence: z.array(z.object({
    schema: z.literal('bb.visual-evidence.v1'),
    ocr: z.string().max(16 * 1024),
    objects: z.array(z.string()).max(64),
    layout: z.string().max(16 * 1024),
    ui: z.array(z.string()).max(64),
    alerts: z.array(z.string()).max(64),
    observations: z.array(z.string()).max(64),
  })).max(8),
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
  /** Host-owned Evidence Window that authorized this visual input. */
  evidence_window_id?: string
  /** Exclusive end bound for the visual fact projected from this frame. */
  range_end_ms?: number
  data_url: string
}

export type VideoAnalysisGatewayOptions = {
  operationId: string
  signal?: AbortSignal
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  env?: Record<string, string | undefined>
}

type VideoPlanningInput = {
  sources: VideoSource[]
  evidence: VideoEvidence[]
  currentScenes: VideoScene[]
  userGoal: string
  analysisGaps: string[]
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

function sceneUsesHostFacts(
  scene: z.infer<typeof sceneDraftSchema>,
  sources: ReadonlyMap<string, VideoSource>,
  evidence: ReadonlyMap<string, VideoEvidence>,
): boolean {
  const source = sources.get(scene.source_id)
  if (!source || scene.out_ms > source.duration_ms) return false
  return scene.evidence_ids.every(evidenceId => {
    const item = evidence.get(evidenceId)
    return Boolean(
      item
      && item.source_id === scene.source_id
      && item.in_ms < scene.out_ms
      && item.out_ms > scene.in_ms,
    )
  })
}

function planUsesHostFacts(plan: VideoPlanDraft, input: VideoPlanningInput): boolean {
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const evidence = new Map(input.evidence.map(item => [item.id, item]))
  return plan.scenes.every(scene => sceneUsesHostFacts(scene, sources, evidence))
    && plan.alternatives.every(alternative => (
      alternative.scenes.every(scene => sceneUsesHostFacts(scene, sources, evidence))
    ))
}

function deterministicFallbackPlan(input: VideoPlanningInput): VideoPlanDraft {
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const evidence = new Map(input.evidence.map(item => [item.id, item]))
  const evidenceForRange = (sourceId: string, inMs: number, outMs: number): string[] => input.evidence
    .filter(item => item.source_id === sourceId && item.in_ms < outMs && item.out_ms > inMs)
    .slice(0, 100)
    .map(item => item.id)

  const fromCurrent = input.currentScenes.flatMap(scene => {
    const source = sources.get(scene.source_id)
    if (!source || scene.out_ms > source.duration_ms) return []
    const retained = scene.evidence_ids.filter(evidenceId => {
      const item = evidence.get(evidenceId)
      return Boolean(
        item
        && item.source_id === scene.source_id
        && item.in_ms < scene.out_ms
        && item.out_ms > scene.in_ms,
      )
    })
    const evidenceIds = retained.length
      ? retained.slice(0, 100)
      : evidenceForRange(scene.source_id, scene.in_ms, scene.out_ms)
    if (evidenceIds.length === 0) return []
    return [{
      source_id: scene.source_id,
      in_ms: scene.in_ms,
      out_ms: scene.out_ms,
      story_role: scene.story_role,
      evidence_ids: evidenceIds,
      rationale: '保留用户当前时间线与已确认的真实素材范围，等待人工复核剪辑方向。',
      needs_review: true,
    }]
  })

  const scenes = fromCurrent.length > 0 ? fromCurrent : input.sources.flatMap((source, index) => {
    const evidenceIds = evidenceForRange(source.id, 0, source.duration_ms)
    if (evidenceIds.length === 0) return []
    return [{
      source_id: source.id,
      in_ms: 0,
      out_ms: source.duration_ms,
      story_role: index === 0 ? 'hook' as const : index === input.sources.length - 1 ? 'result' as const : 'action' as const,
      evidence_ids: evidenceIds,
      rationale: '按导入顺序保留真实素材与 Host 已绑定的证据范围，等待人工复核剪辑方向。',
      needs_review: true,
    }]
  })

  if (scenes.length === 0) throw new VideoAnalysisError('没有足够的真实证据生成视频方案')
  return planDraftSchema.parse({
    brief: {
      content_type: '视频短片',
      output_channel: '未指定',
      must_preserve_text: [],
      recommended_direction: '先保留真实素材顺序与已有时间线，再由用户确认剪辑方向。',
      rationale: ['智能剪辑建议不可用时，Host 只保留已验证的素材、时间范围和证据引用。'],
      gaps: [...new Set([
        ...input.analysisGaps,
        '智能剪辑建议暂不可用，已保留真实素材顺序。',
      ])].slice(0, 20),
    },
    scenes,
    alternatives: [],
  })
}

async function gatewayJson(
  messages: Array<{ role: 'system' | 'user'; content: string | Array<Record<string, unknown>> }>,
  options: VideoAnalysisGatewayOptions,
): Promise<unknown> {
  const env = options.env ?? process.env
  const productTarget = env === process.env ? productGatewayTarget() : null
  const gatewayUrl = productTarget?.baseUrl ?? env.BB_GATEWAY_URL?.trim() ?? ''
  const gatewayToken = productTarget?.token ?? env.BB_GATEWAY_TOKEN?.trim() ?? ''
  if (!gatewayUrl || !gatewayToken) {
    throw new VideoAnalysisError('视频分析服务未配置', 503, 'GATEWAY_NOT_CONFIGURED')
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${gatewayToken}`,
    'Content-Type': 'application/json',
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': options.operationId,
  }
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

async function gatewayVisualEvidence(
  frames: VideoAnalysisFrame[],
  options: VideoAnalysisGatewayOptions,
): Promise<z.infer<typeof visualEvidenceBatchSchema>['evidence']> {
  if (frames.length === 0) return []
  const env = options.env ?? process.env
  const productTarget = env === process.env ? productGatewayTarget() : null
  const gatewayUrl = productTarget?.baseUrl ?? env.BB_GATEWAY_URL?.trim() ?? ''
  const gatewayToken = productTarget?.token ?? env.BB_GATEWAY_TOKEN?.trim() ?? ''
  if (!gatewayUrl || !gatewayToken) throw new VideoAnalysisError('视频分析服务未配置', 503, 'GATEWAY_NOT_CONFIGURED')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${gatewayToken}`,
    'Content-Type': 'application/json',
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': options.operationId,
  }
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(`${gatewayUrl.replace(/\/+$/, '')}/v1/visual/evidence`, {
      method: 'POST',
      headers,
      signal: options.signal,
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: frames.map(frame => ({ type: 'image_url', image_url: { url: frame.data_url } })),
        }],
      }),
    })
  } catch {
    if (options.signal?.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
    throw new VideoAnalysisError('无法连接视觉证据服务', 503)
  }
  const text = await response.text()
  if (text.length > MAX_GATEWAY_RESPONSE_CHARS) throw new VideoAnalysisError('视觉证据结果过大')
  if (!response.ok) throw new VideoAnalysisError('视觉证据服务暂时不可用', response.status)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new VideoAnalysisError('视觉证据返回了无效结果') }
  const parsed = visualEvidenceBatchSchema.safeParse(raw)
  if (!parsed.success || parsed.data.evidence.length !== frames.length) {
    throw new VideoAnalysisError('视觉证据不符合产品合同')
  }
  return parsed.data.evidence
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
  let visual: z.infer<typeof visualEvidenceBatchSchema>['evidence'] = []
  const gaps = [...input.extractionGaps]
  try {
    // The provider envelope caps one request at eight images. Batching keeps
    // the caller's Evidence Window budget intact instead of silently dropping
    // later windows or making an oversized request invalid.
    for (let offset = 0; offset < input.frames.length; offset += 8) {
      visual.push(...await gatewayVisualEvidence(input.frames.slice(offset, offset + 8), options))
    }
  } catch (error) {
    if (options.signal?.aborted || (error instanceof VideoAnalysisError && error.code === 'VIDEO_ANALYSIS_CANCELLED')) {
      throw error
    }
    // The Host can still make a truthful, review-required plan from source
    // facts and locally extracted transcripts. Never replace absent visual
    // evidence with model-shaped text merely to keep the workflow moving.
    if (input.frames.length > 0) gaps.push('视觉证据服务暂不可用，未写入未核验的画面结论。')
  }
  const sources = new Map(input.sources.map(source => [source.id, source]))
  const evidence = input.frames.flatMap((frame, index) => {
    const source = sources.get(frame.source_id)
    const item = visual[index]
    if (!source || !item || frame.in_ms < 0 || frame.in_ms >= source.duration_ms) return []
    const outMs = Math.min(
      source.duration_ms,
      frame.range_end_ms ?? source.duration_ms,
      Math.max(frame.in_ms + 1, frame.in_ms + 1_000),
    )
    if (outMs <= frame.in_ms) return []
    const facts = [
      item.ocr ? `可见文字：${item.ocr}` : '',
      item.objects.length ? `对象：${item.objects.join('；')}` : '',
      item.layout ? `布局：${item.layout}` : '',
      item.observations.length ? `观察：${item.observations.join('；')}` : '',
      item.ui.length ? `界面：${item.ui.join('；')}` : '',
    ].filter(Boolean)
    return [{
      kind: 'visual' as const,
      source_id: frame.source_id,
      in_ms: frame.in_ms,
      out_ms: outMs,
      text: facts.join('。') || '该采样帧没有可确认的视觉细节。',
      confidence: facts.length ? 0.8 : 0.4,
      warnings: [...item.alerts, ...(facts.length ? [] : ['视觉证据为空，禁止据此补写事实。'])].slice(0, 20),
    }]
  })
  if (input.frames.length === 0) gaps.push('没有可用画面采样。')
  if (input.transcriptEvidence.length === 0 && input.sources.some(source => source.has_audio)) gaps.push('素材含音轨，但没有获得可用转写。')
  return evidenceDraftSchema.parse({ evidence, gaps: [...new Set(gaps)].slice(0, 40) })
}

export async function planVideoTimeline(
  input: VideoPlanningInput,
  options: VideoAnalysisGatewayOptions,
): Promise<VideoPlanDraft> {
  try {
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
    if (!parsed.success || !planUsesHostFacts(parsed.data, input)) {
      throw new VideoAnalysisError('视频规划不符合产品合同')
    }
    return parsed.data
  } catch (error) {
    if (options.signal?.aborted || (error instanceof VideoAnalysisError && error.code === 'VIDEO_ANALYSIS_CANCELLED')) {
      throw error
    }
    return deterministicFallbackPlan(input)
  }
}

export function compileVideoBrief(userGoal: string, draft: VideoPlanDraft['brief']): VideoBrief {
  return videoBriefSchema.parse({
    ...draft,
    schema_version: 1,
    user_goal: userGoal,
    compiler_version: 'video-brief-v1',
  })
}
