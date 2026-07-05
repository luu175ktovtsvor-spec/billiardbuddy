import { describe, expect, test } from 'bun:test'
import { buildRuntimeConfig, isOsSandboxSupported } from './osSandbox'

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

describe('isOsSandboxSupported', () => {
  test('win32 恒 false(OS 层不支持 Windows,走 app 护栏)', () => {
    expect(isOsSandboxSupported('win32')).toBe(false)
  })
  test('darwin 上为 true(本机是 mac)', () => {
    expect(isOsSandboxSupported('darwin')).toBe(true)
  })
})
