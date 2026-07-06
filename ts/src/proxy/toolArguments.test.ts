import { test, expect } from 'bun:test'
import { parseOpenAIToolArguments, stringifyOpenAIToolArguments } from './toolArguments'

test('合法 JSON 字符串 → 对象', () => {
  expect(parseOpenAIToolArguments('{"path":"a.txt"}')).toEqual({ path: 'a.txt' })
})
test('空/null → 空对象', () => {
  expect(parseOpenAIToolArguments('')).toEqual({})
  expect(parseOpenAIToolArguments(null)).toEqual({})
})
test('坏 JSON 字符串 → {raw: 原串}(不抛)', () => {
  expect(parseOpenAIToolArguments('{path: a')).toEqual({ raw: '{path: a' })
})
test('JSON 是非对象(数组/标量)→ {raw: 值}', () => {
  expect(parseOpenAIToolArguments('[1,2]')).toEqual({ raw: [1, 2] })
  expect(parseOpenAIToolArguments('42')).toEqual({ raw: 42 })
})
test('已是对象 → 原样;其它 → {raw}', () => {
  expect(parseOpenAIToolArguments({ a: 1 })).toEqual({ a: 1 })
  expect(parseOpenAIToolArguments(7)).toEqual({ raw: 7 })
})
test('stringify:对象 JSON 化;字符串原样;空 → 空串', () => {
  expect(stringifyOpenAIToolArguments({ a: 1 })).toBe('{"a":1}')
  expect(stringifyOpenAIToolArguments('abc')).toBe('abc')
  expect(stringifyOpenAIToolArguments(null)).toBe('')
})
