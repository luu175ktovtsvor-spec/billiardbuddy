import { normalizeModelContextKey } from './modelContextWindows'

/**
 * ⭐ per-model 自动压缩触发点登记表(换模型 / 改压缩点就改这里,集中一处)。
 *
 * 背景:cc 的默认公式是「有效窗口 − 13k 固定 buffer」,对 200k 级窗口合适;但对 1M 级超大窗口
 * 这个固定 13k buffer 不成比例(1M → 触发点 ~967k,几乎撑满才压),owner 要更早触发。此表让每个模型
 * 单独登记压缩触发点,只影响登记过的模型;没登记的模型 compaction.ts 一律保持 cc 公式、行为不变。
 *
 * 登记值语义(单个 number):
 *   - 0 < v ≤ 1  → **比例**:触发阈值 = 有效窗口 × v(如 0.7 = 有效窗口用到 70% 就压)。
 *   - v > 1      → **绝对 token 阈值**:触发阈值 = v(封顶有效窗口)。
 *
 * 优先级(见 compaction.getAutoCompactTokenThreshold):
 *   env 覆盖(CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)> 本表登记 > cc 默认公式。
 */
const DIRECT_COMPACTION_TRIGGERS: Record<string, number> = {
  // MiMo 2.5 = 1M 窗口。owner 只接 MiMo 2.5,要 700K 自动压缩(绝对值 = owner 原话的精确 700K,
  // 不用 cc 的 ~967k、也不用 0.7×有效窗口的 686k)。想改压缩点:换成别的绝对值或比例(0<v≤1)即可,一处改全局。
  'mimo-v2.5': 700_000,
}

/**
 * 查某模型登记的压缩触发值(比例或绝对)。未登记返回 undefined。
 * 匹配与 modelContextWindows 一致:先精确 key,再按 `/名` `:名` 后缀兜底(供应商前缀 / :tag 变体)。
 */
export function getModelCompactionTrigger(model: string | undefined): number | undefined {
  if (!model) return undefined
  const key = normalizeModelContextKey(model)
  const exact = DIRECT_COMPACTION_TRIGGERS[key]
  if (exact !== undefined) return exact
  for (const [configuredModel, value] of Object.entries(DIRECT_COMPACTION_TRIGGERS)) {
    if (key.endsWith(`/${configuredModel}`) || key.endsWith(`:${configuredModel}`)) return value
  }
  return undefined
}

/**
 * 把登记值解成绝对 token 阈值(纯函数,便于单测两条分支)。
 * ratio(0<v≤1)→ floor(有效窗口 × v);absolute(v>1)→ floor(v);两者都封顶有效窗口,避免阈值反超窗口。
 */
export function compactionThresholdFromTrigger(triggerValue: number, effectiveContextWindow: number): number {
  const raw = triggerValue <= 1 ? Math.floor(effectiveContextWindow * triggerValue) : Math.floor(triggerValue)
  return Math.min(raw, effectiveContextWindow)
}

/**
 * 某模型有登记 → 返回其绝对 token 触发阈值(基于传入的有效窗口);没登记或值非法 → 返回 undefined
 * (调用方据此回退 cc 默认公式)。
 */
export function resolveModelCompactionThreshold(model: string | undefined, effectiveContextWindow: number): number | undefined {
  const trigger = getModelCompactionTrigger(model)
  if (trigger === undefined || !(trigger > 0)) return undefined
  return compactionThresholdFromTrigger(trigger, effectiveContextWindow)
}
