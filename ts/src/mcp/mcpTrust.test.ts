import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpTrustStore, resolveTrustedMcpConfig } from './mcpTrust'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mcp-trust-')), 'mcp-trust.json')
}

test('工作区级 .mcp.json 未信任被拦;显式/已信任/app 级配置放行', () => {
  const store = new McpTrustStore(tmpFile())
  const root = resolve('/ws')
  const wsConfig = join(root, '.mcp.json')

  // 未信任的工作区级配置 → 拦下不连,带 warning
  const gated = resolveTrustedMcpConfig({ configPath: wsConfig, workspaceRoot: root, explicit: false, store })
  expect(gated.path).toBeUndefined()
  expect(gated.warning).toBeTruthy()

  // 显式指定(请求/opts 指定)→ 放行
  expect(resolveTrustedMcpConfig({ configPath: wsConfig, workspaceRoot: root, explicit: true, store }).path).toBe(wsConfig)

  // app 库/全局配置(非工作区级)→ 放行
  const appConfig = resolve('/home/u/.billiardbuddy/library/.mcp.json')
  expect(resolveTrustedMcpConfig({ configPath: appConfig, workspaceRoot: root, explicit: false, store }).path).toBe(appConfig)

  // 无配置 → path undefined、无 warning
  expect(resolveTrustedMcpConfig({ configPath: undefined, workspaceRoot: root, explicit: false, store })).toEqual({ path: undefined })

  // 信任该工作区后 → 放行
  store.trust(root)
  expect(resolveTrustedMcpConfig({ configPath: wsConfig, workspaceRoot: root, explicit: false, store }).path).toBe(wsConfig)
})

test('McpTrustStore 批准/撤销跨实例持久化', () => {
  const file = tmpFile()
  try {
    const s1 = new McpTrustStore(file)
    expect(s1.isTrusted('/ws')).toBe(false)
    s1.trust('/ws')
    // 重新加载(模拟重启)后仍信任
    expect(new McpTrustStore(file).isTrusted('/ws')).toBe(true)
    // 撤销后不再信任
    const s2 = new McpTrustStore(file)
    s2.revoke('/ws')
    expect(new McpTrustStore(file).isTrusted('/ws')).toBe(false)
  } finally {
    rmSync(file, { force: true })
  }
})
