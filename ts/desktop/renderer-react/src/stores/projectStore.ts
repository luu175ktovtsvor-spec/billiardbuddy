// 项目列表 store。后端按会话聚合已有项目；前端另记用户明确选择过的目录，保证尚无会话的空项目重启不丢。
// 两者身份都只用规范工作目录，不保存另一套项目内容或会话数据。
import { create } from 'zustand'
import { api } from '../api/client'
import type { ProjectSummary } from '../types/chat'

const REMEMBERED_PROJECTS_KEY = 'qf.projects.rememberedRoots'

function readRememberedRoots(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(REMEMBERED_PROJECTS_KEY) ?? '[]') as unknown
    return Array.isArray(value) ? [...new Set(value.filter((root): root is string => typeof root === 'string' && root.trim().length > 0))] : []
  } catch {
    return []
  }
}

function persistRememberedRoots(roots: string[]): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(REMEMBERED_PROJECTS_KEY, JSON.stringify(roots)) } catch { /* 本地偏好写失败不阻断会话 */ }
}

function emptyProject(workspaceRoot: string): ProjectSummary {
  return { workspaceRoot, sessionCount: 0, lastUpdatedAt: '', lastSessionId: '', lastTitle: '', isDefault: false }
}

export function mergeRememberedProjects(projects: ProjectSummary[], roots: string[]): ProjectSummary[] {
  const seen = new Set(projects.map(project => project.workspaceRoot))
  return [...projects, ...roots.filter(root => !seen.has(root)).map(emptyProject)]
}

interface ProjectState {
  projects: ProjectSummary[]
  loading: boolean
  refresh: () => Promise<void>
  remember: (workspaceRoot: string) => void
}

const initialRememberedRoots = readRememberedRoots()

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: initialRememberedRoots.map(emptyProject),
  loading: false,
  remember: (workspaceRoot) => {
    const root = workspaceRoot.trim()
    if (!root) return
    const roots = [...new Set([root, ...readRememberedRoots()])]
    persistRememberedRoots(roots)
    set(state => ({ projects: mergeRememberedProjects(state.projects, roots) }))
  },
  refresh: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const data = await api.get<{ projects: ProjectSummary[] }>('/sessions/projects?limit=20')
      const serverProjects = data.projects ?? []
      const remembered = [...new Set([
        ...serverProjects.filter(project => !project.isDefault).map(project => project.workspaceRoot),
        ...readRememberedRoots(),
      ])]
      persistRememberedRoots(remembered)
      set({ projects: mergeRememberedProjects(serverProjects, remembered), loading: false })
    } catch {
      set({ loading: false })
    }
  },
}))
