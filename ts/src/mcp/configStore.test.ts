import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMcpServer, removeMcpServer, setMcpServerDisabled, MCP_PRESETS } from './configStore'

let root: string
let cfgPath: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-store-'))
  cfgPath = join(root, '.mcp.json')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function readServers(): Record<string, unknown> {
  return (JSON.parse(readFileSync(cfgPath, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers
}

test('MCP_PRESETS 壳子:含 Playwright(stdio)+ 高德(sse,需key),字段完整', () => {
  const ids = MCP_PRESETS.map(p => p.id)
  expect(ids).toContain('playwright')
  expect(ids).toContain('amap')
  const pw = MCP_PRESETS.find(p => p.id === 'playwright')!
  expect(pw.transport).toBe('stdio')
  expect(pw.command).toBe('npx')
  expect(pw.needsAsset).toBe('node')
  const amap = MCP_PRESETS.find(p => p.id === 'amap')!
  expect(amap.transport).toBe('sse')
  expect(amap.needsKey).toBe(true)
  expect(amap.url).toContain('<')  // key 占位
})

test('addMcpServer:stdio(command)写入 command+args', async () => {
  const r = await addMcpServer({ name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest'] }, cfgPath)
  expect(r.ok).toBe(true)
  const cfg = readServers().playwright as Record<string, unknown>
  expect(cfg.command).toBe('npx')
  expect(cfg.args).toEqual(['@playwright/mcp@latest'])
})

test('addMcpServer:远程(url)写入 url + sse type', async () => {
  const r = await addMcpServer({ name: '高德', url: 'https://mcp.amap.com/sse?key=realkey123', transport: 'sse' }, cfgPath)
  expect(r.ok).toBe(true)
  const cfg = readServers()['高德'] as Record<string, unknown>
  expect(cfg.url).toBe('https://mcp.amap.com/sse?key=realkey123')
  expect(cfg.type).toBe('sse')
})

test('addMcpServer:url 里还有 <占位> 时拒绝(必须先填真实 key)', async () => {
  const r = await addMcpServer({ name: '高德', url: 'https://mcp.amap.com/sse?key=<KEY>' }, cfgPath)
  expect(r.ok).toBe(false)
  expect(r.message).toContain('占位')
})

test('addMcpServer:url 缺省自动判 sse(含 /sse)vs http', async () => {
  await addMcpServer({ name: 'httpsrv', url: 'https://example.test/mcp' }, cfgPath)
  const httpCfg = readServers().httpsrv as Record<string, unknown>
  expect(httpCfg.type).toBeUndefined()  // http 不写 type
  await addMcpServer({ name: 'ssesrv', url: 'https://example.test/sse?k=1' }, cfgPath)
  const sseCfg = readServers().ssesrv as Record<string, unknown>
  expect(sseCfg.type).toBe('sse')
})

test('addMcpServer:名字/命令url 都缺时报错', async () => {
  expect((await addMcpServer({}, cfgPath)).ok).toBe(false)
  expect((await addMcpServer({ name: 'x' }, cfgPath)).message).toContain('命令或 url')
})

test('remove/disable 远程与本机 MCP 都能操作', async () => {
  await addMcpServer({ name: 'amap', url: 'https://mcp.amap.com/sse?key=k' }, cfgPath)
  expect((await setMcpServerDisabled('amap', true, cfgPath)).ok).toBe(true)
  expect((readServers().amap as Record<string, unknown>).disabled).toBe(true)
  expect((await removeMcpServer('amap', cfgPath)).ok).toBe(true)
  expect(readServers().amap).toBeUndefined()
})
