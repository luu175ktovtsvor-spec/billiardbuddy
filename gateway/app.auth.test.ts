import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGatewayFetch, MemoryUsageStore } from './app'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function gateway(active = true, legacyTokens?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'bb-gateway-auth-'))
  directories.push(directory)
  return createGatewayFetch({
    env: {
      GW_QWEN_KEY: 'qwen-secret', GW_QWEN_BASE: 'https://qwen.example/v1', GW_QWEN_MODEL: 'qwen3-coder-plus',
      GW_MIMO_KEY: '', GW_DEEPSEEK_KEY: '', GW_RELAY_BASE: 'https://relay.example/relay/openai/v1', GW_RELAY_TOKEN: 'relay-secret', GW_ADMIN_TOKEN: 'admin-secret',
      GW_AUTH_SIGNING_KEY: 'test-signing-key-that-is-long-enough-for-authorization',
      GW_AUTHORITY_FILE: join(directory, 'authority.json'), GW_APP_CREDENTIALS: legacyTokens ? undefined : 'bootstrap-credential', GW_APP_TOKENS: legacyTokens,
      GW_LICENSE_PROVISIONING: JSON.stringify([{ licenseKey: 'license-0001', principalId: 'principal-1', deviceLimit: 1, active, revision: 1 }]),
    },
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    fetchImpl: async () => new Response('{}'),
  })
}

function jsonRequest(path: string, body: Record<string, unknown>, token?: string) {
  return new Request(`http://gateway${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
}

test('gateway activation only accepts bootstrap credentials and logout revokes the resulting bearer', async () => {
  const fetch = gateway()
  const denied = await fetch(jsonRequest('/v1/auth/activate', { license_key: 'license-0001', installation_id: 'install-0001' }))
  expect(denied.status).toBe(401)

  const activated = await fetch(jsonRequest('/v1/auth/activate', { license_key: 'license-0001', installation_id: 'install-0001' }, 'bootstrap-credential'))
  expect(activated.status).toBe(200)
  const tokens = await activated.json() as { access_token: string; refresh_token: string }
  expect((await fetch(new Request('http://gateway/v1/models', { headers: { Authorization: `Bearer ${tokens.access_token}` } }))).status).toBe(200)

  expect((await fetch(jsonRequest('/v1/auth/logout', { refresh_token: tokens.refresh_token }))).status).toBe(204)
  expect((await fetch(new Request('http://gateway/v1/models', { headers: { Authorization: `Bearer ${tokens.access_token}` } }))).status).toBe(401)
})

test('legacy GW_APP_TOKENS JSON keys remain activation-only and cannot authorize models', async () => {
  const fetch = gateway(true, JSON.stringify({ 'legacy-bootstrap': 'retired-owner' }))
  expect((await fetch(new Request('http://gateway/v1/models', { headers: { Authorization: 'Bearer legacy-bootstrap' } }))).status).toBe(401)

  const activated = await fetch(jsonRequest('/v1/auth/activate', { license_key: 'license-0001', installation_id: 'install-0001' }, 'legacy-bootstrap'))
  expect(activated.status).toBe(200)
  const tokens = await activated.json() as { access_token: string }
  expect((await fetch(new Request('http://gateway/v1/models', { headers: { Authorization: `Bearer ${tokens.access_token}` } }))).status).toBe(200)
})

test('gateway never creates a session for inactive startup provisioning', async () => {
  const fetch = gateway(false)
  const response = await fetch(jsonRequest('/v1/auth/activate', { license_key: 'license-0001', installation_id: 'install-0001' }, 'bootstrap-credential'))
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ detail: 'license_unavailable' })
})
