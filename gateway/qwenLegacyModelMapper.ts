import { defaultProviderModel } from './providerRegistry'

/**
 * D3-only compatibility reader for persisted pre-BB-04C provider values.
 * It has no environment, network, key, or executable-provider dependency.
 */
const LEGACY_QWEN_MODEL_VALUES = new Set(['qwen3-coder-plus'])

export type LegacyQwenModelValue = string | undefined

export function mapLegacyQwenModelValue(
  value: LegacyQwenModelValue,
): string | undefined {
  const normalized = value?.trim()
  if (!normalized || !LEGACY_QWEN_MODEL_VALUES.has(normalized)) {
    return undefined
  }
  return defaultProviderModel()
}
