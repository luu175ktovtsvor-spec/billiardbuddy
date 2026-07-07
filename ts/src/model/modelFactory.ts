import type { Model } from '../types/model'
import { ProxyModel, type FetchLike } from '../proxy/ProxyModel'
import { AnthropicMessagesModel } from './AnthropicMessagesModel'
import { createNetworkAwareFetch, type NetworkSettings } from './networkSettings'
import type { RuntimeProviderConfig } from './providerConfig'
import { FallbackModel, type FallbackModelCandidate } from './FallbackModel'

export function createModelFromProviderConfig(
  config: RuntimeProviderConfig,
  opts: { fetchImpl?: FetchLike; networkSettings?: NetworkSettings } = {},
): Model {
  const fetchImpl = opts.fetchImpl ?? (
    config.networkSettings || opts.networkSettings
      ? createNetworkAwareFetch(opts.networkSettings ?? config.networkSettings!)
      : undefined
  )

  if (config.apiFormat === 'anthropic') {
    return new AnthropicMessagesModel({
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      authToken: config.authToken,
      authStrategy: config.authStrategy,
      maxTokens: config.maxTokens,
      requestTimeoutMs: config.requestTimeoutMs,
      fetchImpl,
    })
  }

  if (!config.apiKey) throw new Error('OpenAI-compatible provider 缺少 apiKey')
  return new ProxyModel({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    imageContentMode: config.imageContentMode,
    idleTimeoutMs: config.idleTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    reasoningEffort: config.reasoningEffort,
    fetchImpl,
  })
}

export function createModelFromProviderCandidates(
  candidates: Array<{ label: string; config: RuntimeProviderConfig; onFailure?: (err: unknown) => void; onSuccess?: () => void }>,
  opts: { fetchImpl?: FetchLike; networkSettings?: NetworkSettings } = {},
): Model {
  if (candidates.length === 0) throw new Error('model provider not configured')
  const models: FallbackModelCandidate[] = candidates.map(candidate => ({
    label: candidate.label,
    model: createModelFromProviderConfig(candidate.config, opts),
    onFailure: candidate.onFailure,
    onSuccess: candidate.onSuccess,
  }))
  return models.length === 1 ? models[0]!.model : new FallbackModel(models)
}
