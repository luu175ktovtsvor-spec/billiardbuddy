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

test('normalizeMcpConfig:type:sse → transport sse(保留 headers);type:http 与仅 url 历史写法 → http(对齐 cc 按 type 判别)', () => {
  const servers = normalizeMcpConfig({
    mcpServers: {
      remoteSse: { type: 'sse', url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer sse-token' } },
      remoteHttp: { type: 'http', url: 'https://mcp.example/mcp' },
      legacy: { url: 'https://mcp.example/legacy' },
    },
  })
  expect(servers.find(s => s.name === 'remoteSse')).toEqual({
    name: 'remoteSse',
    transport: 'sse',
    url: 'https://mcp.example/sse',
    env: undefined,
    disabled: false,
    headers: { Authorization: 'Bearer sse-token' },
  })
  expect(servers.find(s => s.name === 'remoteHttp')?.transport).toBe('http')
  // 无 type 的历史 url-only 写法保持向后兼容走 streamable http
  expect(servers.find(s => s.name === 'legacy')?.transport).toBe('http')
})

test('commandForPlatform:Windows 下 npx 走 cmd /c', () => {
  expect(commandForPlatform({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }, 'win32'))
    .toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', 'pkg'] })
  expect(commandForPlatform({ name: 'fs', transport: 'stdio', command: 'node', args: ['server.js'] }, 'darwin'))
    .toEqual({ command: 'node', args: ['server.js'] })
})

test('mcpToolName:归一 OpenAI function-safe 名称,支持 Unicode server 名', () => {
  // 中文 server 名 → srv-<稳定哈希>:确定性、且不同中文 server 不再撞名(旧实现全部回落 "server" 互撞)。
  const gaode = mcpToolName('高德 地图', 'search.poi')
  expect(gaode).toMatch(/^mcp__srv-[a-z0-9]+__search_poi$/)
  expect(mcpToolName('高德 地图', 'search.poi')).toBe(gaode) // 稳定
  expect(mcpToolName('百度 网盘', 'search.poi')).not.toBe(gaode) // 不撞
  expect(mcpToolName('my-server', 'read_file')).toBe('mcp__my-server__read_file')
})

test('mcpToolName:cc 对齐——不折叠连续下划线/不去首尾/不 NFKD(get__weather 保形)', () => {
  // cc normalization.ts:只替非法字符。折叠会把 get__weather 变 get_weather → 权限规则与模型寻址错位。
  expect(mcpToolName('fs', 'get__weather')).toBe('mcp__fs__get__weather')
  expect(mcpToolName('my__srv', 'run')).toBe('mcp__my__srv__run')
  expect(mcpToolName('fs', '_private_')).toBe('mcp__fs___private_')
  expect(mcpToolName('café', 'read')).toBe('mcp__caf___read') // é→_,不做 NFKD 变 e
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
