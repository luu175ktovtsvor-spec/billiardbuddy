import { productApi } from './client'

export type ProductTaskAgentCommand = {
  displayName: string
  runtimeName: string
}

export type ProductTaskSkillCommand = {
  name: string
}

const PRODUCT_TASK_COMMAND_TIMEOUT_MS = 120_000

function commandDiscoveryPath(resource: 'agents' | 'skills', cwd: string): string {
  const query = new URLSearchParams({ cwd })
  return `/api/product/task-commands/${resource}?${query.toString()}`
}

export const productTaskCommandsApi = {
  listAgents(cwd: string) {
    return productApi.get<{ agents: ProductTaskAgentCommand[] }>(
      commandDiscoveryPath('agents', cwd),
      { timeout: PRODUCT_TASK_COMMAND_TIMEOUT_MS },
    )
  },

  listSkills(cwd: string) {
    return productApi.get<{ commands: ProductTaskSkillCommand[] }>(
      commandDiscoveryPath('skills', cwd),
      { timeout: PRODUCT_TASK_COMMAND_TIMEOUT_MS },
    )
  },
}
