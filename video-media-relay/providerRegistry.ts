import type { CreateVideoRelayOperationRequest } from './contracts/relayApi.ts'

export type VideoProviderDescriptor = {
  capability: CreateVideoRelayOperationRequest['capability']
  application_roles: string[]
  model_id: string
  region: 'cn-beijing'
  schema_version: number
}

/** Video-only registry. It must never be folded back into the Agent Gateway. */
export const VIDEO_MEDIA_PROVIDER_REGISTRY: readonly VideoProviderDescriptor[] = [
  { capability: 'visual_evidence', application_roles: ['shot_evidence'], model_id: 'qwen3-vl-flash', region: 'cn-beijing', schema_version: 1 },
  { capability: 'media_reasoning', application_roles: ['planning', 'caption_translation'], model_id: 'qwen3.6-flash', region: 'cn-beijing', schema_version: 1 },
  { capability: 'speech_transcription', application_roles: ['asr'], model_id: 'fun-asr-flash-2026-06-15', region: 'cn-beijing', schema_version: 1 },
  { capability: 'semantic_embedding', application_roles: ['search_index'], model_id: 'text-embedding-v4', region: 'cn-beijing', schema_version: 1 },
]

export function videoProviderFor(request: CreateVideoRelayOperationRequest): VideoProviderDescriptor {
  const entry = VIDEO_MEDIA_PROVIDER_REGISTRY.find(item => item.capability === request.capability && item.application_roles.includes(request.application_role))
  if (!entry) throw new Error('video_provider_not_registered')
  if (request.capability === 'speech_transcription' && request.input.mode === 'long_async') {
    return { ...entry, model_id: 'fun-asr' }
  }
  return entry
}
