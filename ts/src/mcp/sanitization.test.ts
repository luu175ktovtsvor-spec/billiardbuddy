import { expect, test } from 'bun:test'
import { partiallySanitizeUnicode, recursivelySanitizeUnicode } from './sanitization'

// 隐形 Unicode 攻击载荷一律用 String.fromCodePoint 拼,不在源码里直接敲不可见字符本身。
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b)
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e)
const BOM = String.fromCodePoint(0xfeff)
const PRIVATE_USE_CHAR = String.fromCodePoint(0xe000)
// HackerOne #3086545 实际攻击用的 Unicode Tag 字符区间(U+E0000-U+E007F,类目为 Cf)。
const TAG_LATIN_SMALL_H = String.fromCodePoint(0xe0068)
const TAG_LATIN_SMALL_I = String.fromCodePoint(0xe0069)
const TAG_CANCEL = String.fromCodePoint(0xe007f)

test('partiallySanitizeUnicode 剥离零宽字符/双向控制符/BOM/私用区/Unicode Tag 字符,保留可见文本', () => {
  const input = `visible${ZERO_WIDTH_SPACE}${RIGHT_TO_LEFT_OVERRIDE}${BOM}${PRIVATE_USE_CHAR}text${TAG_LATIN_SMALL_H}${TAG_LATIN_SMALL_I}${TAG_CANCEL}`
  const out = partiallySanitizeUnicode(input)
  expect(out).toBe('visibletext')
})

test('partiallySanitizeUnicode 对普通中英文/emoji 文本原样保留(不误伤合法内容)', () => {
  const input = '正常的中文描述 + English text + 数字123 + emoji 🎱'
  expect(partiallySanitizeUnicode(input)).toBe(input)
})

test('partiallySanitizeUnicode 对空字符串/纯净字符串是幂等的', () => {
  expect(partiallySanitizeUnicode('')).toBe('')
  const clean = 'already clean text 已经很干净'
  expect(partiallySanitizeUnicode(clean)).toBe(clean)
})

test('recursivelySanitizeUnicode 递归净化数组/对象(含 key)里的每个字符串,不碰非字符串原始值', () => {
  const poisoned = {
    name: `tool${ZERO_WIDTH_SPACE}name`,
    [`key${ZERO_WIDTH_SPACE}x`]: 'v',
    nested: {
      list: [`a${RIGHT_TO_LEFT_OVERRIDE}b`, 'c'],
      count: 3,
      enabled: true,
      empty: null,
    },
  }
  const cleaned = recursivelySanitizeUnicode(poisoned)
  expect(cleaned.name).toBe('toolname')
  expect(Object.keys(cleaned)).toContain('keyx')
  expect(cleaned.nested.list).toEqual(['ab', 'c'])
  expect(cleaned.nested.count).toBe(3)
  expect(cleaned.nested.enabled).toBe(true)
  expect(cleaned.nested.empty).toBe(null)
})

test('recursivelySanitizeUnicode 对数组直接递归,对非对象/数组/字符串值原样返回', () => {
  expect(recursivelySanitizeUnicode([`a${ZERO_WIDTH_SPACE}b`, 'c'])).toEqual(['ab', 'c'])
  expect(recursivelySanitizeUnicode(42)).toBe(42)
  expect(recursivelySanitizeUnicode(undefined)).toBe(undefined)
  expect(recursivelySanitizeUnicode(null)).toBe(null)
})
