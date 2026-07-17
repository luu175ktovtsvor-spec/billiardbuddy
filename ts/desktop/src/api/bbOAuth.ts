// desktop/src/api/bbOAuth.ts

import { api, getBaseUrl } from './client'

export type BbOAuthStatus =
  | { loggedIn: false }
  | {
      loggedIn: true
      expiresAt: number | null
      scopes: string[]
      subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null
    }

function currentServerPort(): number {
  const port = new URL(getBaseUrl()).port
  const parsed = Number.parseInt(port, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Cannot determine server port from baseUrl: ${getBaseUrl()}`)
  }
  return parsed
}

export const bbOAuthApi = {
  start() {
    return api.post<{ authorizeUrl: string; state: string }>(
      '/api/bb-oauth/start',
      { serverPort: currentServerPort() },
    )
  },

  status() {
    return api.get<BbOAuthStatus>('/api/bb-oauth')
  },

  logout() {
    return api.delete<{ ok: true }>('/api/bb-oauth')
  },
}
