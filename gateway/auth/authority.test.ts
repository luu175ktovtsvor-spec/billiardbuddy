import { expect, test } from 'bun:test'
import { AuthAuthority, MemoryAuthorityStore } from './authority'

test('gateway authority re-exports the shared durable authority', () => {
  const authority = new AuthAuthority({
    store: new MemoryAuthorityStore(),
    signingKey: 'test-signing-key-that-is-long-enough-for-authorization',
    licenses: [{ licenseKey: 'license-0001', principalId: 'principal-1', deviceLimit: 1, active: true, revision: 1 }],
  })
  const tokens = authority.activate({ licenseKey: 'license-0001', installationId: 'install-0001' })
  expect(authority.verifyAccess(tokens.accessToken).pid).toBe('principal-1')
})
