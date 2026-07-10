import { expect, test } from 'bun:test'
import { createModelFromProviderConfig, resolveModelTimeouts } from './modelFactory'
import type { NetworkSettings } from './networkSettings'
import type { RuntimeProviderConfig } from './providerConfig'

const net = (aiRequestTimeoutMs: number): NetworkSettings => ({ aiRequestTimeoutMs } as NetworkSettings)

test('resolveModelTimeouts:idle/request 超时跟随 networkSettings.aiRequestTimeoutMs', () => {
  expect(resolveModelTimeouts({}, net(45000))).toEqual({ idleTimeoutMs: 45000, requestTimeoutMs: 45000 })
})

test('resolveModelTimeouts:config 显式值优先于网络设置', () => {
  expect(resolveModelTimeouts({ idleTimeoutMs: 10000, requestTimeoutMs: 20000 }, net(45000)))
    .toEqual({ idleTimeoutMs: 10000, requestTimeoutMs: 20000 })
})

test('resolveModelTimeouts:opts 网络设置缺省时回退 config.networkSettings', () => {
  expect(resolveModelTimeouts({ networkSettings: net(33000) })).toEqual({ idleTimeoutMs: 33000, requestTimeoutMs: 33000 })
})

test('resolveModelTimeouts:都没有则各自 undefined(交模型层默认)', () => {
  expect(resolveModelTimeouts({})).toEqual({ idleTimeoutMs: undefined, requestTimeoutMs: undefined })
})

// —— 修复回归:idleTimeoutMs 此前只接线给 ProxyModel,AnthropicMessagesModelConfig 完全没有该字段、
// 卡死连接永久挂起(见 11-provider-proxy.md P0-1)。这里端到端验证 apiFormat:'anthropic' 分支也接上了。

test('createModelFromProviderConfig:apiFormat=anthropic 也接上 idleTimeoutMs(卡死流按超时中止,不永久挂起)', async () => {
  const stalledBody = new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue、永不 close,模拟卡死 */ } })
  const config: RuntimeProviderConfig = {
    apiFormat: 'anthropic',
    baseUrl: 'https://api.test/v1',
    apiKey: 'k',
    model: 'm',
    idleTimeoutMs: 30,
  }
  const model = createModelFromProviderConfig(config, {
    fetchImpl: async () => new Response(stalledBody, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  })
  await expect(model.step({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] }))
    .rejects.toThrow('idle timeout')
})
