// 会话列表 store(接后端 GET /sessions)。Block D 会扩成全量(项目视图/任务条等),Block 0 只做列表 + 刷新。
import { create } from 'zustand'
import { api } from '../api/client'
import type { SessionSummary } from '../types/chat'

interface SessionState {
  sessions: SessionSummary[]
  loading: boolean
  refresh: () => Promise<void>
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
}))
