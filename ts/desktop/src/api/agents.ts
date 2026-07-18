import { api } from './client'

/** Safe command descriptor for the product-facing Agent picker. */
export type AgentCommand = {
  displayName: string
  runtimeName: string
}

export type AgentListResponse = {
  agents: AgentCommand[]
}

export const agentsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<AgentListResponse>(`/api/agents${query}`)
  },
}
