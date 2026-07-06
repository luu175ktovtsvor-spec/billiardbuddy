import type { Model } from '../types/model'
import { ProxyModel, type FetchLike } from '../proxy/ProxyModel'
import { AnthropicMessagesModel } from './AnthropicMessagesModel'
import { createNetworkAwareFetch, type NetworkSettings } from './networkSettings'
import type { RuntimeProviderConfig } from './providerConfig'

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
