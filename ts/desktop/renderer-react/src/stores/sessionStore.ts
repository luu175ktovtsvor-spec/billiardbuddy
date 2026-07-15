// 会话列表 store(接后端 /sessions)。删除与归档以服务端成功为准，避免失败时在界面制造已完成假象。
import { create } from 'zustand'
import { api } from '../api/client'
import type { SessionSummary } from '../types/chat'

interface SessionState {
  sessions: SessionSummary[]
  loading: boolean
  deletingIds: string[]
  archiveBusyIds: string[]
  refresh: () => Promise<void>
  renameSession: (id: string, title: string) => void
  removeSession: (id: string) => Promise<boolean>
  togglePin: (id: string) => void
  setArchived: (id: string, archived: boolean) => Promise<boolean>
  toggleArchive: (id: string) => Promise<boolean>
}

const sid = (id: string) => `/sessions/${encodeURIComponent(id)}`

/** 后端 meta 的时间是 ISO 字符串;入口统一转 epoch ms,不然 fmtRelative 拿字符串做减法算出 NaN、相对时间整列不显示。 */
const toMs = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0)

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  loading: false,
  deletingIds: [],
  archiveBusyIds: [],
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
  removeSession: async (id) => {
    if (get().deletingIds.includes(id)) return false
    set((state) => ({ deletingIds: [...state.deletingIds, id] }))
    try {
      const result = await api.delete<{ ok: boolean }>(sid(id))
      if (!result.ok) return false
      set((state) => ({ sessions: state.sessions.filter((session) => session.id !== id) }))
      return true
    } catch {
      return false
    } finally {
      set((state) => ({ deletingIds: state.deletingIds.filter((sessionId) => sessionId !== id) }))
    }
  },
  togglePin: (id) => {
    const next = !get().sessions.find((x) => x.id === id)?.pinned
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: next } : x)) }))
    void api.patch(sid(id), { pinned: next }).catch(() => get().refresh())
  },
  setArchived: async (id, archived) => {
    if (get().archiveBusyIds.includes(id)) return false
    set((state) => ({ archiveBusyIds: [...state.archiveBusyIds, id] }))
    try {
      const result = await api.patch<{ session: { archived?: boolean } }>(sid(id), { archived })
      const persisted = result.session.archived ?? archived
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === id ? { ...session, archived: persisted } : session),
      }))
      return true
    } catch {
      return false
    } finally {
      set((state) => ({ archiveBusyIds: state.archiveBusyIds.filter((sessionId) => sessionId !== id) }))
    }
  },
  toggleArchive: async (id) => {
    const session = get().sessions.find((item) => item.id === id)
    if (!session) return false
    return await get().setArchived(id, !session.archived)
  },
}))
