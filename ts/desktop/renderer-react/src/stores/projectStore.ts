// 项目列表 store(接后端 GET /sessions/projects:按会话 workspaceRoot 聚合的最近项目)。
// 项目 = 工作目录本身(对齐 cc「目录即项目身份」/Codex「项目=文件夹」),没有独立项目表、不造第二真相源。
import { create } from 'zustand'
import { api } from '../api/client'
import type { ProjectSummary } from '../types/chat'

interface ProjectState {
  projects: ProjectSummary[]
  loading: boolean
  refresh: () => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  loading: false,
  refresh: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const data = await api.get<{ projects: ProjectSummary[] }>('/sessions/projects?limit=20')
      set({ projects: data.projects ?? [], loading: false })
    } catch {
      set({ loading: false })
    }
  },
}))
