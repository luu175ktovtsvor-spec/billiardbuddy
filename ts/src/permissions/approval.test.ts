import { describe, expect, test } from 'bun:test'
import { signApproval, verifyApproval } from './approval'

const SECRET = 'test-secret-key'

describe('approval HMAC', () => {
  test('签名再校验 → 通过', () => {
    const tok = signApproval('publish', { id: 1, msg: 'hi' }, SECRET)
    expect(verifyApproval('publish', { id: 1, msg: 'hi' }, tok, SECRET)).toBe(true)
  })
  test('args 键序不影响(规范化)', () => {
    const tok = signApproval('publish', { a: 1, b: 2 }, SECRET)
    expect(verifyApproval('publish', { b: 2, a: 1 }, tok, SECRET)).toBe(true)
  })
  test('改了 args → 校验失败', () => {
    const tok = signApproval('publish', { id: 1 }, SECRET)
    expect(verifyApproval('publish', { id: 2 }, tok, SECRET)).toBe(false)
  })
  test('改了 tool → 校验失败', () => {
    const tok = signApproval('publish', { id: 1 }, SECRET)
    expect(verifyApproval('delete_all', { id: 1 }, tok, SECRET)).toBe(false)
  })
  test('空/缺 token → false(不放行旧客户端)', () => {
    expect(verifyApproval('publish', {}, null, SECRET)).toBe(false)
    expect(verifyApproval('publish', {}, undefined, SECRET)).toBe(false)
    expect(verifyApproval('publish', {}, '', SECRET)).toBe(false)
  })
  test('畸形/非 ASCII/乱长度 token → false(不抛异常)', () => {
    expect(verifyApproval('publish', {}, '中文乱码不是hex', SECRET)).toBe(false)
    expect(verifyApproval('publish', {}, 'deadbeef', SECRET)).toBe(false) // 长度不对
  })
  test('换 secret → 校验失败', () => {
    const tok = signApproval('publish', { id: 1 }, SECRET)
    expect(verifyApproval('publish', { id: 1 }, tok, 'other-secret')).toBe(false)
  })
  test('signApproval 对不可序列化 args 不抛,且 verify 一致(同回退)', () => {
    const c: any = {}; c.self = c
    expect(() => signApproval('publish', c, SECRET)).not.toThrow()
    const tok = signApproval('publish', c, SECRET)
    expect(verifyApproval('publish', c, tok, SECRET)).toBe(true)
  })
  test('UTF-16/UTF-8 长度撞车 token(64 CJK)→ false 不抛', () => {
    expect(verifyApproval('publish', {}, '中'.repeat(64), SECRET)).toBe(false)
  })
})
