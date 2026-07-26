import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  defaultBaseUrl: 'http://127.0.0.1:3456',
  explicitDefaultBaseUrl: false,
  setBaseUrl: vi.fn(),
}))

vi.mock('../api/client', () => ({
  getBaseUrl: () => clientMocks.defaultBaseUrl,
  getDefaultBaseUrl: () => clientMocks.defaultBaseUrl,
  hasExplicitDefaultBaseUrl: () => clientMocks.explicitDefaultBaseUrl,
  setBaseUrl: clientMocks.setBaseUrl,
}))

import {
  initializeDesktopServerUrl,
  isDesktopRuntime,
  isLoopbackHostname,
} from './desktopRuntime'
import { browserHost } from './desktopHost/browserHost'

function healthOkResponse() {
  return Response.json({ status: 'ok' })
}

describe('desktopRuntime local server bootstrap', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:3456'
    clientMocks.explicitDefaultBaseUrl = false
    vi.useRealTimers()
    window.history.pushState({}, '', '/')
    Reflect.deleteProperty(window, 'desktopHost')
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('recognizes IPv4 and IPv6 loopback hosts', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('127.0.1.1')).toBe(true)
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('127.example.com')).toBe(false)
    expect(isLoopbackHostname('192.168.0.1')).toBe(false)
  })

  it('uses the same-origin local server for browser development', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as unknown as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(window.location.origin)

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(window.location.origin)
    expect(globalThis.fetch).toHaveBeenCalledWith(window.location.origin + '/health', {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith(window.location.origin + '/api/status', {
      cache: 'no-store',
    })
  })

  it('uses the dynamic desktop sidecar URL before browser fallback', async () => {
    const serverUrl = 'http://127.0.0.1:59231'
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockResolvedValue(serverUrl),
      },
    }
    globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as unknown as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe(serverUrl)

    expect(window.desktopHost.runtime.getServerUrl).toHaveBeenCalledTimes(1)
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith(serverUrl)
    expect(globalThis.fetch).toHaveBeenCalledWith(serverUrl + '/health', {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('detects the injected desktop host boundary', () => {
    expect(isDesktopRuntime()).toBe(false)

    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
    }

    expect(isDesktopRuntime()).toBe(true)
  })

  it('surfaces dynamic sidecar startup failures', async () => {
    const error = new Error('electron sidecar failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      runtime: {
        getServerUrl: vi.fn().mockRejectedValue(error),
      },
    }

    await expect(initializeDesktopServerUrl()).rejects.toThrow('electron sidecar failed')
    expect(consoleError).toHaveBeenCalledWith(
      '[desktop] Failed to initialize desktop server URL',
      error,
    )

    consoleError.mockRestore()
  })

  it('falls back from a loopback Vite SPA origin to the local backend', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn((input) => {
      if (String(input) === window.location.origin + '/health') {
        return Promise.resolve(new Response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }))
      }
      return Promise.resolve(healthOkResponse())
    }) as unknown as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:3456')
    await vi.runAllTimersAsync()

    await startup
    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:3456')
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:3456/health', {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:3456/api/status', {
      cache: 'no-store',
    })
  })

  it('uses an explicit Vite local backend URL over the development origin', async () => {
    clientMocks.defaultBaseUrl = 'http://127.0.0.1:55189'
    clientMocks.explicitDefaultBaseUrl = true
    globalThis.fetch = vi.fn().mockResolvedValue(healthOkResponse()) as unknown as typeof fetch

    await expect(initializeDesktopServerUrl()).resolves.toBe('http://127.0.0.1:55189')

    expect(clientMocks.setBaseUrl).toHaveBeenLastCalledWith('http://127.0.0.1:55189')
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:55189/health', {
      cache: 'no-store',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('http://127.0.0.1:55189/api/status', {
      cache: 'no-store',
    })
  })

  it('fails when the local status route is unavailable', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(healthOkResponse())
      .mockResolvedValueOnce(new Response(null, { status: 503 })) as unknown as typeof fetch

    await expect(initializeDesktopServerUrl()).rejects.toThrow('Server API status check failed: 503')
  })
})
