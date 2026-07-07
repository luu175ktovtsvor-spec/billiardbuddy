import { expect, test } from 'bun:test'
import { isBlockedAddress, ssrfGuardedLookup } from './ssrfGuard'

test('isBlockedAddress mirrors CC-Haha HTTP hook private range policy', () => {
  expect(isBlockedAddress('127.0.0.1')).toBe(false)
  expect(isBlockedAddress('::1')).toBe(false)
  expect(isBlockedAddress('8.8.8.8')).toBe(false)

  expect(isBlockedAddress('0.0.0.0')).toBe(true)
  expect(isBlockedAddress('10.0.0.1')).toBe(true)
  expect(isBlockedAddress('100.100.100.200')).toBe(true)
  expect(isBlockedAddress('169.254.169.254')).toBe(true)
  expect(isBlockedAddress('172.16.0.1')).toBe(true)
  expect(isBlockedAddress('172.31.255.255')).toBe(true)
  expect(isBlockedAddress('192.168.1.1')).toBe(true)
  expect(isBlockedAddress('fc00::1')).toBe(true)
  expect(isBlockedAddress('fd00::1')).toBe(true)
  expect(isBlockedAddress('fe80::1')).toBe(true)
  expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true)
  expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true)
})

test('ssrfGuardedLookup rejects blocked IP literals before connecting', async () => {
  await new Promise<void>(resolve => {
    ssrfGuardedLookup('169.254.169.254', {}, (err, address) => {
      expect(err?.code).toBe('ERR_HTTP_HOOK_BLOCKED_ADDRESS')
      expect(address).toBe('')
      resolve()
    })
  })
})

test('ssrfGuardedLookup allows loopback literals for local dev hooks', async () => {
  await new Promise<void>(resolve => {
    ssrfGuardedLookup('127.0.0.1', {}, (err, address, family) => {
      expect(err).toBeNull()
      expect(address).toBe('127.0.0.1')
      expect(family).toBe(4)
      resolve()
    })
  })
})
