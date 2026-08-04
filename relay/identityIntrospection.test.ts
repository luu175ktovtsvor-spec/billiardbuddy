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
import type { RelayIdentityAdmission } from './capacityPolicy'

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

  test('在 headers 已到但 identity body 永不结束时按 deadline 失败关闭', async () => {
    let pulls = 0
    const introspector = loadImageRelayIdentityIntrospector({
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'image-relay-service-token-123456789012345',
    }, {
      timeoutMs: 5,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        pull: () => {
          pulls += 1
          return new Promise<void>(() => {})
        },
        // A broken peer may never settle cancellation either. The deadline must
        // still return control to the Relay handler rather than await it.
        cancel: () => new Promise<void>(() => {}),
      }), { headers: { 'content-type': 'application/json' } }),
    })
    await expect(introspector.introspect('desktop-token')).rejects.toMatchObject({ status: 503, code: 'identity_unavailable' })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(pulls).toBe(1)
  })

  test('在读取前按 Content-Length 拒绝过大的 identity 响应', async () => {
    const introspector = loadImageRelayIdentityIntrospector({
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'image-relay-service-token-123456789012345',
    }, { fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(16 * 1024 + 1) } }) })
    await expect(introspector.introspect('desktop-token')).rejects.toMatchObject({ status: 502, code: 'identity_response_invalid' })
  })

  test('同 bearer 合并在途 Gateway 请求，完成后不缓存以保留即时撤销', async () => {
    let admissions = 0
    const admission: RelayIdentityAdmission = {
      async acquire() { admissions += 1; return { release() {} } },
    }
    let requests = 0
    let releaseFirst!: () => void
    const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve })
    const introspector = loadImageRelayIdentityIntrospector({
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'image-relay-service-token-123456789012345',
    }, {
      admission,
      fetchImpl: async () => {
        requests += 1
        if (requests === 1) await firstResponse
        return Response.json(activeIdentity(Date.now() + 60_000))
      },
    })
    const first = introspector.introspect('desktop-token-to-merge')
    const duplicate = introspector.introspect('desktop-token-to-merge')
    while (requests !== 1) await Promise.resolve()
    expect(admissions).toBe(1)
    releaseFirst()
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2)
    await introspector.introspect('desktop-token-to-merge')
    expect(requests).toBe(2)
    expect(admissions).toBe(2)
  })

  test('identity admission 拒绝时不访问 Gateway 且失败关闭', async () => {
    let fetches = 0
    const introspector = loadImageRelayIdentityIntrospector({
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'image-relay-service-token-123456789012345',
    }, {
      admission: { async acquire() { throw new Error('identity_capacity_exhausted') } },
      fetchImpl: async () => { fetches += 1; return Response.json(activeIdentity(Date.now() + 60_000)) },
    })
    await expect(introspector.introspect('desktop-token')).rejects.toMatchObject({ status: 503, code: 'identity_unavailable' })
    expect(fetches).toBe(0)
  })
})
