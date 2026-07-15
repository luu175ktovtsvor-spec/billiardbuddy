import {
  extensionCommandsResponseSchema,
  extensionMutationResultSchema,
  extensionSkillsResponseSchema,
  pluginListResponseSchema,
  type ExtensionCommand,
  type ExtensionInvocationKind,
  type ExtensionLayer,
  type ExtensionSource,
  type ExtensionSkill,
  type PluginListItem,
} from '../../../../shared/contracts/extensions'
import { api } from './client'

export type { ExtensionCommand, ExtensionInvocationKind, ExtensionLayer, ExtensionSource, ExtensionSkill, PluginListItem }

export const extensionApi = {
  commands: async (input: { workspaceRoot?: string | null; enabledPacks?: string[] } = {}) => {
    const params = new URLSearchParams()
    if (input.workspaceRoot) params.set('working_dir', input.workspaceRoot)
    if (input.enabledPacks?.length) params.set('enabled_packs', input.enabledPacks.join(','))
    const query = params.toString()
    return extensionCommandsResponseSchema.parse(
      await api.get<unknown>(`/api/v1/agent/commands${query ? `?${query}` : ''}`),
    ).commands
  },
  skills: async (input: { workspaceRoot?: string | null } = {}) => {
    const params = new URLSearchParams()
    if (input.workspaceRoot) params.set('working_dir', input.workspaceRoot)
    const query = params.toString()
    return extensionSkillsResponseSchema.parse(
      await api.get<unknown>(`/api/v1/agent/skills${query ? `?${query}` : ''}`),
    ).skills
  },
}

export const pluginApi = {
  list: async () => pluginListResponseSchema.parse(
    await api.get<unknown>('/api/v1/agent/plugins'),
  ).plugins,
  toggle: async (name: string, enabled: boolean) => extensionMutationResultSchema.parse(
    await api.post<unknown>('/api/v1/agent/plugins/toggle', { name, enabled }),
  ),
  install: async (repo: string) => extensionMutationResultSchema.parse(
    await api.post<unknown>('/api/v1/agent/plugins/install', { repo }),
  ),
}
