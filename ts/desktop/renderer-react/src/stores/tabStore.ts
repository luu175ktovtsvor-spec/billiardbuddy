// 标签/路由 store(对齐 cc:自研 tabStore + ContentRouter,不引第三方路由)。
// Block 0 起步只需要 session 一种 tab;后续 D/F 块再加 settings/scheduled/trace/workbench 等。
import { create } from 'zustand'

export type TabType = 'session' | 'settings'

export interface Tab {
  id: string
  type: TabType
  title: string
  /** session tab 绑定的 conversationId。 */
  conversationId?: string
}

interface TabState {
  tabs: Tab[]
  activeTabId: string | null
  activeTab: () => Tab | null
  openSession: (conversationId: string, title?: string) => void
  setActive: (tabId: string) => void
  closeTab: (tabId: string) => void
  renameActive: (title: string) => void
}

export const useTabStore = create<TabState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  activeTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId) ?? null
  },
  openSession: (conversationId, title = '新对话') => {
    const existing = get().tabs.find((t) => t.type === 'session' && t.conversationId === conversationId)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const tab: Tab = { id: `tab-${conversationId}`, type: 'session', title, conversationId }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
  },
  setActive: (tabId) => set({ activeTabId: tabId }),
  closeTab: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    }),
  renameActive: (title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === s.activeTabId ? { ...t, title } : t)) })),
}))
