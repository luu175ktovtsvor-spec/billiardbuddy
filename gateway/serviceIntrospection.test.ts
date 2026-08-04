import { describe, expect, test } from 'bun:test'

import {
  SERVICE_INTROSPECTION_AUDIENCE_HEADER,
  SERVICE_INTROSPECTION_PATH,
  SERVICE_INTROSPECTION_TOKEN_HEADER,
} from '../ts/shared/product/serviceIntrospection'
import { createGatewayFetch, MemoryUsageStore } from './app'
import { AuthAuthority } from './installationAuth'

const IMAGE_TOKEN = 'image-relay-service-token-12345678901234567890'
const VIDEO_TOKEN = 'video-relay-service-token-12345678901234567890'

describe('Gateway Relay identity introspection', () => {
  test('projects a verified installation only to the separately authenticated audience', async () => {
    const now = 1_800_000_000_000
    const authority = new AuthAuthority({
      dbPath: ':memory:',
      signingKey: 'gateway-auth-signing-key-12345678901234567890',
      now: () => now,
    })
    const tokens = authority.bootstrap('desktop-installation-0001')
    const gateway = createGatewayFetch({
      env: {
        GW_IMAGE_RELAY_INTROSPECTION_TOKEN: IMAGE_TOKEN,
        GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: VIDEO_TOKEN,
      },
      authority,
      usageStore: new MemoryUsageStore(),
      transcribeImpl: null,
    })

    const response = await gateway(new Request(`https://gateway.example.test${SERVICE_INTROSPECTION_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        [SERVICE_INTROSPECTION_AUDIENCE_HEADER]: 'image-relay',
        [SERVICE_INTROSPECTION_TOKEN_HEADER]: IMAGE_TOKEN,
      },
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      active: true,
      principal_id: tokens.principalId,
      installation_id: tokens.installationId,
      session_id: expect.any(String),
      expires_at: tokens.expiresAt,
      owner: `${tokens.principalId}:${tokens.installationId}`,
    })
    expect(response.headers.get('cache-control')).toBe('no-store')

    const crossAudience = await gateway(new Request(`https://gateway.example.test${SERVICE_INTROSPECTION_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        [SERVICE_INTROSPECTION_AUDIENCE_HEADER]: 'video-media-relay',
        [SERVICE_INTROSPECTION_TOKEN_HEADER]: IMAGE_TOKEN,
      },
    }))
    expect(crossAudience.status).toBe(403)
  })

  test('fails closed before projecting identity for missing service proof or revoked access', async () => {
    const authority = new AuthAuthority({
      dbPath: ':memory:',
      signingKey: 'gateway-auth-signing-key-12345678901234567890',
    })
    const tokens = authority.bootstrap('desktop-installation-0002')
    const gateway = createGatewayFetch({
      env: {
        GW_IMAGE_RELAY_INTROSPECTION_TOKEN: IMAGE_TOKEN,
        GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: VIDEO_TOKEN,
      },
      authority,
      usageStore: new MemoryUsageStore(),
      transcribeImpl: null,
    })
    const request = (serviceToken: string) => new Request(`https://gateway.example.test${SERVICE_INTROSPECTION_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        [SERVICE_INTROSPECTION_AUDIENCE_HEADER]: 'image-relay',
        [SERVICE_INTROSPECTION_TOKEN_HEADER]: serviceToken,
      },
    })

    expect((await gateway(request('wrong-service-token-that-is-long-enough'))).status).toBe(403)
    authority.logout(tokens.accessToken)
    expect((await gateway(request(IMAGE_TOKEN))).status).toBe(401)
  })

  test('does not expose paid image or video task proxies', async () => {
    const authority = new AuthAuthority({
      dbPath: ':memory:',
      signingKey: 'gateway-auth-signing-key-12345678901234567890',
    })
    const tokens = authority.bootstrap('desktop-installation-0003')
    const gateway = createGatewayFetch({
      env: {
        GW_IMAGE_RELAY_INTROSPECTION_TOKEN: IMAGE_TOKEN,
        GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: VIDEO_TOKEN,
      },
      authority,
      usageStore: new MemoryUsageStore(),
      transcribeImpl: null,
    })

    const response = await gateway(new Request('https://gateway.example.test/v1/images/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }))
    expect(response.status).toBe(404)

    const videoResponse = await gateway(new Request('https://gateway.example.test/v1/video-media/operations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }))
    expect(videoResponse.status).toBe(404)
  })
})
