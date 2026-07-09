import { expect, test } from 'bun:test'
import { PackRegistry, normalizePackId } from './registry'
import { registerBuiltinPacks, getDefaultPackRegistry } from './builtinPacks'
import type { DomainPack } from './types'

function fakePack(overrides: Partial<DomainPack> = {}): DomainPack {
  return {
    id: 'fake-pack',
    name: '假领域包',
    description: '仅供测试的第二个领域包',
    version: '0.1.0',
    aliases: ['fake', '假包'],
    sessionStartContext: '<domain_context id="fake-pack">测试上下文</domain_context>',
    ...overrides,
  }
}

test('normalizePackId: 大小写/空格/下划线归一为连字符', () => {
  expect(normalizePackId('  Fake_Pack ')).toBe('fake-pack')
  expect(normalizePackId('台球')).toBe('台球')
})

test('通用加载器:注册/发现一个新 pack,按 id 与别名都能解析', () => {
  const registry = new PackRegistry()
  registry.register(fakePack())

  expect(registry.size).toBe(1)
  expect(registry.has('fake-pack')).toBe(true)
  expect(registry.resolve('fake-pack')?.id).toBe('fake-pack')
  // 别名解析(大小写无关)
  expect(registry.resolve('FAKE')?.id).toBe('fake-pack')
  expect(registry.resolve('假包')?.id).toBe('fake-pack')
  // 列举出这个新发现的 pack
  expect(registry.list().map(p => p.id)).toEqual(['fake-pack'])
})

test('通用加载器:启停 pack —— 停用后不再被 resolve/list,仍可 listAll 看到', () => {
  const registry = new PackRegistry()
  registry.register(fakePack())

  expect(registry.setEnabled('fake', false)).toBe(true)
  expect(registry.isEnabled('fake-pack')).toBe(false)
  expect(registry.resolve('fake-pack')).toBeUndefined()
  expect(registry.list()).toEqual([])
  // 停用不等于卸载:listAll 仍列出、状态为 enabled:false
  expect(registry.listAll().map(r => ({ id: r.pack.id, enabled: r.enabled }))).toEqual([{ id: 'fake-pack', enabled: false }])

  // 重新启用后恢复可解析
  registry.setEnabled('假包', true)
  expect(registry.resolve('fake-pack')?.id).toBe('fake-pack')
})

test('通用加载器:卸载 pack 后 has/resolve 都落空', () => {
  const registry = new PackRegistry()
  registry.register(fakePack())
  expect(registry.unregister('假包')).toBe(true)
  expect(registry.has('fake-pack')).toBe(false)
  expect(registry.resolve('fake-pack')).toBeUndefined()
  expect(registry.unregister('fake-pack')).toBe(false) // 已不在
})

test('通用加载器:多 pack 注册保序,list 反映注册顺序', () => {
  const registry = new PackRegistry()
  registry.register(fakePack({ id: 'a', aliases: [] }))
  registry.register(fakePack({ id: 'b', aliases: [] }))
  expect(registry.list().map(p => p.id)).toEqual(['a', 'b'])
})

test('registerBuiltinPacks:billiards 作为第一个注册的 pack 被发现,带版本与别名', () => {
  const registry = registerBuiltinPacks(new PackRegistry())
  const ids = registry.list().map(p => p.id)
  expect(ids[0]).toBe('billiards')
  expect(registry.resolve('台球')?.id).toBe('billiards')
  expect(registry.resolve('pool')?.id).toBe('billiards')
  expect(registry.resolve('billiards')?.version).toBe('1.0.0')
  // 知识/守卫句柄挂在 pack 上,核心不感知形状
  const pack = registry.resolve('billiards')!
  expect(typeof pack.knowledge?.stats).toBe('function')
  expect(typeof pack.guardrails?.scan).toBe('function')
})

test('默认注册表已含 billiards,且与新注册的假 pack 共存互不影响', () => {
  const registry = getDefaultPackRegistry()
  expect(registry.has('billiards')).toBe(true)
  const before = registry.size
  registry.register(fakePack({ id: 'ephemeral-test-pack', aliases: [] }))
  expect(registry.resolve('ephemeral-test-pack')?.id).toBe('ephemeral-test-pack')
  expect(registry.has('billiards')).toBe(true)
  // 清理,避免污染跑在同进程内的其它测试对默认注册表的断言
  registry.unregister('ephemeral-test-pack')
  expect(registry.size).toBe(before)
})
