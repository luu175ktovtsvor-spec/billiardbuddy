import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntimeConfig, isOsSandboxSupported, realpathIfExists, sandboxDenyWritePaths } from './osSandbox'

describe('buildRuntimeConfig', () => {
  test('可写含工作区根,网络默认空(放行靠 askCallback)', () => {
    const cfg = buildRuntimeConfig({ writablePaths: ['/tmp/w3-proj'] })
    expect(cfg.filesystem.allowWrite).toContain('/tmp/w3-proj')
    expect(cfg.filesystem.denyWrite).toEqual([])
    expect(cfg.network.allowedDomains).toEqual([])
  })
  test('denyWritePaths 透传', () => {
    const cfg = buildRuntimeConfig({ writablePaths: ['/tmp/p'], denyWritePaths: ['/tmp/p/.secret'] })
    expect(cfg.filesystem.denyWrite).toContain('/tmp/p/.secret')
  })
})

describe('sandboxDenyWritePaths(§8 修复)', () => {
  test('保护工作区级 .billiardbuddy 敏感配置(settings.json/settings.local.json/skills)', () => {
    const paths = sandboxDenyWritePaths('/tmp/w3-proj')
    expect(paths).toContain(join('/tmp/w3-proj', '.billiardbuddy', 'settings.json'))
    expect(paths).toContain(join('/tmp/w3-proj', '.billiardbuddy', 'settings.local.json'))
    expect(paths).toContain(join('/tmp/w3-proj', '.billiardbuddy', 'skills'))
  })
  test('同时保护用户级 ~/.billiardbuddy 敏感配置(不是 .claude)', () => {
    const paths = sandboxDenyWritePaths('/tmp/w3-proj')
    expect(paths.some(p => p.endsWith(join('.billiardbuddy', 'settings.json')) && !p.startsWith('/tmp/w3-proj'))).toBe(true)
    expect(paths.some(p => p.endsWith(join('.billiardbuddy', 'skills')) && !p.startsWith('/tmp/w3-proj'))).toBe(true)
    expect(paths.some(p => p.includes('.claude'))).toBe(false)
  })
})

describe('sandboxDenyWritePaths symlink root(R4 CONFIRMED #2 修复)', () => {
  test('root 经 symlink 时,拼接前先 realpath,deny 路径落在真实目录而非 symlink 原串', () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'w3-real-')))
    const linkPath = join(tmpdir(), `w3-link-${process.pid}-${Date.now()}`)
    symlinkSync(realDir, linkPath)
    try {
      const paths = sandboxDenyWritePaths(linkPath)
      // 结果应落在 realDir 前缀下(证明真的 realpath 了,不是巧合命中)
      expect(paths.some(p => p.startsWith(realDir) && p.endsWith(join('.billiardbuddy', 'settings.json')))).toBe(true)
      // symlink 原串不应再出现在任何结果里
      expect(paths.some(p => p.startsWith(linkPath))).toBe(false)
    } finally {
      unlinkSync(linkPath)
    }
  })

  test('root 不经 symlink 时行为不变(realpath 是幂等的,不引入新分叉)', () => {
    const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'w3-plain-')))
    const paths = sandboxDenyWritePaths(realDir)
    expect(paths).toContain(join(realDir, '.billiardbuddy', 'settings.json'))
  })

  test('root 不存在时 realpathIfExists 原样返回(不因还没建出来的工作区目录抛错)', () => {
    const missing = join(tmpdir(), `w3-missing-${process.pid}-${Date.now()}`)
    expect(realpathIfExists(missing)).toBe(missing)
  })
})

describe('isOsSandboxSupported', () => {
  test('win32 恒 false(OS 层不支持 Windows,走 app 护栏)', () => {
    expect(isOsSandboxSupported('win32')).toBe(false)
  })
  test('darwin 上为 true(本机是 mac)', () => {
    expect(isOsSandboxSupported('darwin')).toBe(true)
  })
})
