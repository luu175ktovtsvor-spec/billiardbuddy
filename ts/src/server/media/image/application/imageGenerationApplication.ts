import { createHash } from 'node:crypto'
import type { ImageWorkbenchProject } from '../../../../../shared/contracts/media.js'
import {
  createCreativePlanInputSchema,
  type CreateCreativePlanInput,
  type ImageBriefSnapshot,
  type ImageCreativeDirection,
  type ImageCreativePlan,
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

function defaultDirection(project: ImageWorkbenchProject, brief: ImageBriefSnapshot): ImageCreativeDirection {
  return {
    id: stableId('dir', project.id, brief.snapshot_hash, 'default-commercial-direction'),
    label: '稳妥商业版',
    rationale: '保留已确认事实和参考图约束，提供可直接评审的单一方向。',
    generation_intent: {
      composition_goal: '清晰主视觉、主体完整、层级明确',
      visual_tone: '与用户需求和已确认参考一致',
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
): Promise<ImageCreativePlan> {
  const input = createCreativePlanInputSchema.parse(raw)
  const project = await port.loadProject(projectId)
  const brief = await port.compileBrief(project)
  const requestHash = sha256({
    kind: 'creative_plan',
    project_id: project.id,
    base_revision: input.base_revision,
    brief_snapshot_hash: brief.snapshot_hash,
    directions: input.directions ?? null,
  })
  const planId = stableId('plan', project.id, input.idempotency_key)
  const existing = await port.findPlan(project.id, planId)
  if (existing) return await port.savePlan({ ...existing, id: planId }, requestHash)
  if (project.revision !== input.base_revision) throw port.revisionConflict()
  const directions = input.directions?.map((direction, index) => ({
    ...direction,
    id: stableId('dir', project.id, input.idempotency_key, String(index)),
  })) ?? [defaultDirection(project, brief)]
  return await port.savePlan({
    id: planId,
    project_id: project.id,
    brief_snapshot_hash: brief.snapshot_hash,
    directions,
    source: 'deterministic',
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
