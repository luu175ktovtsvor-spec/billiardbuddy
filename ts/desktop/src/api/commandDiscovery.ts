import { api } from './client'

export type DiscoveredSlashCommand = {
  name: string
}

export const commandDiscoveryApi = {
  listSkillCommands(cwd: string) {
    const query = new URLSearchParams({ cwd })
    return api.get<{ commands: DiscoveredSlashCommand[] }>(
      `/api/skills/slash-commands?${query.toString()}`,
      { timeout: 120_000 },
    )
  },
}
