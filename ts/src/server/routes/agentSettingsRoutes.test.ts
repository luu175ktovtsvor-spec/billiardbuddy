import { describe, expect, test } from 'bun:test'
import { createAgentSettingsRouteHandler } from './agentSettingsRoutes'
import { DEFAULT_USER_SETTINGS, UserSettingsWriteError } from '../services/userSettings'

function harness(options: { managed?: boolean; writeError?: boolean } = {}) {
  let current = { ...DEFAULT_USER_SETTINGS }
  const handler = createAgentSettingsRouteHandler({
    managedBypassDisabled: options.managed ?? false,
    settings: {
      async inspect() { return { settings: current, issues: [], source: 'default' as const } },
      async update(patch) {
        if (options.writeError) throw new UserSettingsWriteError('settings source is invalid')
        current = { ...current, ...patch }
        return current
      },
    },
  })
  const call = (path: string, init?: RequestInit) => handler(new URL(`http://local${path}`), new Request(`http://local${path}`, init))
  return { call }
}

describe('Agent settings routes', () => {
  test('exposes the persisted user ceiling and managed availability', async () => {
    const h = harness({ managed: true })
    const response = await h.call('/api/settings')
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({
      settings: { allowBypassPermissionsMode: false },
      policy: { managedBypassDisabled: true, bypassPermissionsAvailable: false },
    })
  })

  test('validates updates and preserves malformed source write protection', async () => {
    const h = harness()
    const updated = await h.call('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowBypassPermissionsMode: true }),
    })
    expect(await updated?.json()).toMatchObject({ settings: { allowBypassPermissionsMode: true } })

    const invalid = await h.call('/api/settings', { method: 'POST', body: '{' })
    expect(invalid?.status).toBe(400)
    const protectedSource = await harness({ writeError: true }).call('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    })
    expect(protectedSource?.status).toBe(409)
  })

  test('ignores unrelated paths and rejects unsupported methods', async () => {
    expect(await harness().call('/health')).toBeNull()
    expect((await harness().call('/api/settings', { method: 'DELETE' }))?.status).toBe(405)
  })
})
