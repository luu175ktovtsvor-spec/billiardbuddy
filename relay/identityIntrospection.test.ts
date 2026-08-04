import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  SERVICE_INTROSPECTION_AUDIENCE_HEADER,
  SERVICE_INTROSPECTION_TOKEN_HEADER,
} from '../ts/shared/product/serviceIntrospection'
import {
  RelayIdentityIntrospectionError,
  loadImageRelayIdentityIntrospector,
  parseActiveImageRelayIdentity,
  parseImageRelayGatewayIntrospectionBase,
} from './identityIntrospection'

const principalId = `installation:${'a'.repeat(32)}`
const installationId = 'desktop-installation-123'
const sessionId = 'b'.repeat(24)

function activeIdentity(expiresAt = 2_000): Record<string, unknown> {
  return {
    active: true,
    principal_id: principalId,
    installation_id: installationId,
    session_id: sessionId,
    expires_at: expiresAt,
    owner: `${principalId}:${installationId}`,
  }
}

describe('Image Relay identity introspection', () => {
  test('向固定私网 Gateway 路径发送标准 service header，且不保留桌面 bearer', async () => {
    const serviceToken = 'image-relay-service-token-123456789012345'
    const desktopBearer = 'desktop-access-token-that-must-not-be-retained'
    let received: Request | undefined
    const introspector = loadImageRelayIdentityIntrospector({
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: serviceToken,
    }, {
      now: () => 1_000,
      fetchImpl: async (input, init) => {
        received = input instanceof Request ? input : new Request(input, init)
        return Response.json(activeIdentity())
      },
    })

    await expect(introspector.introspect(desktopBearer)).resolves.toEqual({
      principal_id: principalId,
      installation_id: installationId,
      session_id: sessionId,
      expires_at: 2_000,
      owner: `${principalId}:${installationId}`,
    })
    expect(received?.url).toBe('http://gateway:8799/internal/v1/auth/introspect')
    expect(received?.headers.get('authorization')).toBe(`Bearer ${desktopBearer}`)
    expect(received?.headers.get(SERVICE_INTROSPECTION_AUDIENCE_HEADER)).toBe('image-relay')
    expect(received?.headers.get(SERVICE_INTROSPECTION_TOKEN_HEADER)).toBe(serviceToken)
    const diagnostic = `${JSON.stringify(introspector)}\n${inspect(introspector)}`
    expect(diagnostic).not.toContain(serviceToken)
    expect(diagnostic).not.toContain(desktopBearer)
  })

  test('严格拒绝非活跃、过期或 owner 不一致的 Gateway 响应', async () => {
    expect(parseActiveImageRelayIdentity({ active: false }, 1_000)).toBeNull()
    expect(parseActiveImageRelayIdentity(activeIdentity(1_000), 1_000)).toBeNull()
    expect(parseActiveImageRelayIdentity({ ...activeIdentity(), owner: 'forged-owner' }, 1_000)).toBeNull()

    const introspector = loadImageRelayIdentityIntrospector({
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'https://gateway.example.test',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'image-relay-service-token-123456789012345',
    }, { fetchImpl: async () => Response.json({ active: false }) })
    await expect(introspector.introspect('desktop-token')).rejects.toEqual(
      expect.objectContaining<Partial<RelayIdentityIntrospectionError>>({ status: 401, code: 'identity_inactive' }),
    )
  })

  test('只允许 HTTPS 或精确的 Compose Gateway 基址', () => {
    expect(parseImageRelayGatewayIntrospectionBase('https://gateway.example.test')).toBe('https://gateway.example.test')
    expect(parseImageRelayGatewayIntrospectionBase('http://gateway:8799/')).toBe('http://gateway:8799')
    for (const value of [
      'http://gateway:8798',
      'http://gateway:8799/internal',
      'https://token@gateway.example.test',
      'https://gateway.example.test?token=leak',
    ]) {
      expect(() => parseImageRelayGatewayIntrospectionBase(value)).toThrow('IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE')
    }
  })
})
