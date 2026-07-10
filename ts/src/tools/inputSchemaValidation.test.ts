import { expect, test } from 'bun:test'
import { validateToolInput } from './inputSchemaValidation'
import type { JSONSchema } from './Tool'

const schema: JSONSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    flag: { type: 'boolean' },
    opts: { type: 'object' },
    tags: { type: 'array' },
  },
  required: ['path'],
}

// ---------------------------------------------------------------------------
// 基础:类型 / required / 非对象(保留原口径)
// ---------------------------------------------------------------------------

test('通过:合法入参', () => {
  expect(validateToolInput(schema, { path: 'a.txt' })).toBeNull()
  expect(validateToolInput(schema, { path: 'a', count: 3, ratio: 1.5, flag: true, opts: {}, tags: [] })).toBeNull()
})

test('拦截:缺 required 字段', () => {
  expect(validateToolInput(schema, {})).toContain('path')
  expect(validateToolInput(schema, { count: 3 })).toContain('path')
  expect(validateToolInput(schema, { path: undefined })).toContain('path')
})

test('拦截:已声明属性基本类型不符', () => {
  expect(validateToolInput(schema, { path: 123 })).toContain('path')
  expect(validateToolInput(schema, { path: 'a', count: 1.5 })).toContain('count') // integer 要整数
  expect(validateToolInput(schema, { path: 'a', flag: 'yes' })).toContain('flag')
  expect(validateToolInput(schema, { path: 'a', tags: 'not-array' })).toContain('tags')
  expect(validateToolInput(schema, { path: 'a', opts: [] })).toContain('opts') // 数组不是 object
})

test('拦截:入参非对象', () => {
  expect(validateToolInput(schema, null)).toContain('对象')
  expect(validateToolInput(schema, 'str')).toContain('对象')
  expect(validateToolInput(schema, [1, 2])).toContain('对象')
})

test('放行:无 schema / union 类型任一命中 / 无 type 声明(保守不误伤)', () => {
  expect(validateToolInput(undefined, { anything: 1 })).toBeNull()
  const looseSchema: JSONSchema = { type: 'object', properties: { x: { type: ['string', 'number'] }, y: {} }, required: [] }
  expect(validateToolInput(looseSchema, { x: 1 })).toBeNull() // union 命中 number
  expect(validateToolInput(looseSchema, { x: 'a' })).toBeNull() // union 命中 string
  expect(validateToolInput(looseSchema, { x: true })).toContain('x') // 两者都不命中 → 拒
  expect(validateToolInput(looseSchema, { y: { deep: true } })).toBeNull() // 无 type 声明 → 放行
})

// ---------------------------------------------------------------------------
// 行为对齐 cc `z.strictObject`(内建工具,默认 strict=true)
// ---------------------------------------------------------------------------

test('strictObject:顶层未知键拒绝(对齐 cc unrecognized_keys)', () => {
  const err = validateToolInput(schema, { path: 'a', bogus: 1 })
  expect(err).not.toBeNull()
  expect(err).toContain('bogus')
  // 合法入参不被未知键规则误杀
  expect(validateToolInput(schema, { path: 'a', count: 2 })).toBeNull()
})

test('strictObject:additionalProperties:true 或 free-form 对象放行未知键', () => {
  const openSchema: JSONSchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }
  expect(validateToolInput(openSchema, { a: 'x', extra: 1 })).toBeNull()
  // 无 properties 声明的对象 = record,顶层多带字段放行(repl input / evidence 元素这类)
  const recordSchema: JSONSchema = { type: 'object' }
  expect(validateToolInput(recordSchema, { whatever: 1, more: 'y' })).toBeNull()
})

test('enum:越界拒绝、命中通过', () => {
  const enumSchema: JSONSchema = {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } },
    required: ['mode'],
  }
  expect(validateToolInput(enumSchema, { mode: 'b' })).toBeNull()
  const err = validateToolInput(enumSchema, { mode: 'z' })
  expect(err).not.toBeNull()
  expect(err).toContain('mode')
})

test('数组元素类型:元素类型错拒绝、正确通过', () => {
  const arrSchema: JSONSchema = {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'integer' } } },
    required: ['ids'],
  }
  expect(validateToolInput(arrSchema, { ids: [1, 2, 3] })).toBeNull()
  const err = validateToolInput(arrSchema, { ids: [1, 'two', 3] })
  expect(err).not.toBeNull()
  expect(err).toContain('ids[1]')
})

test('数组元素为对象:嵌套 required 缺失拒绝(对齐 MultiEdit edits 结构)', () => {
  const editsSchema: JSONSchema = {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['edits'],
  }
  expect(validateToolInput(editsSchema, { edits: [{ old_string: 'x', new_string: 'y' }] })).toBeNull()
  // 深层缺字段
  const err = validateToolInput(editsSchema, { edits: [{ old_string: 'x' }] })
  expect(err).not.toBeNull()
  expect(err).toContain('new_string')
  // 深层类型错
  expect(validateToolInput(editsSchema, { edits: [{ old_string: 'x', new_string: 5 }] })).toContain('new_string')
})

test('嵌套对象:递归 required + 深层缺字段拒绝', () => {
  const nestedSchema: JSONSchema = {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'integer' } },
        required: ['file', 'line'],
      },
    },
    required: ['target'],
  }
  expect(validateToolInput(nestedSchema, { target: { file: 'a.ts', line: 3 } })).toBeNull()
  expect(validateToolInput(nestedSchema, { target: { file: 'a.ts' } })).toContain('line')
  expect(validateToolInput(nestedSchema, { target: { file: 'a.ts', line: 'x' } })).toContain('line')
})

test('嵌套对象:默认剥离未知键(不 reject,对齐 zod 内层 z.object)', () => {
  const nestedSchema: JSONSchema = {
    type: 'object',
    properties: {
      target: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
    },
    required: ['target'],
  }
  // 嵌套多带字段 → 放行(只有顶层 strictObject 拒未知键)
  expect(validateToolInput(nestedSchema, { target: { file: 'a.ts', extra: 1 } })).toBeNull()
})

test('嵌套对象:显式 additionalProperties:false 才拒未知键', () => {
  const strictNested: JSONSchema = {
    type: 'object',
    properties: {
      target: {
        type: 'object',
        properties: { file: { type: 'string' } },
        required: ['file'],
        additionalProperties: false,
      },
    },
    required: ['target'],
  }
  const err = validateToolInput(strictNested, { target: { file: 'a.ts', extra: 1 } })
  expect(err).not.toBeNull()
  expect(err).toContain('extra')
})

test('number 范围:minimum/maximum/exclusive 越界拒绝', () => {
  const rangeSchema: JSONSchema = {
    type: 'object',
    properties: {
      pct: { type: 'number', minimum: 0, maximum: 100 },
      pos: { type: 'integer', exclusiveMinimum: 0 },
    },
    required: [],
  }
  expect(validateToolInput(rangeSchema, { pct: 50, pos: 1 })).toBeNull()
  expect(validateToolInput(rangeSchema, { pct: -1 })).toContain('pct')
  expect(validateToolInput(rangeSchema, { pct: 101 })).toContain('pct')
  expect(validateToolInput(rangeSchema, { pos: 0 })).toContain('pos')
})

// ---------------------------------------------------------------------------
// 行为对齐 cc MCP `z.object({}).passthrough()`(strict=false)
// ---------------------------------------------------------------------------

test('MCP passthrough(strict:false):顶层未知键放行,但已声明类型仍校验', () => {
  const mcpSchema: JSONSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }
  // 多带字段 → passthrough 放行(对齐 cc MCP 不拒未知键)
  expect(validateToolInput(mcpSchema, { query: 'x', server_extra: 1 }, { strict: false })).toBeNull()
  // 已声明属性类型错仍拦(不留脏参数)
  expect(validateToolInput(mcpSchema, { query: 123 }, { strict: false })).toContain('query')
  // required 仍生效
  expect(validateToolInput(mcpSchema, { server_extra: 1 }, { strict: false })).toContain('query')
})

test('MCP passthrough vs strict:同一未知键,内建拒 / MCP 放行(两档差异锁死)', () => {
  const s: JSONSchema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  expect(validateToolInput(s, { a: 'x', unknown: 1 }, { strict: true })).toContain('unknown')
  expect(validateToolInput(s, { a: 'x', unknown: 1 }, { strict: false })).toBeNull()
})
