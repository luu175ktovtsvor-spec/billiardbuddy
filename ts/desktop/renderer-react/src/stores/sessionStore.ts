// 会话列表 store(接后端 GET /sessions)。Block D 会扩成全量(项目视图/任务条等),Block 0 只做列表 + 刷新。
import { create } from 'zustand'
import { api } from '../api/client'
import type { SessionSummary } from '../types/chat'

interface SessionState {
  sessions: SessionSummary[]
  loading: boolean
  refresh: () => Promise<void>
  /** 以下为前端本地操作(后端持久化就绪前只改本地态,接后端时在此调对应 API)。 */
  renameSession: (id: string, title: string) => void
  removeSession: (id: string) => void
  togglePin: (id: string) => void
  toggleArchive: (id: string) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  loading: false,
  refresh: async () => {
    set({ loading: true })
    try {
      const data = await api.get<{ sessions: SessionSummary[] }>('/sessions')
      set({ sessions: data.sessions ?? [], loading: false })
    } catch {
      set({ loading: false })
    }
  },
  renameSession: (id, title) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) })),
  removeSession: (id) => set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) })),
  togglePin: (id) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)) })),
  toggleArchive: (id) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, archived: !x.archived } : x)) })),
}))
