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
 * - adaptive:现代 Claude(4.6+/4.7/4.8、fable、mythos)+ MiniMax 官方 Anthropic 兼容端点的推荐档,不带预算、模型自行决定思考深浅。
 * - enabled + budget_tokens:旧 Claude 族(sonnet-4-5/haiku/opus-4-5 等)与其它未知端点(含 Xiaomi MiMo 的 anthropic 端点)兜底。
 */
export type AnthropicThinkingParam =
  | { type: 'adaptive' }
  | { type: 'enabled'; budget_tokens: number }

/** thinking 线格式三选一:adaptive(不带预算)/ budget(enabled+budget_tokens)/ off(不带 thinking)。 */
export type AnthropicThinkingMode = 'adaptive' | 'budget' | 'off'

/**
 * env 覆盖兜底(模型无关逃生舱):`ANTHROPIC_THINKING_MODE` = adaptive | budget | off(别名 enabled / disabled / none)。
 * 设了就无条件覆盖 per-model 判定——接任何非 Claude 的 Anthropic 兼容端点(MiMo-anthropic 只吃 {type:enabled}、
 * 某端点只吃 adaptive、或想彻底关思考)时不改代码、用 env 掰对。非法值当没设。
 */
export function thinkingModeEnvOverride(
  env: Record<string, string | undefined> = process.env,
): AnthropicThinkingMode | undefined {
  const v = env.ANTHROPIC_THINKING_MODE?.trim().toLowerCase()
  if (!v) return undefined
  if (v === 'adaptive') return 'adaptive'
  if (v === 'budget' || v === 'enabled') return 'budget'
  if (v === 'off' || v === 'disabled' || v === 'none') return 'off'
  return undefined
}

/** Anthropic API 对 thinking.budget_tokens 的硬下限(< 1024 直接 400)。 */
const MIN_THINKING_BUDGET = 1_024

/** env 真值判定(1/true/yes/on,大小写无关)。 */
function isEnvTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '')
}

/**
 * 等价 cc 的 `CLAUDE_CODE_DISABLE_THINKING`:置真值(1/true/yes/on)时彻底不发 thinking。
 * 我们额外把 `ANTHROPIC_THINKING_MODE=off`(别名 disabled/none)也当同义关闭——两者任一命中即关。
 * 对齐 cc claude.ts:1653-1655 的 `hasThinking = … && !isEnvTruthy(CLAUDE_CODE_DISABLE_THINKING)`。
 */
function isThinkingDisabledByEnv(env: Record<string, string | undefined>): boolean {
  return isEnvTruthy(env.CLAUDE_CODE_DISABLE_THINKING) || thinkingModeEnvOverride(env) === 'off'
}

/**
 * 该模型的 thinking 走 adaptive 还是 budget_tokens——对齐 cc-haha `modelSupportsAdaptiveThinking` + 各厂商官方文档。
 * ⚠️查证结论(2026-07 官方文档,报告有出处):
 *  - MiniMax 官方 Anthropic 兼容端点(api.minimaxi.com/anthropic)只认 `thinking:{type:'adaptive'}` / `{type:'disabled'}`,
 *    【不认 budget_tokens】→ minimax 必须 adaptive(cc-haha minimax preset 也声明 capabilities=thinking,adaptive_thinking)。
 *  - 现代 Claude(opus/sonnet 4.6+、4.7、4.8、fable、mythos)对 `{type:'enabled',budget_tokens}` 会 400 → adaptive。
 *  - 旧 Claude 族(haiku、sonnet-4-5、opus-4-5/4-1/4-0、claude-3)只认 budget_tokens。
 *  - 其它未知端点(含 Xiaomi MiMo 的 anthropic 端点,它只认 {type:enabled|disabled})→ 保守 budget(type:enabled,
 *    多数端点会忽略多余的 budget_tokens);拿不准就用 `ANTHROPIC_THINKING_MODE` env 掰。
 */
export function anthropicModelUsesAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase()
  // 已知需 budget_tokens(不支持 adaptive)的:旧 Claude 族。
  if (
    m.includes('claude-3') ||
    m.includes('haiku') ||
    m.includes('sonnet-4-5') || m.includes('sonnet-4-0') ||
    m.includes('opus-4-5') || m.includes('opus-4-1') || m.includes('opus-4-0')
  ) return false
  // MiniMax 官方 Anthropic 兼容端点只认 adaptive(不认 budget_tokens)。
  if (m.includes('minimax')) return true
  // 现代 Claude → adaptive。
  if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('fable') || m.includes('mythos')) return true
  // 其它未知端点 → 保守 budget_tokens。
  return false
}

/**
 * 生成 Anthropic Messages API 的 thinking 参数——对齐 cc-haha services/api/claude.ts:1653-1736 的
 * 「**thinking 默认开、与 reasoningEffort 解耦**」:
 *  - **默认就发 thinking**(不再由是否选了深度思考档决定;cc 里 `thinkingConfig` 默认 enabled、effort 是独立的
 *    output_config 参数,不决定是否/如何思考)。adaptive 模型 → `{type:'adaptive'}`(不带预算);
 *    budget 模型 → `{type:'enabled', budget_tokens: 模型默认预算}`。
 *  - **仅等价 `CLAUDE_CODE_DISABLE_THINKING`(或 `ANTHROPIC_THINKING_MODE=off`)时才不发**(返回 undefined)。
 *  - adaptive vs budget 的选择:`ANTHROPIC_THINKING_MODE`(adaptive|budget)env 覆盖优先,未设按 per-model 判定。
 *  - 模型默认预算:对齐 cc `getMaxThinkingTokensForModel` + `Math.min(maxTokens-1, …)`——我们无 per-model thinking
 *    预算登记,默认取尽可能大 = `maxTokens-1`(cc 的夹紧下限)。maxTokens 太小(预算 < 1024)会 400 → 跳过 thinking。
 *
 * 注:reasoningEffort 不再进入本函数——它是"深度思考档",在 OpenAI 兼容端点(ProxyModel)按 reasoning_effort 透传,
 * 在 Anthropic 端点映射成 output_config.effort 是后续项(见任务 #68),与"是否/如何 thinking"是两回事。
 */
export function buildAnthropicThinking(
  model: string,
  maxTokens: number,
  env: Record<string, string | undefined> = process.env,
): AnthropicThinkingParam | undefined {
  // 仅在等价 CLAUDE_CODE_DISABLE_THINKING / ANTHROPIC_THINKING_MODE=off 时不发 thinking;其余一律默认开。
  if (isThinkingDisabledByEnv(env)) return undefined
  // env 覆盖优先(off 已在上面拦掉,此处只余 adaptive | budget | undefined);未覆盖时按 per-model 判定。
  const override = thinkingModeEnvOverride(env)
  const useAdaptive = override ? override === 'adaptive' : anthropicModelUsesAdaptiveThinking(model)
  if (useAdaptive) return { type: 'adaptive' }
  // budget_tokens 模型:发模型默认预算(= maxTokens-1,对齐 cc 的 Math.min(maxTokens-1, 模型上限-1) 夹紧)。
  // maxTokens 太小(预算 < 1024)放不下 thinking → 跳过以免 400。
  const budget = maxTokens - 1
  if (budget < MIN_THINKING_BUDGET) return undefined
  return { type: 'enabled', budget_tokens: budget }
}
