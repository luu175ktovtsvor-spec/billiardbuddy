import { describe, expect, test } from 'bun:test'

import {
  requireProductGatewayConfig,
  requireProductGatewayRoute,
} from '../desktop/electron/services/productConfig'

describe('product gateway configuration boundaries', () => {
  test('Agent and installation authentication need only the validated Gateway route', () => {
    expect(requireProductGatewayRoute({ url: 'https://gateway.example.test/gw' })).toEqual({
      url: 'https://gateway.example.test/gw',
    })
  })

  test('media sidecars still require their own Relay routes', () => {
    expect(() => requireProductGatewayConfig({ url: 'https://gateway.example.test/gw' }))
      .toThrow('Product image relay is not configured')
  })

  test('the narrow Agent route keeps the same HTTPS and /gw validation', () => {
    expect(() => requireProductGatewayRoute({ url: 'http://gateway.example.test/gw' }))
      .toThrow('gateway URL must use HTTPS at the /gw endpoint')
    expect(() => requireProductGatewayRoute({ url: 'https://gateway.example.test/not-gw' }))
      .toThrow('gateway URL must use HTTPS at the /gw endpoint')
  })
})
