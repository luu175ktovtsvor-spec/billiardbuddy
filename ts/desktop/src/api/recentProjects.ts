import { api } from './client'

export type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

/**
 * Product-facing recent-project picker data. The server retains its existing
 * compatibility route while the renderer no longer imports the legacy
 * session API surface.
 */
export const recentProjectsApi = {
  list(limit?: number) {
    const query = typeof limit === 'number' ? `?limit=${limit}` : ''
    return api.get<{ projects: RecentProject[] }>(`/api/sessions/recent-projects${query}`)
  },
}
