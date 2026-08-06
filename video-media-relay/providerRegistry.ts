import {
  defaultManagedModelForWorkload,
  managedModelsForWorkload,
} from '../ts/shared/product/modelCatalog.js'
import type { ManagedModelWorkload, ProviderWorkloadBinding } from '../ts/shared/product/providerContracts.js'
import type { CreateVideoRelayOperationRequest } from './contracts/relayApi.ts'

export type VideoProviderDescriptor = {
  capability: CreateVideoRelayOperationRequest['capability']
  application_roles: string[]
  model_id: string
  region: 'cn-beijing'
  schema_version: number
  workload: ManagedModelWorkload
  binding: ProviderWorkloadBinding
}

/**
 * This is deliberately only a protocol-role mapping. Model, provider account,
 * quota bucket, credential slot and capacity lane remain facts in the shared
 * managed model catalog; the Video Relay does not keep a second mutable list.
 */
const VIDEO_WORKLOADS: ReadonlyArray<{
  capability: CreateVideoRelayOperationRequest['capability']
  application_roles: string[]
  workload: ManagedModelWorkload
}> = [
  { capability: 'visual_evidence', application_roles: ['shot_evidence'], workload: 'video_visual_evidence' },
  { capability: 'media_reasoning', application_roles: ['planning'], workload: 'video_media_reasoning' },
  { capability: 'media_reasoning', application_roles: ['caption_translation'], workload: 'video_media_reasoning' },
  { capability: 'speech_transcription', application_roles: ['asr'], workload: 'video_speech_transcription' },
  { capability: 'semantic_embedding', application_roles: ['search_index'], workload: 'video_semantic_embedding' },
]

function descriptorForWorkload(
  capability: CreateVideoRelayOperationRequest['capability'],
  applicationRoles: string[],
  workload: ManagedModelWorkload,
  longAsr: boolean,
): VideoProviderDescriptor {
  const candidates = managedModelsForWorkload(workload).filter(entry => entry.workload_bindings.some(binding => (
    binding.workload === workload
    && binding.execution_runtime === 'video-media-relay'
    && binding.capacity_pool === 'video-dashscope-account'
    && binding.quota_bucket === 'video-relay.account'
    && binding.credential_slot === 'video-relay.dashscope'
  )))
  const model = longAsr
    ? candidates.filter(entry => !entry.workload_bindings.some(binding => binding.workload === workload && binding.default_for_workload)).at(0)
    : defaultManagedModelForWorkload(workload)
  if (!model || !candidates.some(candidate => candidate.model_id === model.model_id)) {
    throw new Error(`video_provider_not_registered:${workload}`)
  }
  const binding = model.workload_bindings.find(candidate => (
    candidate.workload === workload
    && candidate.execution_runtime === 'video-media-relay'
    && candidate.capacity_pool === 'video-dashscope-account'
  ))
  if (!binding?.capacity_lane) throw new Error(`video_provider_capacity_lane_missing:${workload}`)
  return {
    capability,
    application_roles: applicationRoles,
    model_id: model.model_id,
    region: 'cn-beijing',
    schema_version: 1,
    workload,
    binding,
  }
}

export function videoProviderFor(request: CreateVideoRelayOperationRequest): VideoProviderDescriptor {
  const role = VIDEO_WORKLOADS.find(item => item.capability === request.capability && item.application_roles.includes(request.application_role))
  if (!role) throw new Error('video_provider_not_registered')
  const longAsr = request.capability === 'speech_transcription' && request.input.mode === 'long_async'
  return descriptorForWorkload(role.capability, role.application_roles, role.workload, longAsr)
}
