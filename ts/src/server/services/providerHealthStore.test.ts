import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyProviderFailure, providerFailureCooldownMs, ProviderHealthStore } from './providerHealthStore'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'provider-health-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('ProviderHealthStore persists failure cooldown and reloads it', () => {
  const first = new ProviderHealthStore(root)
  const entry = first.recordFailure('saved:primary', 'Primary', 'HTTP 502 Bearer [redacted]', 1_000)
  expect(entry.failureCount).toBe(1)
  expect(entry.cooldownUntil).toBe(31_000)
  expect(entry.failureCategory).toBe('transient')
  expect(readFileSync(join(root, 'provider-health.json'), 'utf8')).not.toContain('sk-')

  const second = new ProviderHealthStore(root)
  expect(second.get('saved:primary', 2_000)).toMatchObject({
    key: 'saved:primary',
    label: 'Primary',
    lastError: 'HTTP 502 Bearer [redacted]',
  })
})

test('ProviderHealthStore uses longer cooldowns for configuration and rate-limit failures', () => {
  expect(classifyProviderFailure('模型请求失败 401:invalid api key')).toBe('configuration')
  expect(classifyProviderFailure('HTTP 429 rate limit exceeded')).toBe('rate_limit')
  expect(classifyProviderFailure('HTTP 502 upstream bad gateway')).toBe('transient')

  expect(providerFailureCooldownMs('transient', 2)).toBe(60_000)
  expect(providerFailureCooldownMs('rate_limit', 1)).toBe(120_000)
  expect(providerFailureCooldownMs('configuration', 1)).toBe(600_000)

  const store = new ProviderHealthStore(root)
  const auth = store.recordFailure('saved:primary', 'Primary', '模型请求失败 401:invalid api key', 1_000)
  expect(auth).toMatchObject({ failureCategory: 'configuration', cooldownUntil: 601_000 })
  const limited = store.recordFailure('saved:backup', 'Backup', 'HTTP 429 too many requests', 1_000)
  expect(limited).toMatchObject({ failureCategory: 'rate_limit', cooldownUntil: 121_000 })
})

test('ProviderHealthStore clears expired and successful entries', () => {
  const store = new ProviderHealthStore(root)
  store.recordFailure('saved:primary', 'Primary', 'bad', 1_000)
  expect(store.get('saved:primary', 30_999)).toBeTruthy()
  expect(store.get('saved:primary', 31_000)).toBeUndefined()

  store.recordFailure('saved:primary', 'Primary', 'bad', 50_000)
  expect(store.get('saved:primary', 50_001)).toBeTruthy()
  store.recordSuccess('saved:primary')
  expect(store.get('saved:primary', 50_002)).toBeUndefined()
})

test('ProviderHealthStore supports manual clear by key and current runtime set', () => {
  const store = new ProviderHealthStore(root)
  store.recordFailure('saved:primary', 'Primary', 'bad', 1_000)
  store.recordFailure('saved:backup', 'Backup', 'bad', 1_000)
  store.recordFailure('env:openai_chat:https://env.example/v1:env-model', 'Env', 'bad', 1_000)

  expect(store.clear('saved:primary')).toBe(true)
  expect(store.clear('saved:primary')).toBe(false)
  expect(store.get('saved:primary', 2_000)).toBeUndefined()
  expect(store.get('saved:backup', 2_000)).toBeTruthy()

  expect(store.clearAll(['saved:backup'])).toBe(1)
  expect(store.get('saved:backup', 2_000)).toBeUndefined()
  expect(store.get('env:openai_chat:https://env.example/v1:env-model', 2_000)).toBeTruthy()

  expect(store.clearAll()).toBe(1)
  expect(store.list(2_000)).toEqual([])
})

test('ProviderHealthStore records bounded failure success and clear history', () => {
  const store = new ProviderHealthStore(root)
  store.recordFailure('saved:primary', 'Primary', 'HTTP 429 too many requests', 1_000)
  store.recordSuccess('saved:primary')
  store.recordFailure('saved:backup', 'Backup', 'HTTP 401 invalid api key', 2_000)
  store.clear('saved:backup')

  const history = store.listHistory(10)
  expect(history.map(item => item.kind)).toEqual(['clear', 'failure', 'success', 'failure'])
  expect(history[0]).toMatchObject({ key: 'saved:backup', label: 'Backup', failureCategory: 'configuration' })
  expect(history[1]).toMatchObject({ kind: 'failure', failureCategory: 'configuration', failureCount: 1 })
  expect(history[3]).toMatchObject({ kind: 'failure', failureCategory: 'rate_limit', error: 'HTTP 429 too many requests' })

  const reloaded = new ProviderHealthStore(root)
  expect(reloaded.listHistory(2).map(item => item.kind)).toEqual(['clear', 'failure'])
})
