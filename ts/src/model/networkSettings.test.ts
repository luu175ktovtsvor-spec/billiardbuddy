import { expect, test } from 'bun:test'
import {
  buildNetworkEnvironment,
  createNetworkAwareFetch,
  mergeLoopbackNoProxy,
  networkSettingsFromEnv,
  normalizeNetworkSettings,
  shouldBypassProxy,
} from './networkSettings'

test('normalizeNetworkSettings:默认 direct,timeout 夹在安全范围内', () => {
  expect(normalizeNetworkSettings({})).toMatchObject({
    aiRequestTimeoutMs: 600_000,
    proxy: { mode: 'direct', url: '' },
  })
  expect(normalizeNetworkSettings({ aiRequestTimeoutMs: 1 }).aiRequestTimeoutMs).toBe(30_000)
  expect(normalizeNetworkSettings({ aiRequestTimeoutMs: 9_999_999 }).aiRequestTimeoutMs).toBe(1_800_000)
})

test('networkSettingsFromEnv:只认显式代理模式', () => {
  const settings = networkSettingsFromEnv({
    HTTPS_PROXY: 'http://system-proxy:7890',
    NETWORK_PROXY_MODE: 'manual',
    NETWORK_PROXY_URL: 'http://manual-proxy:7890',
    AI_REQUEST_TIMEOUT_MS: '45000',
  })
  expect(settings).toEqual({
    aiRequestTimeoutMs: 45_000,
    proxy: { mode: 'manual', url: 'http://manual-proxy:7890' },
  })
})

test('mergeLoopbackNoProxy:保留原条目并追加 loopback', () => {
  expect(mergeLoopbackNoProxy('example.com,localhost')).toBe('example.com,localhost,127.0.0.1,::1')
})

test('shouldBypassProxy:支持 exact/suffix/port/通配', () => {
  expect(shouldBypassProxy('https://localhost:8850/health', 'localhost')).toBe(true)
  expect(shouldBypassProxy('https://api.example.com/v1', '.example.com')).toBe(true)
  expect(shouldBypassProxy('https://api.example.com:8443/v1', 'api.example.com:8443')).toBe(true)
  expect(shouldBypassProxy('https://anything.test', '*')).toBe(true)
  expect(shouldBypassProxy('https://notexample.com', '.example.com')).toBe(false)
})

test('buildNetworkEnvironment:direct 清空代理;system 不写代理;manual 写代理并合并 no_proxy', () => {
  expect(buildNetworkEnvironment({ aiRequestTimeoutMs: 60_000, proxy: { mode: 'direct', url: '' } })).toMatchObject({
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
  })
  expect(buildNetworkEnvironment({ aiRequestTimeoutMs: 60_000, proxy: { mode: 'system', url: '' } }, { NO_PROXY: 'example.com' })).toMatchObject({
    NO_PROXY: 'example.com,localhost,127.0.0.1,::1',
  })
  expect(buildNetworkEnvironment({ aiRequestTimeoutMs: 60_000, proxy: { mode: 'manual', url: 'http://p:7890' } }, {})).toMatchObject({
    HTTPS_PROXY: 'http://p:7890',
    no_proxy: 'localhost,127.0.0.1,::1',
  })
})

test('createNetworkAwareFetch:默认 direct 不继承环境代理;manual 用 RequestInit.proxy;loopback 绕过', async () => {
  const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://system:7890' }
  const seen: Array<{ proxy: unknown; httpsProxy: string | undefined }> = []
  const fake = async (_input: string | URL | Request, init?: RequestInit & { proxy?: string }) => {
    seen.push({ proxy: init?.proxy, httpsProxy: env.HTTPS_PROXY })
    return new Response('ok')
  }

  await createNetworkAwareFetch({ aiRequestTimeoutMs: 60_000, proxy: { mode: 'direct', url: '' } }, fake, env)('https://api.example/v1')
  expect(seen.at(-1)).toEqual({ proxy: undefined, httpsProxy: '' })
  expect(env.HTTPS_PROXY).toBe('http://system:7890')

  await createNetworkAwareFetch({ aiRequestTimeoutMs: 60_000, proxy: { mode: 'manual', url: 'http://manual:7890' } }, fake, env)('https://api.example/v1')
  expect(seen.at(-1)).toEqual({ proxy: 'http://manual:7890', httpsProxy: 'http://manual:7890' })

  await createNetworkAwareFetch({ aiRequestTimeoutMs: 60_000, proxy: { mode: 'manual', url: 'http://manual:7890' } }, fake, env)('http://127.0.0.1:8850/health')
  expect(seen.at(-1)).toEqual({ proxy: undefined, httpsProxy: '' })
})
