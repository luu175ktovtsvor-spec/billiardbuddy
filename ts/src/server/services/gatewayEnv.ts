/**
 * Environment boundary shared by every child-process launch path. It deliberately
 * has no provider/runtime imports so security-sensitive launchers can use it
 * without pulling server initialization into their child process graph.
 */
export const HOST_ONLY_GATEWAY_ENV_KEYS = [
  'BB_GATEWAY_TOKEN',
  'BB_GATEWAY_URL',
  'BB_GATEWAY_MODEL',
  'BB_GATEWAY_BOOTSTRAP_CREDENTIAL',
  'BB_LICENSE_KEY',
  'BB_GATEWAY_REFRESH_TOKEN',
  'BB_GATEWAY_SESSION',
  'BB_GATEWAY_SESSION_PROOF',
  'BB_INSTALLATION_ID',
  'BB_MEDIA_UI_CAPABILITY',
  'BB_BROWSER_UI_CAPABILITY',
] as const

/** Return a copy of `env` with host-only gateway credentials removed. */
export function stripHostOnlyGatewayEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of HOST_ONLY_GATEWAY_ENV_KEYS) delete out[key]
  return out
}
