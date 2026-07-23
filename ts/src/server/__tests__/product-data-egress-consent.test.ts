import { expect, test } from 'bun:test'
import { REMOTE_DATA_EGRESS_POLICY_REVISION } from '../../../shared/product/dataEgress.js'
import { handleProductDataEgressConsentApi } from '../api/productDataEgressConsent.js'

const segments = ['api', 'product', 'data-egress-consent']
const status = {
  available: true,
  active: false,
  policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION,
  receipt: null,
  disclosure: { purpose: 'test', data: [], receivers: [], billable: true as const, revocable: true as const },
}

test('data egress consent API exposes status, grants exact current policy and revokes', async () => {
  let grants = 0
  let revokes = 0
  const service = {
    status: async () => status,
    grant: async () => { grants++; return { ...status, active: true } },
    revoke: async () => { revokes++; return status },
  }
  expect((await handleProductDataEgressConsentApi(new Request('http://local', { method: 'GET' }), segments, service)).status).toBe(200)
  const granted = await handleProductDataEgressConsentApi(new Request('http://local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION, acknowledged: true }),
  }), segments, service)
  expect(granted.status).toBe(200)
  expect(grants).toBe(1)
  expect((await handleProductDataEgressConsentApi(new Request('http://local', { method: 'DELETE' }), segments, service)).status).toBe(200)
  expect(revokes).toBe(1)
})

test('data egress consent API rejects stale or expanded acknowledgements', async () => {
  const service = { status: async () => status, grant: async () => status, revoke: async () => status }
  for (const body of [
    { policy_revision: 'old', acknowledged: true },
    { policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION, acknowledged: true, hidden: true },
  ]) {
    const response = await handleProductDataEgressConsentApi(new Request('http://local', {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }), segments, service)
    expect(response.status).toBe(400)
  }
})
