// Provider 运行时装配与白标护栏:候选模型工厂、错误脱敏、状态码映射和 BYOK 校验。

import { createModelFromProviderCandidates } from '../model/modelFactory'
import { PUBLIC_TEXT_CHANNEL, scrubProviderIdentifiers } from '../model/publicModelNames'
import type { RuntimeProviderResolution } from './services/providerService'
import type { Model } from '../types/model'
import type { FetchLike } from '../proxy/ProxyModel'

export function runtimeProviderLabel(runtime: RuntimeProviderResolution): string {
  // 白标：saved-provider 用用户自设的名字（用户自建 BYOK、自己知道），
  // env/内置出口一律给中性代称，绝不回显 `环境变量:<真实模型>`。
  if (runtime.source === 'saved-provider') return runtime.providerName || runtime.providerId || PUBLIC_TEXT_CHANNEL.builtin
  return PUBLIC_TEXT_CHANNEL.builtin
}

export function runtimeProviderKey(runtime: RuntimeProviderResolution): string {
  if (runtime.source === 'saved-provider' && runtime.providerId) return `saved:${runtime.providerId}`
  return `${runtime.source}:${runtime.config.apiFormat}:${runtime.config.baseUrl}:${runtime.config.model}`
}

export function sanitizeProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // 白标：除清 Bearer/api-key 外，再过 scrubProviderIdentifiers 清掉真实模型名/供应商/endpoint，
  // 保证这条错误进 health.lastError / 失败旁白后不泄底。
  return scrubProviderIdentifiers(
    raw
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'),
  ).slice(0, 180)
}

export function createModelFromRuntimeProviders(
  runtimes: RuntimeProviderResolution[],
  fetchImpl?: FetchLike,
  health?: {
    onFailure?: (runtime: RuntimeProviderResolution, err: unknown) => void
    onSuccess?: (runtime: RuntimeProviderResolution) => void
  },
): Model {
  return createModelFromProviderCandidates(
    runtimes.map(runtime => ({
      label: runtimeProviderLabel(runtime),
      config: runtime.config,
      onFailure: err => health?.onFailure?.(runtime, err),
      onSuccess: () => health?.onSuccess?.(runtime),
    })),
    { fetchImpl },
  )
}

export const LEGACY_BYOK_TEXT_PROVIDER_ID = 'byok-text'

export function validateImageModelPayload(body: Record<string, unknown>) {
  // 白标：BYOK 生图设置校验只回一个通用结论，绝不回显真实 provider 名或 known_models
  // （原来会吐 openai/volcengine + gpt-image-2/doubao-seedream-* 硬编码真名）。
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) {
    return { ok: false, level: 'warning', message: '缺少生图模型名。' }
  }
  return { ok: true, level: 'info', message: '已记录生图模型设置。' }
}

export function providerStatusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('not found')) return 404
  if (message.includes('already exists')) return 409
  if (message.includes('cannot delete active')) return 409
  if (message.includes('cannot activate disabled')) return 409
  if (message.includes('required') || message.includes('unsupported') || message.includes('非法')) return 400
  return 500
}
