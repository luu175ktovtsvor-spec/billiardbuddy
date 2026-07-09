import { expect, test } from 'bun:test'
import { approvalClassFromAnnotations, commandForPlatform, mcpToolName, normalizeMcpConfig } from './config'

test('normalizeMcpConfig:支持 .mcp.json 的 mcpServers 与裸 servers', () => {
  expect(normalizeMcpConfig({
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@x/fs'], env: { TOKEN: 't', N: 1 } },
      remote: { url: 'https://mcp.example/sse' },
      bad: { args: [] },
    },
  })).toEqual([
    { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@x/fs'], env: { TOKEN: 't' }, disabled: false },
    { name: 'remote', transport: 'http', url: 'https://mcp.example/sse', env: undefined, disabled: false },
  ])
  expect(normalizeMcpConfig({ mcpServers: { off: { command: 'node', disabled: true } } })[0]?.disabled).toBe(true)
})

test('normalizeMcpConfig:http server 解析 headers(鉴权对齐 cc,Authorization 走 headers 而非单独字段)', () => {
  const [server] = normalizeMcpConfig({
    mcpServers: {
      remote: {
        url: 'https://mcp.example/mcp',
        headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'k1', bad: 1 },
      },
    },
  })
  expect(server).toEqual({
    name: 'remote',
    transport: 'http',
    url: 'https://mcp.example/mcp',
    env: undefined,
    disabled: false,
    headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'k1' },
  })
})

test('commandForPlatform:Windows 下 npx 走 cmd /c', () => {
  expect(commandForPlatform({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }, 'win32'))
    .toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] })
  expect(commandForPlatform({ name: 'fs', transport: 'stdio', command: 'node', args: ['server.js'] }, 'darwin'))
    .toEqual({ command: 'node', args: ['server.js'] })
})

test('mcpToolName:归一 OpenAI function-safe 名称,支持 Unicode server 名', () => {
  expect(mcpToolName('高德 地图', 'search.poi')).toBe('mcp__server__search_poi')
  expect(mcpToolName('my-server', 'read_file')).toBe('mcp__my-server__read_file')
})

test('approvalClassFromAnnotations:MCP 工具一律要审批,annotations 只区分档级(对齐 cc passthrough→ask)', () => {
  // 对齐 cc:MCP server 是外部不可信代码,readOnlyHint / 无 annotations 都不能免审批,
  // 只有 destructiveHint 抬到 destructive 档,其余一律 outreach(仍 requiresApproval)。
  expect(approvalClassFromAnnotations({ readOnlyHint: true })).toBe('outreach')
  expect(approvalClassFromAnnotations({ openWorldHint: true })).toBe('outreach')
  expect(approvalClassFromAnnotations({ destructiveHint: true })).toBe('destructive')
  expect(approvalClassFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toBe('destructive')
  expect(approvalClassFromAnnotations(undefined)).toBe('outreach')
})
