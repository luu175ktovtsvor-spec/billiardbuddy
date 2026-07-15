import {
  agentSettingsResponseSchema,
  agentUserSettingsPatchSchema,
  type AgentUserSettingsPatch,
} from '../../../shared/contracts/agent-settings'
import type { UserSettingsStore } from '../services/userSettings'
import { UserSettingsWriteError } from '../services/userSettings'
import { jsonDetailError } from '../middleware/http'

interface AgentSettingsRouteDependencies {
  settings: Pick<UserSettingsStore, 'inspect' | 'update'>
  managedBypassDisabled: boolean
}

export function createAgentSettingsRouteHandler(deps: AgentSettingsRouteDependencies) {
  const responseBody = async () => agentSettingsResponseSchema.parse({
    ...await deps.settings.inspect(),
    policy: {
      managedBypassDisabled: deps.managedBypassDisabled,
      bypassPermissionsAvailable: !deps.managedBypassDisabled,
    },
  })

  return async function handleAgentSettingsRoute(url: URL, req: Request): Promise<Response | null> {
    if (url.pathname !== '/api/settings') return null
    if (req.method === 'GET') return Response.json(await responseBody())
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    const parsed = agentUserSettingsPatchSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return jsonDetailError('invalid settings patch', 400)
    try {
      await deps.settings.update(parsed.data as AgentUserSettingsPatch)
      return Response.json(await responseBody())
    } catch (error) {
      if (error instanceof UserSettingsWriteError) return jsonDetailError(error.message, error.status)
      throw error
    }
  }
}
