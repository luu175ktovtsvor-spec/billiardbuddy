import type { JSONSchema } from './Tool'

/**
 * 工具入参运行时校验(对齐 cc `toolExecution.ts:615` 的 `tool.inputSchema.safeParse(input)` 时机与
 * `<tool_use_error>InputValidationError: ...</tool_use_error>` 格式):在权限判定/执行前统一挡一道,
 * 让模型第一时间拿到结构化、格式一致的入参错误(回灌让模型自救,别让脏参数流进各工具零散的手写防御或崩循环)。
 *
 * **强度对齐 cc 的两档**:
 * - **内建工具 = cc `z.strictObject`**:顶层未知键拒绝 + 已声明属性递归校验(enum 取值 / 嵌套对象 required /
 *   数组元素类型 / number 范围 / union 类型任一命中)。这是把老实现「只查 required + 顶层基本类型」的分叉掰回 cc。
 * - **MCP 工具 = cc `z.object({}).passthrough()`**:外部 server 自定义 schema,顶层未知键放行(passthrough),
 *   只对已声明属性做类型/取值校验、不因多带字段误杀。调用方对 `mcp__` 前缀工具传 `{ strict: false }`。
 *
 * **保守边界(避免误伤合法调用)**:
 * - 顶层 strictObject 只在「本层声明了 properties」时拒未知键;free-form 对象(无 properties,如 repl 的 input、
 *   verify 的 evidence 元素)按 record 放行。
 * - 嵌套对象默认「剥离未知键」(对齐 zod 内层 `z.object` 默认 strip、不 reject),只有嵌套 schema 显式
 *   `additionalProperties:false` 才拒未知键。
 * - `additionalProperties:true` 或对象 schema → 放行(对象 schema 会用它校验多出来的值)。
 * - union 类型数组 `['boolean','string']` → 命中任一即通过;未知/未声明 type → 放行。
 */

type SchemaNode = Record<string, unknown>

export interface ValidateToolInputOptions {
  /**
   * 顶层是否按 cc `z.strictObject` 拒绝未知键。内建工具默认 true;MCP 工具(`mcp__` 前缀)传 false 走
   * passthrough(对齐 cc `z.object({}).passthrough()`)。仅影响「顶层未知键」判定,不影响已声明属性的类型/取值校验。
   */
  strict?: boolean
}

export function validateToolInput(
  schema: JSONSchema | undefined,
  input: unknown,
  options: ValidateToolInputOptions = {},
): string | null {
  if (!schema || schema.type !== 'object') return null
  if (!isPlainObject(input)) return '入参必须是一个 JSON 对象(object)。'
  const strict = options.strict !== false
  return validateObjectNode(schema as SchemaNode, input, '', strict)
}

/** 递归校验单个值:enum → type(含 union)→ 命中类型后做结构/范围深校验。 */
function validateValue(node: SchemaNode, value: unknown, path: string): string | null {
  const label = path || '(根)'

  const enumVals = node.enum
  if (Array.isArray(enumVals)) {
    if (enumVals.some(candidate => candidate === value)) return null
    return `参数 "${label}" 取值必须是 ${enumVals.map(v => JSON.stringify(v)).join(' / ')} 之一(收到 ${JSON.stringify(value)})。`
  }

  const declared = node.type
  const types = Array.isArray(declared)
    ? declared
    : typeof declared === 'string'
      ? [declared]
      : []

  if (types.length === 0) {
    // 无 type 声明:若声明了 properties/items 仍按结构尝试校验,否则放行(保守不误伤)。
    if (isPlainObject(node.properties) && isPlainObject(value)) return validateObjectNode(node, value, path, false)
    if (isPlainObject(node.items) && Array.isArray(value)) return validateArrayNode(node, value, path)
    return null
  }

  const matched = types.find(t => matchesType(value, t))
  if (matched === undefined) {
    return `参数 "${label}" 类型应为 ${types.join(' 或 ')}。`
  }

  if (matched === 'object') return validateObjectNode(node, value as Record<string, unknown>, path, false)
  if (matched === 'array') return validateArrayNode(node, value as unknown[], path)
  if (matched === 'number' || matched === 'integer') return validateNumberRange(node, value as number, path)
  return null
}

function validateObjectNode(node: SchemaNode, obj: Record<string, unknown>, path: string, strict: boolean): string | null {
  const prefix = path ? `${path}.` : ''

  for (const key of asStringArray(node.required)) {
    if (obj[key] === undefined) return `缺少必填参数 "${prefix}${key}"。`
  }

  const properties = isPlainObject(node.properties) ? (node.properties as Record<string, SchemaNode>) : undefined
  const additional = node.additionalProperties

  // 未知键判定:显式 additionalProperties:false → 恒拒;显式 true / 对象 schema → 恒放行;
  // 未声明 → 仅「本层 strict 且声明了 properties」时拒(顶层内建=strictObject,嵌套默认放行)。
  const rejectUnknown =
    additional === false ? true : additional === true || isPlainObject(additional) ? false : strict && !!properties
  if (rejectUnknown && properties) {
    for (const key of Object.keys(obj)) {
      if (!(key in properties)) {
        return `不允许的未知参数 "${prefix}${key}"(该工具不接受此字段)。`
      }
    }
  }

  if (properties) {
    for (const [key, rawProp] of Object.entries(properties)) {
      const value = obj[key]
      if (value === undefined) continue
      if (!isPlainObject(rawProp)) continue
      const err = validateValue(rawProp, value, `${prefix}${key}`)
      if (err) return err
    }
  }

  // additionalProperties 为 schema 对象时,校验未声明的多余键的值。
  if (isPlainObject(additional)) {
    for (const [key, value] of Object.entries(obj)) {
      if (properties && key in properties) continue
      const err = validateValue(additional as SchemaNode, value, `${prefix}${key}`)
      if (err) return err
    }
  }

  return null
}

function validateArrayNode(node: SchemaNode, arr: unknown[], path: string): string | null {
  const items = node.items
  if (isPlainObject(items)) {
    for (let i = 0; i < arr.length; i++) {
      const err = validateValue(items as SchemaNode, arr[i], `${path}[${i}]`)
      if (err) return err
    }
  }
  return null
}

function validateNumberRange(node: SchemaNode, value: number, path: string): string | null {
  const label = path || '(根)'
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = node as {
    minimum?: unknown
    maximum?: unknown
    exclusiveMinimum?: unknown
    exclusiveMaximum?: unknown
  }
  if (typeof minimum === 'number' && value < minimum) return `参数 "${label}" 不能小于 ${minimum}(收到 ${value})。`
  if (typeof maximum === 'number' && value > maximum) return `参数 "${label}" 不能大于 ${maximum}(收到 ${value})。`
  if (typeof exclusiveMinimum === 'number' && value <= exclusiveMinimum) return `参数 "${label}" 必须大于 ${exclusiveMinimum}(收到 ${value})。`
  if (typeof exclusiveMaximum === 'number' && value >= exclusiveMaximum) return `参数 "${label}" 必须小于 ${exclusiveMaximum}(收到 ${value})。`
  return null
}

function matchesType(value: unknown, expected: unknown): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    default: return true // 未知类型标注 → 视为匹配(放行,保守不误伤)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
