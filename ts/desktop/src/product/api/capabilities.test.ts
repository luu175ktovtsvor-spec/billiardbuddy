import { expect, test } from 'vitest'
import { PRODUCT_CAPABILITY_IDS } from '../../../../shared/product/capabilitySnapshot'
import { parseProductCapabilitySnapshot } from './capabilities'

function snapshot() {
  return {
    schema_version: 1,
    observed_at: '2026-07-26T10:00:00.000Z',
    capabilities: PRODUCT_CAPABILITY_IDS.map(id => ({ id, state: 'available' })),
  }
}

test('accepts the complete provider-neutral capability snapshot', () => {
  const value = snapshot()
  value.capabilities[0] = {
    ...value.capabilities[0],
    quota: { remaining_percent: 80, resets_at: '2026-07-27T00:00:00.000Z' },
  } as typeof value.capabilities[number]
  expect(parseProductCapabilitySnapshot(value)?.capabilities).toHaveLength(PRODUCT_CAPABILITY_IDS.length)
})

test('rejects partial snapshots and technical or malformed fields', () => {
  expect(parseProductCapabilitySnapshot({ ...snapshot(), capabilities: snapshot().capabilities.slice(1) })).toBeNull()
  expect(parseProductCapabilitySnapshot({ ...snapshot(), provider: 'private' })).toBeNull()
  expect(parseProductCapabilitySnapshot({
    ...snapshot(),
    capabilities: snapshot().capabilities.map((item, index) => index === 0 ? { ...item, model: 'private' } : item),
  })).toBeNull()
})
