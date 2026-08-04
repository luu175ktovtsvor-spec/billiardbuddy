import type {
  ManagedModelCatalogEntry,
  ManagedModelWorkload,
  ProviderCapability,
} from './providerContracts.js'

const DEFAULT_BODY_CAPS = {
  CHAT_TEXT_BODY_MAX_BYTES: 24 * 1024 * 1024,
  VISION_BODY_MAX_BYTES: 24 * 1024 * 1024,
  IMAGE_GENERATION_BODY_MAX_BYTES: 32 * 1024 * 1024,
} as const

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

/**
 * The one provider-neutral model catalog shared by desktop, Gateway and Relays.
 *
 * This file contains no credentials, concurrency numbers or customer quota. A
 * workload binding points to those independent policies by stable identifier.
 * Adding a DeepSeek variant therefore does not duplicate its scheduler or ledger.
 */
const MANAGED_MODEL_CATALOG_SOURCE = [
  {
    model_id: 'deepseek-v4-flash',
    provider: 'deepseek',
    capabilities: ['TextReasoning'],
    workload_bindings: [{
      workload: 'managed_agent_text',
      default_for_workload: true,
      capacity_pool: 'deepseek-account',
      quota_bucket: 'gateway.text-reasoning',
      execution_runtime: 'gateway',
      credential_slot: 'gateway.deepseek',
    }],
    text_reasoning_transport: 'responses',
    worker_env_source: { variable: 'BB_GATEWAY_MODEL', slot_aliases: [], default_model: true },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'ts/desktop/electron/services/codexNativeAppServer.ts', status: 'conservative' },
  },
  {
    model_id: 'deepseek-v4-pro',
    provider: 'deepseek',
    capabilities: ['TextReasoning'],
    workload_bindings: [{
      workload: 'managed_agent_text',
      capacity_pool: 'deepseek-account',
      quota_bucket: 'gateway.text-reasoning',
      execution_runtime: 'gateway',
      credential_slot: 'gateway.deepseek',
    }],
    text_reasoning_transport: 'responses',
    worker_env_source: { variable: 'BB_GATEWAY_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'ts/desktop/electron/services/codexNativeAppServer.ts', status: 'conservative' },
  },
  {
    model_id: 'mimo-v2.5',
    provider: 'mimo',
    capabilities: ['VisualEvidence', 'MediaReasoning'],
    workload_bindings: [
      {
        workload: 'shared_visual_evidence',
        default_for_workload: true,
        capacity_pool: 'mimo-account',
        capacity_lane: 'vision',
        quota_bucket: 'gateway.visual-evidence',
        execution_runtime: 'gateway',
        credential_slot: 'gateway.mimo',
      },
      {
        workload: 'media_reasoning',
        default_for_workload: true,
        capacity_pool: 'mimo-account',
        capacity_lane: 'media',
        quota_bucket: 'gateway.media-reasoning',
        execution_runtime: 'gateway',
        credential_slot: 'gateway.mimo',
      },
    ],
    worker_env_source: { variable: 'GW_MIMO_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'gateway/visionBridge.ts', status: 'conservative' },
  },
  {
    model_id: 'qwen3-vl-flash',
    provider: 'qwen',
    capabilities: ['VisualEvidence'],
    workload_bindings: [{
      workload: 'image_advice',
      default_for_workload: true,
      capacity_pool: 'qwen-account',
      quota_bucket: 'gateway.image-advice',
      execution_runtime: 'gateway',
      credential_slot: 'gateway.qwen',
    }, {
      workload: 'video_visual_evidence',
      default_for_workload: true,
      capacity_pool: 'video-dashscope-account',
      capacity_lane: 'visual',
      quota_bucket: 'video-relay.account',
      execution_runtime: 'video-media-relay',
      credential_slot: 'video-relay.dashscope',
    }],
    worker_env_source: { variable: 'GW_QWEN_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS, VISION_BODY_MAX_BYTES: 16 * 1024 * 1024 },
    resume_evidence: { path: 'gateway/qwenImageReasoning.ts', status: 'conservative' },
  },
  {
    model_id: 'gpt-image-2',
    provider: 'openai',
    capabilities: ['ImageGeneration'],
    workload_bindings: [{
      workload: 'image_generation',
      default_for_workload: true,
      capacity_pool: 'openai-image-account',
      quota_bucket: 'relay.image-paid',
      execution_runtime: 'image-relay',
      credential_slot: 'image-relay.openai',
    }],
    image_generation: {
      operation_modes: ['generate', 'edit', 'inpaint'],
      max_reference_images: 8,
      reference_roles: ['subject', 'product', 'character', 'style', 'composition', 'environment', 'brand', 'logo', 'qrcode'],
      reference_preservations: ['may_change', 'prefer_preserve', 'must_preserve', 'exact'],
      supported_sizes: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '3840x2160', '2160x3840'],
      transparency: true,
      max_output_count: 3,
      price_upper_bound: { currency: 'USD', per_output_amount_minor: 14, pricing_revision: 'openai-gpt-image-2-2026-07-23' },
    },
    worker_env_source: { variable: 'RELAY_IMAGE_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'relay/app.ts', status: 'verified' },
  },
  {
    model_id: 'doubao-seedream-4-5-251128',
    provider: 'bytedance-ark',
    capabilities: ['ImageGeneration'],
    workload_bindings: [{
      workload: 'image_generation',
      capacity_pool: 'seedream-image-account',
      quota_bucket: 'relay.image-paid',
      execution_runtime: 'image-relay',
      credential_slot: 'image-relay.seedream',
    }],
    image_generation: {
      operation_modes: ['generate', 'edit'],
      max_reference_images: 8,
      reference_roles: ['subject', 'product', 'character', 'style', 'composition', 'environment', 'brand', 'logo', 'qrcode'],
      reference_preservations: ['may_change', 'prefer_preserve', 'must_preserve', 'exact'],
      supported_sizes: ['2048x2048', '2304x1728', '1728x2304', '2848x1600', '1600x2848', '2496x1664', '1664x2496', '3136x1344', '4096x4096', '4704x3520', '3520x4704', '5504x3040', '3040x5504', '4992x3328', '3328x4992', '6240x2656', '2352x1568', '1568x2352', '1680x2240', '2240x1680', '1536x2736', '2736x1536', '1216x3040', '3040x1216'],
      transparency: false,
      max_output_count: 3,
      price_upper_bound: { currency: 'USD', per_output_amount_minor: 10, pricing_revision: 'ark-seedream-4.5-2026-07-23' },
    },
    worker_env_source: { variable: 'RELAY_SEEDREAM_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'relay/app.ts', status: 'verified' },
  },
  {
    model_id: 'fun-asr-flash-2026-06-15',
    provider: 'dashscope',
    capabilities: ['SpeechTranscription'],
    workload_bindings: [{
      workload: 'speech_transcription',
      default_for_workload: true,
      capacity_pool: 'funasr-account',
      quota_bucket: 'gateway.speech-transcription',
      execution_runtime: 'gateway',
      credential_slot: 'gateway.funasr',
    }, {
      workload: 'video_speech_transcription',
      default_for_workload: true,
      capacity_pool: 'video-dashscope-account',
      capacity_lane: 'asr',
      quota_bucket: 'video-relay.account',
      execution_runtime: 'video-media-relay',
      credential_slot: 'video-relay.dashscope',
    }],
    worker_env_source: { variable: 'GW_FUNASR_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'gateway/transcription.ts', status: 'verified' },
  },
  {
    model_id: 'fun-asr',
    provider: 'dashscope',
    capabilities: ['SpeechTranscription'],
    workload_bindings: [{
      workload: 'video_speech_transcription',
      capacity_pool: 'video-dashscope-account',
      capacity_lane: 'asr',
      quota_bucket: 'video-relay.account',
      execution_runtime: 'video-media-relay',
      credential_slot: 'video-relay.dashscope',
    }],
    worker_env_source: { variable: 'VIDEO_MEDIA_DASHSCOPE_LONG_ASR_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'video-media-relay/providers/dashscope.ts', status: 'verified' },
  },
  {
    model_id: 'qwen3.6-flash',
    provider: 'dashscope',
    capabilities: ['MediaReasoning'],
    workload_bindings: [{
      workload: 'video_media_reasoning',
      default_for_workload: true,
      capacity_pool: 'video-dashscope-account',
      capacity_lane: 'reasoning',
      quota_bucket: 'video-relay.account',
      execution_runtime: 'video-media-relay',
      credential_slot: 'video-relay.dashscope',
    }],
    worker_env_source: { variable: 'VIDEO_MEDIA_DASHSCOPE_REASONING_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'video-media-relay/providers/dashscope.ts', status: 'verified' },
  },
  {
    model_id: 'text-embedding-v4',
    provider: 'dashscope',
    capabilities: ['SemanticEmbedding'],
    workload_bindings: [{
      workload: 'video_semantic_embedding',
      default_for_workload: true,
      capacity_pool: 'video-dashscope-account',
      capacity_lane: 'embedding',
      quota_bucket: 'video-relay.account',
      execution_runtime: 'video-media-relay',
      credential_slot: 'video-relay.dashscope',
    }],
    worker_env_source: { variable: 'VIDEO_MEDIA_DASHSCOPE_EMBEDDING_MODEL', slot_aliases: [] },
    body_caps: { ...DEFAULT_BODY_CAPS },
    resume_evidence: { path: 'video-media-relay/providers/dashscope.ts', status: 'verified' },
  },
] as const

/** Runtime immutability matters: this is a process-wide fact source consumed by
 * tests and multiple services, not merely a compile-time readonly suggestion. */
export const MANAGED_MODEL_CATALOG: readonly ManagedModelCatalogEntry[] = deepFreeze(
  MANAGED_MODEL_CATALOG_SOURCE,
)

export function managedModelsForCapability(capability: ProviderCapability): ManagedModelCatalogEntry[] {
  return MANAGED_MODEL_CATALOG.filter(entry => entry.capabilities.includes(capability))
}

export function managedModelsForWorkload(workload: ManagedModelWorkload): ManagedModelCatalogEntry[] {
  return MANAGED_MODEL_CATALOG.filter(entry => entry.workload_bindings.some(binding => binding.workload === workload))
}

export function defaultManagedModelForWorkload(workload: ManagedModelWorkload): ManagedModelCatalogEntry {
  const defaults = MANAGED_MODEL_CATALOG.filter(entry => entry.workload_bindings.some(
    binding => binding.workload === workload && binding.default_for_workload === true,
  ))
  if (defaults.length !== 1) throw new Error(`model catalog must contain exactly one default for ${workload}`)
  return defaults[0]!
}

export function managedModelById(modelId: string | undefined): ManagedModelCatalogEntry | undefined {
  const normalized = modelId?.trim()
  return normalized ? MANAGED_MODEL_CATALOG.find(entry => entry.model_id === normalized) : undefined
}
