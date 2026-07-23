import { createHash } from 'node:crypto'
import { AuthAuthority, MemoryAuthorityStore } from './authority'

const authority = new AuthAuthority({
  store: new MemoryAuthorityStore(),
  signingKey: 'test-signing-key-that-is-long-enough-for-authorization',
  licenses: [{ licenseKey: 'test-license', principalId: 'test-principal', deviceLimit: 1000, active: true, revision: 1 }],
})

/** Gateway tests obtain an actual installation access bearer, never the bootstrap credential. */
export const gatewayTestAuthority = authority
export const gatewayTestAccessToken = authority.activate({
  licenseKey: 'test-license',
  installationId: 'test-installation',
}).accessToken

const accessByIdentity = new Map<string, string>()

export function gatewayTestAccessTokenFor(identity: string): string {
  const cached = accessByIdentity.get(identity)
  if (cached) return cached
  const id = createHash('sha256').update(identity).digest('base64url').slice(0, 24)
  const licenseKey = `test-license-${id}`
  authority.provisionLicense({ licenseKey, principalId: `test-principal-${id}`, deviceLimit: 10_000, active: true, revision: 1 })
  const access = authority.activate({ licenseKey, installationId: `test-install-${id}` }).accessToken
  accessByIdentity.set(identity, access)
  return access
}
