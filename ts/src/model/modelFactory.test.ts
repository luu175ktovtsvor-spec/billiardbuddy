import { expect, test } from 'bun:test'
import { resolveModelTimeouts } from './modelFactory'
import type { NetworkSettings } from './networkSettings'

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
