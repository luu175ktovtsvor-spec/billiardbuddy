/** 稳定序列化:递归按键排序 + 紧凑,保证同一值恒等字符串(actionKey 与 HMAC 规范化共用)。 */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(sort)
    const o = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o).sort()) out[k] = sort(o[k])
    return out
  }
  return JSON.stringify(sort(value))
}
