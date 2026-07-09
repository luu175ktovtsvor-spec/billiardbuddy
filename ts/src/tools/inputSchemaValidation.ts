import type { JSONSchema } from './Tool'

/**
 * 工具入参运行时校验(对齐 cc `toolExecution.ts` 的 `inputSchema.safeParse(input)` 时机与
 * `<tool_use_error>InputValidationError: ...</tool_use_error>` 格式):在权限判定/执行前统一挡一道,
 * 让模型第一时间拿到结构化、格式一致的入参错误,而不是让脏参数流进各工具零散的手写防御或崩到通用异常。
 *
 * **刻意保守**:JSONSchema 里只做两类确定性检查——缺 required 字段、已声明属性的**基本类型**不符;
 * 未声明的属性、union/未知类型、嵌套约束一律放行,避免误伤合法调用(cc 用 zod 严格校验,我们的工具是
 * 宽松 JSONSchema,过严会把本可正常执行的调用挡下)。
 */
export function validateToolInput(schema: JSONSchema | undefined, input: unknown): string | null {
  if (!schema || schema.type !== 'object') return null
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return '入参必须是一个 JSON 对象(object)。'
  }
  const record = input as Record<string, unknown>

  for (const key of schema.required ?? []) {
    if (record[key] === undefined) return `缺少必填参数 "${key}"。`
  }

  const properties = schema.properties ?? {}
  for (const [key, rawProp] of Object.entries(properties)) {
    const value = record[key]
    if (value === undefined) continue
    const expected = rawProp && typeof rawProp === 'object' ? (rawProp as Record<string, unknown>).type : undefined
    const err = checkPrimitiveType(value, expected, key)
    if (err) return err
  }
  return null
}

function checkPrimitiveType(value: unknown, expected: unknown, key: string): string | null {
  if (typeof expected !== 'string') return null // 未声明 / union(数组) / 复杂类型 → 放行
  const ok = (() => {
    switch (expected) {
      case 'string': return typeof value === 'string'
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'boolean': return typeof value === 'boolean'
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'array': return Array.isArray(value)
      case 'null': return value === null
      default: return true // 未知类型标注 → 放行
    }
  })()
  return ok ? null : `参数 "${key}" 类型应为 ${expected}。`
}
