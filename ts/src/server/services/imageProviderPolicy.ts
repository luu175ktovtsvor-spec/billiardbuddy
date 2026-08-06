import {
  imageSizeSupportedByModel,
  type ImageCanvasSize,
  type ImageGenerationModel,
} from '../../../shared/contracts/media.js'
import type { ImageReferenceV2 } from '../../../shared/contracts/imageGeneration.js'
import { providerRegistryEntriesForCapability } from '../../../../gateway/providerRegistry.js'

export const IMAGE_PROVIDER_POLICY_REVISION = 'image-provider-policy-v1'

type OperationMode = 'generate' | 'edit' | 'inpaint'

type ImageProviderPolicyInput = {
  user_request: string
  size: ImageCanvasSize
  operation_mode: OperationMode
  references: ImageReferenceV2[]
  transparent_output?: boolean
  /** Omit only for the user-facing “智能推荐” choice. */
  preferred_model?: ImageGenerationModel
}

export type ImageProviderPolicyDecision = {
  policy_revision: typeof IMAGE_PROVIDER_POLICY_REVISION
  provider: string
  model_id: ImageGenerationModel
  operation_mode: OperationMode
  supports_reference_control: true
  price_upper_bound: {
    currency: string
    per_output_amount_minor: number
    pricing_revision: string
  }
}

export class ImageProviderPolicyError extends Error {
  constructor(
    message: string,
    readonly gap: {
      code: 'IMAGE_CAPABILITY_GAP' | 'IMAGE_MODEL_SELECTION_UNSUPPORTED'
      requirement: string
      available_models: ImageGenerationModel[]
    },
  ) {
    super(message)
    this.name = 'ImageProviderPolicyError'
  }
}

function availableModels(): ImageGenerationModel[] {
  return providerRegistryEntriesForCapability('ImageGeneration')
    .map(entry => entry.model_id)
    .filter((model): model is ImageGenerationModel => model === 'gpt-image-2' || model === 'doubao-seedream-4-5-251128')
}

type EligibleCandidate = {
  model: ImageGenerationModel
  entry: ReturnType<typeof providerRegistryEntriesForCapability>[number]
}

function providerReferences(references: ImageReferenceV2[]): ImageReferenceV2[] {
  // Exact Logo/QR source bytes stay local for a later Canvas overlay.  The
  // Provider only receives their reserved-placement instruction in the Brief.
  return references.filter(reference => reference.role !== 'logo' && reference.role !== 'qrcode')
}

function requirementCandidates(input: Omit<ImageProviderPolicyInput, 'size'>, size?: ImageCanvasSize): EligibleCandidate[] {
  if (input.references.some(reference => reference.role === 'unclassified')) {
    throw new ImageProviderPolicyError('参考图角色尚未确认，不能提交付费生成', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: 'classified_reference_role', available_models: availableModels(),
    })
  }
  const references = providerReferences(input.references)
  return providerRegistryEntriesForCapability('ImageGeneration').flatMap(entry => {
    const model: ImageGenerationModel | null = entry.model_id === 'gpt-image-2'
      ? 'gpt-image-2'
      : entry.model_id === 'doubao-seedream-4-5-251128'
        ? 'doubao-seedream-4-5-251128'
        : null
    const descriptor = entry.image_generation
    if (!model || !descriptor) return []
    if (size && (!imageSizeSupportedByModel(model, size) || !descriptor.supported_sizes.includes(size))) return []
    if (!descriptor.operation_modes.includes(input.operation_mode)) return []
    if (references.length > descriptor.max_reference_images) return []
    if (references.some(reference => {
      const { role } = reference
      return role === 'unclassified' || !descriptor.reference_roles.includes(role)
    })) return []
    if (references.some(reference => !descriptor.reference_preservations.includes(reference.preservation))) return []
    if (input.transparent_output && !descriptor.transparency) return []
    return [{ model, entry }]
  })
}

function selectModel(input: Omit<ImageProviderPolicyInput, 'size'>, candidates: EligibleCandidate[]): ImageGenerationModel {
  const candidateModels = candidates.map(candidate => candidate.model)
  const references = providerReferences(input.references)
  if (candidateModels.length === 0) {
    throw new ImageProviderPolicyError('没有 Provider 支持当前图片控制要求', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: input.transparent_output ? 'transparent_output' : 'image_generation', available_models: availableModels(),
    })
  }
  if (references.length > 8) {
    throw new ImageProviderPolicyError('当前 Provider 最多支持 8 张参考图', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: 'reference_count<=8', available_models: candidateModels,
    })
  }
  const requiresGpt = input.operation_mode === 'inpaint'
    || references.some(reference => ['subject', 'product', 'character'].includes(reference.role)
      && (reference.influence_strength === 'high' || reference.preservation === 'must_preserve' || reference.preservation === 'exact'))
  const preferred = input.preferred_model
  // A visible model choice is never silently overridden.  The registry already
  // filters operation, size, reference-role, preservation and transparency
  // capabilities above.  The high-fidelity heuristic is only an Auto-routing
  // preference: Seedream accepts controlled subject/product/character refs too,
  // so an explicit user choice must not be rejected by that heuristic.
  if (preferred) {
    if (!candidateModels.includes(preferred)) {
      throw new ImageProviderPolicyError('所选图片模型无法满足当前参考图或编辑控制要求', {
        code: 'IMAGE_MODEL_SELECTION_UNSUPPORTED',
        requirement: 'selected_model_unavailable',
        available_models: candidateModels,
      })
    }
    return preferred
  }
  const model = requiresGpt
    ? candidateModels.find(candidate => candidate === 'gpt-image-2')
    : /中文|海报|宣传图|活动图|招聘图|朋友圈|易拉宝/u.test(input.user_request)
      ? candidateModels.find(candidate => candidate === 'doubao-seedream-4-5-251128') ?? candidateModels[0]
      : candidateModels.find(candidate => candidate === 'gpt-image-2') ?? candidateModels[0]
  if (!model) {
    throw new ImageProviderPolicyError('当前 Provider 不支持所需的图片控制能力', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: requiresGpt ? 'high_fidelity_reference_or_inpaint' : 'image_generation', available_models: candidateModels,
    })
  }
  return model
}

/** Resolve the model before the image workbench maps a user-facing intent to pixels. */
export function resolveImageProviderModel(input: Omit<ImageProviderPolicyInput, 'size'>): ImageGenerationModel {
  return selectModel(input, requirementCandidates(input))
}

/**
 * The only image-provider routing decision point.  The descriptor is kept
 * deliberately explicit: callers cannot silently downgrade high-fidelity
 * reference controls after a paid request has started.
 */
export function resolveImageProviderPolicy(input: ImageProviderPolicyInput): ImageProviderPolicyDecision {
  const candidates = requirementCandidates(input, input.size)
  const candidateModels = candidates.map(candidate => candidate.model)
  if (candidateModels.length === 0) {
    throw new ImageProviderPolicyError('没有 Provider 支持交付规格要求的生成尺寸', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: input.transparent_output ? 'transparent_output' : `size:${input.size}`, available_models: availableModels(),
    })
  }
  const model = selectModel(input, candidates)
  const entry = candidates.find(candidate => candidate.model === model)?.entry
  if (!entry) throw new ImageProviderPolicyError('图片 Provider 注册表不完整', {
    code: 'IMAGE_CAPABILITY_GAP', requirement: 'registered_image_generation_model', available_models: candidateModels,
  })
  return {
    policy_revision: IMAGE_PROVIDER_POLICY_REVISION,
    provider: entry.provider,
    model_id: model,
    operation_mode: input.operation_mode,
    supports_reference_control: true,
    price_upper_bound: entry.image_generation!.price_upper_bound,
  }
}
