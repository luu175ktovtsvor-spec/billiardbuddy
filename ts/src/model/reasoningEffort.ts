export type ReasoningEffort = 'low' | 'medium' | 'high'

/**
 * cc-haha v0.4.5 修了 reasoning effort 透传。这里把 UI/配置里可能出现的
 * max 归一成 OpenAI-compatible 端点能理解的 high。
 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  if (value === 'max') return 'high'
  return undefined
}
