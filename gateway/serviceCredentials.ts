import { createHash, timingSafeEqual } from 'node:crypto'
import { inspect } from 'node:util'

import {
  SERVICE_INTROSPECTION_AUDIENCES,
  type ServiceIntrospectionAudience,
} from '../ts/shared/product/serviceIntrospection'

export type GatewayServiceCredentialsEnvironment = Readonly<Record<string, string | undefined>>

export const GATEWAY_SERVICE_INTROSPECTION_TOKEN_SLOTS = {
  'image-relay': 'GW_IMAGE_RELAY_INTROSPECTION_TOKEN',
  'video-media-relay': 'GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN',
} as const satisfies Record<ServiceIntrospectionAudience, string>

type GatewayServiceTokenSlot = (typeof GATEWAY_SERVICE_INTROSPECTION_TOKEN_SLOTS)[ServiceIntrospectionAudience]

/** Gateway-only verifier for the two independent Relay service credentials. */
export class GatewayServiceCredentials {
  #tokenDigests: Readonly<Record<ServiceIntrospectionAudience, Buffer>>

  constructor(tokens: Record<ServiceIntrospectionAudience, string>) {
    this.#tokenDigests = Object.freeze(Object.fromEntries(
      SERVICE_INTROSPECTION_AUDIENCES.map(audience => [audience, tokenDigest(tokens[audience])]),
    ) as Record<ServiceIntrospectionAudience, Buffer>)
  }

  verify(audience: ServiceIntrospectionAudience, presentedToken: string | undefined): boolean {
    if (typeof presentedToken !== 'string' || !presentedToken) return false
    return timingSafeEqual(this.#tokenDigests[audience], tokenDigest(presentedToken))
  }

  view(audience: ServiceIntrospectionAudience): { audience: ServiceIntrospectionAudience; secret_slot: GatewayServiceTokenSlot; secret_configured: true } {
    return {
      audience,
      secret_slot: GATEWAY_SERVICE_INTROSPECTION_TOKEN_SLOTS[audience],
      secret_configured: true,
    }
  }

  toJSON(): { services: Array<{ audience: ServiceIntrospectionAudience; secret_slot: GatewayServiceTokenSlot; secret_configured: true }> } {
    return { services: SERVICE_INTROSPECTION_AUDIENCES.map(audience => this.view(audience)) }
  }

  [inspect.custom](): string {
    return `GatewayServiceCredentials ${JSON.stringify(this.toJSON())}`
  }
}

export function loadGatewayServiceCredentials(environment: GatewayServiceCredentialsEnvironment = process.env): GatewayServiceCredentials {
  const tokens = {} as Record<ServiceIntrospectionAudience, string>
  for (const audience of SERVICE_INTROSPECTION_AUDIENCES) {
    const slot = GATEWAY_SERVICE_INTROSPECTION_TOKEN_SLOTS[audience]
    const token = environment[slot]
    if (!token || token.trim().length < 32) throw new Error(`${slot} must be at least 32 characters`)
    tokens[audience] = token.trim()
  }
  if (constantTimeEqual(tokens['image-relay'], tokens['video-media-relay'])) {
    throw new Error('Gateway image-relay and video-media-relay introspection tokens must differ')
  }
  return new GatewayServiceCredentials(tokens)
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(tokenDigest(left), tokenDigest(right))
}
