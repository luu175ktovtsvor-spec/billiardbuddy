import { describe, expect, it, vi } from 'vitest'
import { InstallationSessionManager, type InstallationSessionStore } from './installationSession'

const now = 1_700_000_000_000

function stored(value: unknown): InstallationSessionStore & { value: string | null } {
  return {
    value: value === null ? null : JSON.stringify(value),
    load() { return this.value },
    save(value: string) { this.value = value },
    clear() { this.value = null },
  }
}

function tokens(access = 'new-access', refresh = 'new-refresh', expiresAt = now + 15 * 60_000) {
  return { access_token: access, refresh_token: refresh, expires_at: expiresAt, token_type: 'Bearer' }
}

function manager(store: InstallationSessionStore, fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof InstallationSessionManager>[0]> = {}) {
  return new InstallationSessionManager({
    gatewayUrl: 'https://gateway.example/gw',
    bootstrapCredential: 'bootstrap',
    licenseKey: 'license-0001',
    installationId: 'install-0001',
    now: () => now,
    fetchFn,
    ...extra,
  }, store)
}

describe('InstallationSessionManager', () => {
  it('serializes near-expiry concurrent callers into one refresh and one rotated access token', async () => {
    const store = stored({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: now + 60_000 })
    let resolveFetch: ((value: Response) => void) | undefined
    const fetchFn = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve })) as unknown as typeof fetch
    const sessions = manager(store, fetchFn)

    const calls = [sessions.accessToken(), sessions.accessToken(), sessions.accessToken()]
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    resolveFetch?.(Response.json(tokens()))
    await expect(Promise.all(calls)).resolves.toEqual(['new-access', 'new-access', 'new-access'])
    expect(fetchFn).toHaveBeenCalledWith('https://gateway.example/gw/v1/auth/refresh', expect.objectContaining({
      body: JSON.stringify({ refresh_token: 'old-refresh' }),
    }))
    expect(JSON.parse(store.value!).refreshToken).toBe('new-refresh')
  })

  it('fails closed on refresh failure and never falls back to bootstrap activation', async () => {
    const store = stored({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: now + 60_000 })
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('', { status: 401 }))
    const unavailable = vi.fn()
    const sessions = manager(store, fetchFn as unknown as typeof fetch, { onSessionFailure: unavailable })

    await expect(sessions.accessToken()).rejects.toThrow('refresh failed (401)')
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('/refresh')
    expect(JSON.parse(store.value!).refresh_token).toBe('old-refresh')
  })

  it('refreshes a 15-minute token before expiry and notifies Main with the new access token', async () => {
    const store = stored({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: now + 15 * 60_000 })
    const changed = vi.fn()
    const fetchFn = vi.fn(async () => Response.json(tokens('rotated-access'))) as unknown as typeof fetch
    const sessions = manager(store, fetchFn, { refreshSkewMs: 15 * 60_000, onTokenChanged: changed })

    await expect(sessions.accessToken()).resolves.toBe('rotated-access')
    expect(changed).toHaveBeenCalledWith('rotated-access')
  })

  it('uses the rotated refresh proof when logout races an in-flight refresh without updating the sidecar', async () => {
    const store = stored({ access_token: 'old-access', refresh_token: 'old-refresh', expires_at: now + 60_000 })
    let resolveRefresh: ((response: Response) => void) | undefined
    const changed = vi.fn()
    const fetchFn = vi.fn((url: string) => {
      if (url.endsWith('/refresh')) return new Promise<Response>(resolve => { resolveRefresh = resolve })
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as unknown as typeof fetch
    const sessions = manager(store, fetchFn, { onTokenChanged: changed })

    const refresh = sessions.accessToken()
    await Promise.resolve()
    const logout = sessions.logout()
    resolveRefresh?.(Response.json(tokens('new-access', 'new-refresh')))

    await expect(refresh).rejects.toThrow('logout is in progress')
    await expect(logout).resolves.toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    expect(fetchFn).toHaveBeenLastCalledWith('https://gateway.example/gw/v1/auth/logout', expect.objectContaining({
      body: JSON.stringify({ refresh_token: 'new-refresh' }),
    }))
    expect(store.value).toBeNull()
  })

  it('uses refresh proof to logout after access expiry and clears credentials only after remote success', async () => {
    const store = stored({ access_token: 'expired-access', refresh_token: 'refresh-proof', expires_at: now - 1 })
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const sessions = manager(store, fetchFn)

    await expect(sessions.logout()).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledWith('https://gateway.example/gw/v1/auth/logout', expect.objectContaining({
      body: JSON.stringify({ refresh_token: 'refresh-proof' }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(store.value).toBeNull()
  })

  it('retains encrypted refresh credentials after logout network failure so logout can be retried', async () => {
    const store = stored({ access_token: 'expired-access', refresh_token: 'refresh-proof', expires_at: now - 1 })
    const fetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const sessions = manager(store, fetchFn)

    await expect(sessions.logout()).rejects.toThrow('offline')
    expect(JSON.parse(store.value!).refresh_token).toBe('refresh-proof')
  })

  it('fails closed when secure storage is unavailable, corrupt, or unreadable after restart', async () => {
    const unavailable: InstallationSessionStore = { load: () => { throw new Error('Secure credential storage is unavailable') }, save: vi.fn(), clear: vi.fn() }
    await expect(manager(unavailable, vi.fn() as unknown as typeof fetch).accessToken()).rejects.toThrow('unavailable')

    const corrupt = stored(null)
    corrupt.value = '{not-json'
    await expect(manager(corrupt, vi.fn() as unknown as typeof fetch).accessToken()).rejects.toThrow('corrupt')
  })
})
