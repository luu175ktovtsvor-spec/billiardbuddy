export type ReasoningEffort = 'low' | 'medium' | 'high'

/**
 * reasoning effort 透传:这里把 UI/配置里可能出现的
 * max 归一成 OpenAI-compatible 端点能理解的 high。
 */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  if (value === 'max') return 'high'
  return undefined
}

/**
 * Anthropic Messages API 的 thinking 参数(线格式,snake_case)。
 * - adaptive:现代 Claude(4.6+/4.7/4.8、fable、mythos)的推荐档,不带预算、模型自行决定思考深浅。
 * - enabled + budget_tokens:旧 Claude 族(sonnet-4-5/haiku/opus-4-5 等)与非 adaptive 的第三方(minimax)用。
 */
export type AnthropicThinkingParam =
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }

/** OpenAI-compat 端点的 reasoning effort 档 → 走 budget_tokens 模型时的 thinking 预算目标值(实际再按 max_tokens 夹紧)。 */
const EFFORT_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
}

/** Anthropic API 对 thinking.budget_tokens 的硬下限(< 1024 直接 400)。 */
const MIN_THINKING_BUDGET = 1_024

/**
 * 该模型的 thinking 走 adaptive 还是 budget_tokens——对齐 cc-haha `modelSupportsAdaptiveThinking` 的判定思路。
 * ⚠️ 现代 Claude(opus/sonnet 4.6+、4.7、4.8、fable、mythos)必须走 adaptive:对它们发 `{type:'enabled',budget_tokens}`
 * 会返回 400(见 Anthropic API drift)。旧 Claude 族与 minimax 等只认 budget_tokens。未知(非 Claude 的 Anthropic
 * 兼容端点)保守用 budget_tokens。
 */
export function anthropicModelUsesAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase()
  // 已知需 budget_tokens(不支持 adaptive)的:旧 Claude 族 + 非 adaptive 第三方。
  if (
    m.includes('claude-3') ||
    m.includes('haiku') ||
    m.includes('sonnet-4-5') || m.includes('sonnet-4-0') ||
    m.includes('opus-4-5') || m.includes('opus-4-1') || m.includes('opus-4-0') ||
    m.includes('minimax')
  ) return false
  // 现代 Claude → adaptive。
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('fable') || m.includes('mythos')) return true
  // 其它未知端点 → 保守 budget_tokens。
  return false
}

/**
 * 把"深度思考/增强"档(reasoningEffort)映射成 Anthropic thinking 参数(对齐 cc-haha services/api/claude.ts 的
 * adaptive 优先、budget_tokens 兜底选择)。
 * - 没选(reasoningEffort 未设)→ undefined,请求不带 thinking(与旧行为一致,不强制思考)。
 * - adaptive 模型 → `{type:'adaptive'}`(不带预算)。
 * - budget_tokens 模型 → budget 取 effort 目标值,并夹紧到 `< max_tokens` 且给答复留出至少一半空间;
 *   夹紧后 < 1024(max_tokens 太小放不下 thinking)则返回 undefined,跳过 thinking 以免 400 或答复被思考挤爆。
 */
export function buildAnthropicThinking(
  reasoningEffort: ReasoningEffort | undefined,
  model: string,
  maxTokens: number,
): AnthropicThinkingParam | undefined {
  if (!reasoningEffort) return undefined
  if (anthropicModelUsesAdaptiveThinking(model)) return { type: 'adaptive' }
  // budget_tokens 路径:给答复保留至少一半 max_tokens,再按 effort 目标值夹紧(对齐 cc 的 Math.min 夹紧,但预留答复空间)。
  const answerReserve = Math.max(MIN_THINKING_BUDGET, Math.floor(maxTokens / 2))
  const budget = Math.min(EFFORT_THINKING_BUDGET[reasoningEffort], maxTokens - answerReserve)
  if (budget < MIN_THINKING_BUDGET) return undefined
  return { type: 'enabled', budget_tokens: budget }
}
