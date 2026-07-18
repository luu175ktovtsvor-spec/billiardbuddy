import { describe, expect, test } from 'bun:test'
import { ProviderService } from '../services/providerService.js'
import {
  resolveLocalServerHost,
  startServer,
  stopServerRuntimeForShutdown,
} from '../index.js'

describe('desktop server loopback binding', () => {
  test('preserves explicit loopback hosts', () => {
    expect(resolveLocalServerHost('127.0.0.1')).toBe('127.0.0.1')
    expect(resolveLocalServerHost('127.12.34.56')).toBe('127.12.34.56')
    expect(resolveLocalServerHost('localhost')).toBe('localhost')
    expect(resolveLocalServerHost('::1')).toBe('::1')
  })

  test('falls back to loopback for LAN and wildcard host overrides', () => {
    for (const host of ['0.0.0.0', '192.168.0.20', '10.0.0.5', 'example.com', '']) {
      expect(resolveLocalServerHost(host)).toBe('127.0.0.1')
    }
  })

  test('does not serve retired external routes from a wildcard host request', async () => {
    const originalServerPort = ProviderService.getServerPort()
    const server = startServer(0, '0.0.0.0')

    try {
      expect(server.hostname).toBe('127.0.0.1')
      const baseUrl = `http://127.0.0.1:${server.port}`

      const [retiredApi, retiredShell, externalOrigin] = await Promise.all([
        fetch(`${baseUrl}/api/h5-access`),
        fetch(`${baseUrl}/`),
        fetch(`${baseUrl}/api/status`, { headers: { Origin: 'https://example.com' } }),
      ])

      expect(retiredApi.status).toBe(404)
      expect(retiredShell.status).toBe(404)
      expect(externalOrigin.status).toBe(403)
    } finally {
      server.stop(true)
      await stopServerRuntimeForShutdown()
      ProviderService.setServerPort(originalServerPort)
    }
  })
})
