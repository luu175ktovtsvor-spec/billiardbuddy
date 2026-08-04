/** Private Gateway identity-introspection contract shared by trusted relays only. */
export const SERVICE_INTROSPECTION_PATH = '/internal/v1/auth/introspect' as const

export const SERVICE_INTROSPECTION_AUDIENCES = [
  'image-relay',
  'video-media-relay',
] as const

export type ServiceIntrospectionAudience = (typeof SERVICE_INTROSPECTION_AUDIENCES)[number]

/** The caller's requested Relay audience. This is distinct from the desktop bearer. */
export const SERVICE_INTROSPECTION_AUDIENCE_HEADER = 'X-BB-Introspection-Audience' as const
/** A Relay-to-Gateway service proof. It must never be sent to desktop clients. */
export const SERVICE_INTROSPECTION_TOKEN_HEADER = 'X-BB-Introspection-Service-Token' as const
/** The desktop installation access bearer to be checked by Gateway's AuthAuthority. */
export const SERVICE_INTROSPECTION_INSTALLATION_AUTHORIZATION_HEADER = 'Authorization' as const

export type ActiveServiceIntrospection = {
  active: true
  principal_id: string
  installation_id: string
  session_id: string
  expires_at: number
  owner: string
}

export type InactiveServiceIntrospection = { active: false }
export type ServiceIntrospectionResult = ActiveServiceIntrospection | InactiveServiceIntrospection

export function isServiceIntrospectionAudience(value: string): value is ServiceIntrospectionAudience {
  return (SERVICE_INTROSPECTION_AUDIENCES as readonly string[]).includes(value)
}
