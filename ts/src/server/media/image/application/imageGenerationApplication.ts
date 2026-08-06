import { createHash } from 'node:crypto'
import type { ImageWorkbenchProject } from '../../../../../shared/contracts/media.js'
import {
  createCreativePlanInputSchema,
  type CreateCreativePlanInput,
  type ImageBriefSnapshot,
  type ImageCreativeDirection,
  type ImageCreativePlan,
  type ImageUnderstandingSuggestion,
} from '../../../../../shared/contracts/imageGeneration.js'
import { ImageApplication } from './imageApplication.js'
import type { ImageGenerationApplicationPort } from '../runtime/imageApplicationPorts.js'
import type { ImageCreativePlanRuntimePort } from '../../../services/imageWorkbenchRuntime.js'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function stableId(prefix: 'plan' | 'dir', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function safePlanningSuggestions(suggestion: ImageUnderstandingSuggestion | null): string[] {
  if (!suggestion) return []
  // Planning advice is model output, not an authority.  Its scope is limited
  // to visual composition and it must never smuggle a system-like instruction
  // or a claim that can alter the user's confirmed facts.
  return suggestion.composition_suggestions
    .map(value => value.replace(/\s+/gu, ' ').trim())
    .filter(value => value.length > 0 && !/(?:忽略|系统(?:提示|指令)?|指令|密码|密钥|上传|下载|https?:\/\/|ignore|system|instruction|password|secret|upload|download)/iu.test(value))
    .slice(0, 2)
}

const intentPurposeLabels: Record<NonNullable<ImageUnderstandingSuggestion['user_intent']>['purpose'], string> = {
  sell: '促进购买或转化',
  promote: '宣传推广',
  announce: '发布通知或活动信息',
  inform: '说明信息或知识',
  brand: '强化品牌识别',
  social_engagement: '提升社交传播和互动',
  personal: '个人表达或纪念',
  other: '完成用户描述的特定用途',
  unknown: '',
}
const intentChannelLabels: Record<NonNullable<ImageUnderstandingSuggestion['user_intent']>['channel'], string> = {
  social_feed: '社交信息流',
  poster: '海报或活动物料',
  product_page: '商品详情或产品页面',
  presentation: '演示或汇报页面',
  story: '竖屏故事或视频封面',
  print: '线下印刷物料',
  other: '用户指定的其他渠道',
  unknown: '',
}
const intentPriorityLabels: Record<NonNullable<ImageUnderstandingSuggestion['user_intent']>['priority_order'][number], string> = {
  subject: '主体',
  product: '产品',
  character: '角色',
  brand: '品牌',
  text: '文字区域',
  layout: '版式层级',
  mood: '情绪氛围',
  background: '背景',
}

function safeIntentText(value: string): string | null {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized || normalized.length > 500) return null
  if (/(?:忽略|系统(?:提示|指令)?|指令|密码|密钥|上传|下载|https?:\/\/|ignore|system|instruction|password|secret|upload|download)/iu.test(normalized)) return null
  return normalized
}

function safePlanningIntent(suggestion: ImageUnderstandingSuggestion | null): {
  composition: string[]
  tone: string[]
} {
  const intent = suggestion?.user_intent
  if (!intent) return { composition: [], tone: [] }
  const composition: string[] = []
  const tone: string[] = []
  const purpose = intentPurposeLabels[intent.purpose]
  const channel = intentChannelLabels[intent.channel]
  if (purpose) composition.push(`目标：${purpose}`)
  if (channel) composition.push(`使用场景：${channel}`)
  if (intent.audience) {
    const audience = safeIntentText(intent.audience)
    if (audience) composition.push(`目标受众：${audience}`)
  }
  if (intent.subject) {
    const subject = safeIntentText(intent.subject)
    if (subject) composition.push(`核心主体：${subject}`)
  }
  if (intent.priority_order.length > 0) {
    composition.push(`优先层级：${intent.priority_order.map(value => intentPriorityLabels[value]).join('、')}`)
  }
  if (intent.desired_effect) {
    const desiredEffect = safeIntentText(intent.desired_effect)
    if (desiredEffect) tone.push(`希望达到：${desiredEffect}`)
  }
  const styles = intent.style_keywords.map(safeIntentText).filter((value): value is string => value !== null).slice(0, 4)
  if (styles.length > 0) tone.push(`视觉关键词：${styles.join('、')}`)
  return { composition, tone }
}

function hasPlanningAdvice(suggestion: ImageUnderstandingSuggestion | null): boolean {
  const intent = safePlanningIntent(suggestion)
  return safePlanningSuggestions(suggestion).length > 0 || intent.composition.length > 0 || intent.tone.length > 0
}

function defaultDirection(
  project: ImageWorkbenchProject,
  brief: ImageBriefSnapshot,
  suggestion: ImageUnderstandingSuggestion | null,
): ImageCreativeDirection {
  const planning = safePlanningSuggestions(suggestion)
  const intent = safePlanningIntent(suggestion)
  const composition = [
    '清晰主视觉、主体完整、层级明确',
    ...intent.composition,
    ...planning,
  ].join('；').slice(0, 500)
  const tone = [
    '与用户需求和已确认参考一致',
    ...intent.tone,
  ].join('；').slice(0, 500)
  return {
    id: stableId('dir', project.id, brief.snapshot_hash, 'default-commercial-direction'),
    label: '稳妥商业版',
    rationale: planning.length > 0 || intent.composition.length > 0 || intent.tone.length > 0
      ? '先把用户的用途、受众和视觉优先级整理成可复核方向，再保留已确认事实和参考图约束形成可直接评审的单一方向。'
      : '保留已确认事实和参考图约束，提供可直接评审的单一方向。',
    generation_intent: {
      composition_goal: composition,
      visual_tone: tone,
      ...(brief.exact_text.length > 0 ? { text_space_goal: '预留清晰的确定性文字排版区域' } : {}),
    },
    preservation_rules: brief.must_preserve,
  }
}

/** Shared only by Generation Application and Runtime-internal compatibility flows. */
export async function createCreativePlanCommand(
  port: ImageCreativePlanRuntimePort,
  projectId: string,
  raw: CreateCreativePlanInput,
  options: { requireAdviceConfirmation?: boolean } = {},
): Promise<ImageCreativePlan> {
  const input = createCreativePlanInputSchema.parse(raw)
  const project = await port.loadProject(projectId)
  const planId = stableId('plan', project.id, input.idempotency_key)
  const existing = await port.findPlan(project.id, planId)
  // Replaying a persisted Plan must not create a new hidden planning request.
  // The persisted receipt is part of the original request identity; use it
  // directly when rebuilding the hash instead of asking Qwen again.
  if (existing) {
    const replayIdentity = {
      kind: 'creative_plan',
      project_id: project.id,
      base_revision: input.base_revision,
      brief_snapshot_hash: existing.brief_snapshot_hash,
      directions: input.directions ?? null,
      ...(!input.directions && existing.suggestion_receipt_id
        ? { planning_suggestion_receipt_id: existing.suggestion_receipt_id }
        : {}),
    }
    const currentHash = sha256({
      ...replayIdentity,
      accept_suggestion_receipt_id: input.accept_suggestion_receipt_id ?? null,
    })
    // Plans written before the explicit advice receipt field used this legacy
    // identity. Try the current identity first so new deterministic Plans
    // replay strictly, then bind only a historical empty hash when needed.
    if (input.accept_suggestion_receipt_id === undefined) {
      try {
        return await port.savePlan({ ...existing, id: planId }, currentHash)
      } catch (error) {
        if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'IMAGE_IDEMPOTENCY_CONFLICT') throw error
        return await port.savePlan({ ...existing, id: planId }, sha256(replayIdentity))
      }
    }
    return await port.savePlan({ ...existing, id: planId }, currentHash)
  }
  // The public command must not silently spend a metered Qwen call merely
  // because the user clicked Plan.  Advice is an explicit preceding action;
  // only internal compatibility flows opt into best-effort planning.
  const suggestion = input.directions ? null : options.requireAdviceConfirmation === false
    ? await port.ensurePlanningSuggestion(project)
    : await port.latestPlanningSuggestion(project)
  if (
    options.requireAdviceConfirmation !== false
    && !input.directions
    && suggestion
    && (suggestion.execution_receipt_id !== input.accept_suggestion_receipt_id
      || suggestion.project_revision !== project.revision)
  ) {
    throw port.adviceConfirmationRequired()
  }
  const brief = await port.compileBrief(project)
  const hasAdvice = hasPlanningAdvice(suggestion)
  const requestHash = sha256({
    kind: 'creative_plan',
    project_id: project.id,
    base_revision: input.base_revision,
    brief_snapshot_hash: brief.snapshot_hash,
    accept_suggestion_receipt_id: input.accept_suggestion_receipt_id ?? null,
    directions: input.directions ?? null,
    ...(hasAdvice && suggestion
      ? { planning_suggestion_receipt_id: suggestion.execution_receipt_id }
      : {}),
  })
  if (project.revision !== input.base_revision) throw port.revisionConflict()
  const directions = input.directions?.map((direction, index) => ({
    ...direction,
    id: stableId('dir', project.id, input.idempotency_key, String(index)),
  })) ?? [defaultDirection(project, brief, suggestion)]
  return await port.savePlan({
    id: planId,
    project_id: project.id,
    brief_snapshot_hash: brief.snapshot_hash,
    directions,
    source: hasAdvice ? 'assisted' : 'deterministic',
    ...(hasAdvice && suggestion ? { suggestion_receipt_id: suggestion.execution_receipt_id } : {}),
    created_at: port.iso(),
  }, requestHash)
}

/** Paid generation, candidate decisions, derivation and non-blocking Qwen advice. */
export class ImageGenerationApplication extends ImageApplication<ImageGenerationApplicationPort> {
  readonly #creativePlan: ImageCreativePlanRuntimePort

  readonly understandProject = this.bind('understandProject')
  readonly assessCandidateVisual = this.bind('assessCandidateVisual')
  readonly assessVersionVisual = this.bind('assessVersionVisual')
  readonly createCreativePlan = async (
    projectId: string,
    raw: CreateCreativePlanInput,
  ): Promise<ImageCreativePlan> => await createCreativePlanCommand(this.#creativePlan, projectId, raw)
  readonly getCreativePlan = this.bind('getCreativePlan')
  readonly estimateGenerationRound = this.bind('estimateGenerationRound')
  readonly createGenerationRound = this.bind('createGenerationRound')
  readonly estimateDerivation = this.bind('estimateDerivation')
  readonly estimateVersionDerivation = this.bind('estimateVersionDerivation')
  readonly deriveCandidate = this.bind('deriveCandidate')
  readonly deriveVersion = this.bind('deriveVersion')
  readonly getGenerationOperation = this.bind('getGenerationOperation')
  readonly findGenerationOperation = this.bind('findGenerationOperation')
  readonly cancelGenerationOperation = this.bind('cancelGenerationOperation')
  readonly listGenerationOperations = this.bind('listGenerationOperations')
  readonly getGenerationRound = this.bind('getGenerationRound')
  readonly getCandidateGroup = this.bind('getCandidateGroup')
  readonly getCandidate = this.bind('getCandidate')
  readonly decideCandidate = this.bind('decideCandidate')
  readonly adoptCandidate = this.bind('adoptCandidate')
  readonly readCandidateAsset = this.bind('readCandidateAsset')
  readonly submitProject = this.bind('submitProject')
  readonly startOperation = this.bind('startOperation')

  constructor(port: ImageGenerationApplicationPort) {
    super(port)
    this.#creativePlan = port.creativePlan
  }
}
