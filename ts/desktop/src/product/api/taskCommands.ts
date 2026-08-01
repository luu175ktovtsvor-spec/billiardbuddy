import { productApi } from './client'

export type ProductTaskSkillCommand = {
  runtimeName: string
  displayName: string
  description: string
}

const PRODUCT_TASK_COMMAND_TIMEOUT_MS = 120_000

function commandDiscoveryPath(cwd: string): string {
  const query = new URLSearchParams({ cwd })
  return `/api/product/task-commands/skills?${query.toString()}`
}

export const productTaskCommandsApi = {
  listSkills(cwd: string) {
    return productApi.get<{ commands: ProductTaskSkillCommand[] }>(
      commandDiscoveryPath(cwd),
      { timeout: PRODUCT_TASK_COMMAND_TIMEOUT_MS },
    )
  },
}
