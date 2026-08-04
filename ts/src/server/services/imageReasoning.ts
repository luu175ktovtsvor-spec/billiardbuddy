import {
  imageCreativeBriefSchema,
  type ImageBriefOverrides,
  type ImageCreativeBrief,
  type ImageProjectReference,
} from '../../../shared/contracts/media.js'
import { applyImageBriefOverrides, compileImageBrief, providerPromptForImageBrief } from './imageBrief.js'

/**
 * Compatibility façade for the fenced legacy media project reader.
 *
 * The workbench's only remote image understanding/assessment path is now the
 * typed Qwen adapter.  Keeping an old free-form chat request here would leave
 * a second MiMo image path able to mutate a legacy brief.  Therefore legacy
 * imports can still compile their deterministic brief, but never call a model.
 */
export type ImageQualityAssessment = {
  candidate_index: number
  score: number
  summary: string
  issues: string[]
  suggestions: string[]
}

export type ImageReasoningGatewayOptions = {
  operationId: string
  signal?: AbortSignal
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  env?: Record<string, string | undefined>
}

export class ImageReasoningError extends Error {
  constructor(message: string, readonly status = 503, readonly code = 'IMAGE_REASONING_UNAVAILABLE') {
    super(message)
    this.name = 'ImageReasoningError'
  }
}

export async function reasonImageBrief(
  input: {
    userRequest: string
    references: Array<ImageProjectReference & { data_url: string }>
    overrides?: ImageBriefOverrides
  },
  _options: ImageReasoningGatewayOptions,
): Promise<{ brief: ImageCreativeBrief; providerPrompt: string }> {
  // Legacy callers remain deterministic and preserve their historical read
  // compatibility.  Qwen suggestions are persisted separately by the 15.4
  // Image Workbench and cannot be silently folded into this old writer.
  const base = compileImageBrief(input.userRequest, input.references).brief
  const brief = imageCreativeBriefSchema.parse(applyImageBriefOverrides(base, input.overrides))
  return { brief, providerPrompt: providerPromptForImageBrief(brief) }
}

export async function assessImageCandidates(
  _input: {
    brief: ImageCreativeBrief
    candidates: Array<{ data_url: string; candidate_index: number }>
  },
  _options: ImageReasoningGatewayOptions,
): Promise<ImageQualityAssessment[]> {
  // Do not invent an untyped legacy Qwen score.  The old task pipeline treats
  // this as an optional unavailable quality pass and still persists its result;
  // callers needing advice must use the receipt-backed 15.4 assessment API.
  throw new ImageReasoningError('旧图片质检已停用；请使用 Qwen 视觉评估建议', 410, 'IMAGE_LEGACY_REASONING_FORBIDDEN')
}
