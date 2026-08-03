import {
  imageSizeSupportedByModel,
  type ImageCanvasSize,
  type ImageGenerationModel,
} from '../../../shared/contracts/media.js'
import type { ImageReferenceV2 } from '../../../shared/contracts/imageGeneration.js'
import { providerRegistryEntriesForCapability } from '../../../../gateway/providerRegistry.js'

export const IMAGE_PROVIDER_POLICY_REVISION = 'image-provider-policy-v1'

type OperationMode = 'generate' | 'edit' | 'inpaint'

export type ImageProviderPolicyDecision = {
  policy_revision: typeof IMAGE_PROVIDER_POLICY_REVISION
  provider: string
  model_id: ImageGenerationModel
  operation_mode: OperationMode
  supports_reference_control: true
}

export class ImageProviderPolicyError extends Error {
  constructor(
    message: string,
    readonly gap: {
      code: 'IMAGE_CAPABILITY_GAP'
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

/**
 * The only image-provider routing decision point.  The descriptor is kept
 * deliberately explicit: callers cannot silently downgrade high-fidelity
 * reference controls after a paid request has started.
 */
export function resolveImageProviderPolicy(input: {
  user_request: string
  size: ImageCanvasSize
  operation_mode: OperationMode
  references: ImageReferenceV2[]
  transparent_output?: boolean
  preferred_model?: ImageGenerationModel
}): ImageProviderPolicyDecision {
  if (input.references.some(reference => reference.role === 'unclassified')) {
    throw new ImageProviderPolicyError('参考图角色尚未确认，不能提交付费生成', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: 'classified_reference_role', available_models: availableModels(),
    })
  }
  // Exact Logo/QR source bytes stay local for a later Canvas overlay.  The
  // Provider only receives their reserved-placement instruction in the Brief.
  const providerReferences = input.references.filter(reference => reference.role !== 'logo' && reference.role !== 'qrcode')
  const candidates = providerRegistryEntriesForCapability('ImageGeneration').flatMap(entry => {
    const model: ImageGenerationModel | null = entry.model_id === 'gpt-image-2'
      ? 'gpt-image-2'
      : entry.model_id === 'doubao-seedream-4-5-251128'
        ? 'doubao-seedream-4-5-251128'
        : null
    const descriptor = entry.image_generation
    if (!model || !descriptor || !imageSizeSupportedByModel(model, input.size) || !descriptor.supported_sizes.includes(input.size)) return []
    if (!descriptor.operation_modes.includes(input.operation_mode)) return []
    if (providerReferences.length > descriptor.max_reference_images) return []
    if (providerReferences.some(reference => {
      const { role } = reference
      return role === 'unclassified' || !descriptor.reference_roles.includes(role)
    })) return []
    if (providerReferences.some(reference => !descriptor.reference_preservations.includes(reference.preservation))) return []
    if (input.transparent_output && !descriptor.transparency) return []
    return [{ model, entry }]
  })
  const candidateModels = candidates.map(candidate => candidate.model)
  if (candidateModels.length === 0) {
    throw new ImageProviderPolicyError('没有 Provider 支持交付规格要求的生成尺寸', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: input.transparent_output ? 'transparent_output' : `size:${input.size}`, available_models: availableModels(),
    })
  }
  if (providerReferences.length > 8) {
    throw new ImageProviderPolicyError('当前 Provider 最多支持 8 张参考图', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: 'reference_count<=8', available_models: candidateModels,
    })
  }
  const requiresGpt = input.operation_mode === 'inpaint'
    || providerReferences.some(reference => ['subject', 'product', 'character'].includes(reference.role)
      && (reference.influence_strength === 'high' || reference.preservation === 'must_preserve' || reference.preservation === 'exact'))
  const preferred = input.preferred_model
  const model = requiresGpt
    ? candidateModels.find(candidate => candidate === 'gpt-image-2')
    : preferred && candidateModels.includes(preferred)
      ? preferred
      : /中文|海报|宣传图|活动图|招聘图|朋友圈|易拉宝/u.test(input.user_request)
        ? candidateModels.find(candidate => candidate === 'doubao-seedream-4-5-251128') ?? candidateModels[0]
        : candidateModels.find(candidate => candidate === 'gpt-image-2') ?? candidateModels[0]
  if (!model) {
    throw new ImageProviderPolicyError('当前 Provider 不支持所需的图片控制能力', {
      code: 'IMAGE_CAPABILITY_GAP', requirement: requiresGpt ? 'high_fidelity_reference_or_inpaint' : 'image_generation', available_models: candidateModels,
    })
  }
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
  }
}
