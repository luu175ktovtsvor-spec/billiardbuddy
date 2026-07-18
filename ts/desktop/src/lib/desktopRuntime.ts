import {
  getBaseUrl,
  getDefaultBaseUrl,
  hasExplicitDefaultBaseUrl,
  setBaseUrl,
} from '../api/client'
import { getDesktopHost } from './desktopHost'

function getDetectedDesktopHost() {
  return getDesktopHost()
}

/**
 * Server-readiness signal.
 *
 * The API client points at the default base URL until `initializeDesktopServerUrl`
 * resolves the real dynamic sidecar URL and confirms `/health`. Background pollers
 * that fire on app mount must wait for this to avoid an uninitialized startup race.
 */
let resolveServerReady: (() => void) | null = null
let serverReadyPromise: Promise<void> | null = null

/** Resolve once the desktop or local development server URL is initialized and healthy. */
export function whenDesktopServerReady(): Promise<void> {
  if (!serverReadyPromise) {
    serverReadyPromise = new Promise<void>((resolve) => {
      resolveServerReady = resolve
    })
  }
  return serverReadyPromise
}

function markDesktopServerReady() {
  whenDesktopServerReady()
  resolveServerReady?.()
}

export function isDesktopRuntime() {
  return getDetectedDesktopHost().isDesktop
}

/** Return the running local server's base URL (for example `http://127.0.0.1:<port>`). */
export function getServerBaseUrl(): string {
  return getBaseUrl()
}

export async function initializeDesktopServerUrl() {
  const fallbackUrl = getDefaultBaseUrl()
  const host = getDetectedDesktopHost()

  if (!host.isDesktop) {
    return initializeBrowserServerUrl(fallbackUrl)
  }

  try {
    const serverUrl = await host.runtime.getServerUrl()
    setBaseUrl(serverUrl)
    await waitForHealth(serverUrl)
    markDesktopServerReady()
    return serverUrl
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `desktop server startup failed: ${String(error)}`
    console.error('[desktop] Failed to initialize desktop server URL', error)
    throw new Error(message || `desktop server startup failed (fallback would be ${fallbackUrl})`)
  }
}

async function initializeBrowserServerUrl(fallbackUrl: string) {
  const configuredUrl = getConfiguredBrowserServerUrl(fallbackUrl)
  const requestedUrl = configuredUrl ?? fallbackUrl
  const sameOriginUrl = getSameOriginServerUrl()
  const requestedImplicitSameOrigin =
    !hasExplicitDefaultBaseUrl() &&
    !!sameOriginUrl &&
    requestedUrl === sameOriginUrl

  setBaseUrl(requestedUrl)

  try {
    await waitForHealth(requestedUrl)
  } catch (error) {
    if (shouldFallbackFromLoopbackDevOrigin({
      error,
      requestedUrl,
      fallbackUrl,
      requestedImplicitSameOrigin,
    })) {
      setBaseUrl(fallbackUrl)
      await waitForHealth(fallbackUrl)
      await ensureBrowserApiAccessible(fallbackUrl)
      markDesktopServerReady()
      return fallbackUrl
    }

    throw error
  }

  await ensureBrowserApiAccessible(requestedUrl)
  markDesktopServerReady()
  return requestedUrl
}

async function waitForHealth(serverUrl: string) {
  let lastError: unknown

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/health`, {
        cache: 'no-store',
      })
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.toLowerCase().includes('application/json')) {
          lastError = new Error(`healthcheck returned non-JSON response from ${serverUrl}/health`)
          break
        }

        const body = await response.json().catch(() => null)
        if (body && typeof body === 'object' && 'status' in body && body.status === 'ok') {
          return
        }
        lastError = new Error(`healthcheck returned invalid response from ${serverUrl}/health`)
      } else {
        lastError = new Error(`healthcheck returned ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    lastError instanceof Error
      ? `Server healthcheck failed: ${lastError.message}`
      : 'Server healthcheck failed',
  )
}

async function ensureBrowserApiAccessible(serverUrl: string) {
  const response = await fetch(`${serverUrl}/api/status`, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`Server API status check failed: ${response.status}`)
  }
}

function normalizeServerUrl(value: string | null | undefined) {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    return new URL(trimmed).toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function getSameOriginServerUrl() {
  if (typeof window === 'undefined') {
    return null
  }

  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return null
  }

  return normalizeServerUrl(window.location.origin)
}

function getConfiguredBrowserServerUrl(fallbackUrl: string) {
  if (hasExplicitDefaultBaseUrl()) {
    return normalizeServerUrl(fallbackUrl)
  }

  return getSameOriginServerUrl()
}

function shouldFallbackFromLoopbackDevOrigin({
  error,
  requestedUrl,
  fallbackUrl,
  requestedImplicitSameOrigin,
}: {
  error: unknown
  requestedUrl: string
  fallbackUrl: string
  requestedImplicitSameOrigin: boolean
}) {
  if (!requestedImplicitSameOrigin || requestedUrl === fallbackUrl) {
    return false
  }

  if (!isLoopbackServerUrl(requestedUrl) || !isLoopbackServerUrl(fallbackUrl)) {
    return false
  }

  return error instanceof Error &&
    error.message.includes('healthcheck returned non-JSON response')
}

export function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIPv4(normalized)
}

function isLoopbackServerUrl(serverUrl: string) {
  try {
    return isLoopbackHostname(new URL(serverUrl).hostname)
  } catch {
    return false
  }
}

function isLoopbackIPv4(hostname: string) {
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') {
    return false
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false
    }

    const value = Number(part)
    return value >= 0 && value <= 255
  })
}
