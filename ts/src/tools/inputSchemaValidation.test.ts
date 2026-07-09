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

test('通过:合法入参 / 未声明属性放行', () => {
  expect(validateToolInput(schema, { path: 'a.txt' })).toBeNull()
  expect(validateToolInput(schema, { path: 'a', count: 3, ratio: 1.5, flag: true, opts: {}, tags: [] })).toBeNull()
  // 未声明属性一律放行(保守,不误伤)
  expect(validateToolInput(schema, { path: 'a', extra: 'whatever', nested: { x: 1 } })).toBeNull()
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

test('放行:无 schema / 未知或 union 类型标注(保守不误伤)', () => {
  expect(validateToolInput(undefined, { anything: 1 })).toBeNull()
  const looseSchema: JSONSchema = { type: 'object', properties: { x: { type: ['string', 'number'] }, y: {} }, required: [] }
  expect(validateToolInput(looseSchema, { x: 1 })).toBeNull() // union 类型数组 → 放行
  expect(validateToolInput(looseSchema, { x: 'a' })).toBeNull()
  expect(validateToolInput(looseSchema, { y: { deep: true } })).toBeNull() // 无 type 声明 → 放行
})
