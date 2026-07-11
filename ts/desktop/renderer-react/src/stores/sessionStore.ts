// 会话列表 store(接后端 /sessions)。右键操作(重命名/删除/置顶/归档)乐观改本地 + 真发后端持久化。
import { create } from 'zustand'
import { api } from '../api/client'
import type { SessionSummary } from '../types/chat'

interface SessionState {
  sessions: SessionSummary[]
  loading: boolean
  refresh: () => Promise<void>
  renameSession: (id: string, title: string) => void
  removeSession: (id: string) => void
  togglePin: (id: string) => void
  toggleArchive: (id: string) => void
}

const sid = (id: string) => `/sessions/${encodeURIComponent(id)}`

/** 后端 meta 的时间是 ISO 字符串;入口统一转 epoch ms,不然 fmtRelative 拿字符串做减法算出 NaN、相对时间整列不显示。 */
const toMs = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0)

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  loading: false,
  refresh: async () => {
    set({ loading: true })
    try {
      const data = await api.get<{ sessions: (Omit<SessionSummary, 'updatedAt' | 'createdAt'> & { updatedAt?: unknown; createdAt?: unknown })[] }>('/sessions')
      const sessions: SessionSummary[] = (data.sessions ?? []).map((s) => ({ ...s, updatedAt: toMs(s.updatedAt), createdAt: s.createdAt === undefined ? undefined : toMs(s.createdAt) }))
      set({ sessions, loading: false })
    } catch {
      set({ loading: false })
    }
  },
  renameSession: (id, title) => {
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }))
    void api.patch(sid(id), { title }).catch(() => get().refresh())
  },
  removeSession: (id) => {
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }))
    void api.delete(sid(id)).catch(() => get().refresh())
  },
  togglePin: (id) => {
    const next = !get().sessions.find((x) => x.id === id)?.pinned
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: next } : x)) }))
    void api.patch(sid(id), { pinned: next }).catch(() => get().refresh())
  },
  toggleArchive: (id) => {
    const next = !get().sessions.find((x) => x.id === id)?.archived
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, archived: next } : x)) }))
    void api.patch(sid(id), { archived: next }).catch(() => get().refresh())
  },
}))
