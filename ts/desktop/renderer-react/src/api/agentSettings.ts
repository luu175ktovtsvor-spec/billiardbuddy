import {
  agentSettingsResponseSchema,
  agentUserSettingsPatchSchema,
  type AgentSettingsResponse,
  type AgentUserSettingsPatch,
} from '../../../../shared/contracts/agent-settings'
import { api } from './client'

export type { AgentSettingsResponse, AgentUserSettingsPatch }

export const agentSettingsApi = {
  get: async (): Promise<AgentSettingsResponse> => agentSettingsResponseSchema.parse(
    await api.get<unknown>('/api/settings'),
  ),
  update: async (patch: AgentUserSettingsPatch): Promise<AgentSettingsResponse> => agentSettingsResponseSchema.parse(
    await api.post<unknown>('/api/settings', agentUserSettingsPatchSchema.parse(patch)),
  ),
}
