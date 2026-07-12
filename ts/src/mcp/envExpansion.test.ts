import { expect, test } from 'bun:test'
import { expandEnvVarsInString, expandMcpServerConfig } from './envExpansion'

test('expandEnvVarsInString:${VAR} 展开 / ${VAR:-default} 缺省 / 未定义记 missing 保原文', () => {
  const env = { TOKEN: 'abc', EMPTY: '' }
  expect(expandEnvVarsInString('Bearer ${TOKEN}', env)).toEqual({ expanded: 'Bearer abc', missingVars: [] })
  // 空串是"已定义":不落默认值(对齐 cc envValue !== undefined 判定)
  expect(expandEnvVarsInString('[${EMPTY:-fallback}]', env)).toEqual({ expanded: '[]', missingVars: [] })
  expect(expandEnvVarsInString('${MISSING:-def}', env)).toEqual({ expanded: 'def', missingVars: [] })
  expect(expandEnvVarsInString('x ${GONE} y', env)).toEqual({ expanded: 'x ${GONE} y', missingVars: ['GONE'] })
  // cc 逐字对齐:split(':-', 2) 截断,默认值再含 :- 只取第一段
  expect(expandEnvVarsInString('${GONE:-a:-b}', env).expanded).toBe('a')
})

test('expandMcpServerConfig:command/args/env/url/headers 全展开;缺变量抛错点名', () => {
  const env = { HOST: 'h.example', KEY: 'k1', BIN: '/usr/bin/srv' }
  const out = expandMcpServerConfig({
    name: 's', transport: 'http',
    url: 'https://${HOST}/mcp',
    headers: { Authorization: 'Bearer ${KEY}' },
  }, env)
  expect(out.url).toBe('https://h.example/mcp')
  expect(out.headers).toEqual({ Authorization: 'Bearer k1' })

  const stdio = expandMcpServerConfig({
    name: 's2', transport: 'stdio',
    command: '${BIN}', args: ['--key', '${KEY}'],
    env: { API_KEY: '${KEY}', REGION: '${REGION:-cn}' },
  }, env)
  expect(stdio.command).toBe('/usr/bin/srv')
  expect(stdio.args).toEqual(['--key', 'k1'])
  expect(stdio.env).toEqual({ API_KEY: 'k1', REGION: 'cn' })

  expect(() => expandMcpServerConfig({
    name: 'bad', transport: 'http', url: 'https://${NO_A}/x', headers: { k: '${NO_B}' },
  }, env)).toThrow(/NO_A, NO_B/)
})
