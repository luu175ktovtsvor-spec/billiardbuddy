import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'

import {
  SERVICE_INTROSPECTION_AUDIENCE_HEADER,
  SERVICE_INTROSPECTION_PATH,
  SERVICE_INTROSPECTION_TOKEN_HEADER,
} from '../ts/shared/product/serviceIntrospection'
import { loadGatewayServiceCredentials } from './serviceCredentials'

describe('Gateway service introspection credentials', () => {
  test('为每个 Relay audience 使用不同 token，并保持诊断输出脱敏', () => {
    const imageToken = 'image-relay-token-12345678901234567890'
    const videoToken = 'video-relay-token-12345678901234567890'
    const credentials = loadGatewayServiceCredentials({
      GW_IMAGE_RELAY_INTROSPECTION_TOKEN: imageToken,
      GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: videoToken,
    })
    const diagnostic = `${JSON.stringify(credentials)}\n${inspect(credentials)}`

    expect(credentials.verify('image-relay', imageToken)).toBe(true)
    expect(credentials.verify('image-relay', videoToken)).toBe(false)
    expect(credentials.verify('video-media-relay', videoToken)).toBe(true)
    expect(diagnostic).toContain('GW_IMAGE_RELAY_INTROSPECTION_TOKEN')
    expect(diagnostic).toContain('GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN')
    expect(diagnostic).not.toContain(imageToken)
    expect(diagnostic).not.toContain(videoToken)
    expect(SERVICE_INTROSPECTION_PATH).toBe('/internal/v1/auth/introspect')
    expect(SERVICE_INTROSPECTION_AUDIENCE_HEADER).toBe('X-BB-Introspection-Audience')
    expect(SERVICE_INTROSPECTION_TOKEN_HEADER).toBe('X-BB-Introspection-Service-Token')
  })

  test('缺失、过短或复用的服务 token 均失败关闭', () => {
    const token = 'same-token-123456789012345678901234567'
    expect(() => loadGatewayServiceCredentials({
      GW_IMAGE_RELAY_INTROSPECTION_TOKEN: token,
      GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: token,
    })).toThrow('must differ')
    expect(() => loadGatewayServiceCredentials({
      GW_IMAGE_RELAY_INTROSPECTION_TOKEN: 'short',
      GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: 'video-relay-token-12345678901234567890',
    })).toThrow('GW_IMAGE_RELAY_INTROSPECTION_TOKEN')
  })
})
