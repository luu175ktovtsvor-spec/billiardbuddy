import { create } from 'zustand'
import { sessionsApi } from '../api/sessions'
import { dropSession as dropVirtualHeightSession } from '../components/chat/virtualHeightCache'
import { destroyTerminalRuntime } from '../lib/terminalRuntime'

const TAB_STORAGE_KEY = 'billiardbuddy-open-tabs'
let nextNewProductTaskRequestId = 0

export const SETTINGS_TAB_ID = '__settings__'
export const SCHEDULED_TAB_ID = '__scheduled__'
export const TERMINAL_TAB_PREFIX = '__terminal__'
export const WORKBENCH_TAB_PREFIX = '__workbench__'
export const IMAGE_WORKBENCH_TAB_ID = '__image_workbench__'
export const VIDEO_STUDIO_TAB_ID = '__video_studio__'
export const PRODUCT_TASKS_TAB_ID = '__product_tasks__'
export const NEW_PRODUCT_TASK_TAB_ID = '__new_product_task__'
export const PRODUCT_TASK_TAB_PREFIX = '__product_task__'

export type TabType =
  | 'session'
  | 'settings'
  | 'scheduled'
  | 'terminal'
  | 'workbench'
  | 'image-workbench'
  | 'video-studio'
  | 'product-tasks'
  | 'new-product-task'
  | 'product-task'

export type Tab = {
  sessionId: string
  title: string
  type: TabType
  status: 'idle' | 'running' | 'error'
  terminalCwd?: string
  terminalRuntimeId?: string
  workbenchSessionId?: string
  newTaskWorkDir?: string
  newTaskRequestId?: number
  taskId?: string
}

type TabPersistence = {
  openTabs: Array<{ sessionId: string; title: string; type?: string; taskId?: string }>
  activeTabId: string | null
}

type TabStore = {
  tabs: Tab[]
  activeTabId: string | null

  openTab: (sessionId: string, title: string, type?: TabType) => void
  openTerminalTab: (cwd?: string, terminalRuntimeId?: string) => string
  openWorkbenchTab: (sessionId: string, title?: string) => string
  openNewProductTask: (workDir?: string) => void
  openProductTaskTab: (taskId: string, title: string) => string
  closeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateTabTitle: (sessionId: string, title: string) => void
  updateTabStatus: (sessionId: string, status: Tab['status']) => void
  replaceTabSession: (oldSessionId: string, newSessionId: string) => void
  moveTab: (fromIndex: number, toIndex: number) => void

  saveTabs: () => void
  restoreTabs: () => Promise<void>
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (sessionId, title, type = 'session') => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.sessionId === sessionId)
    if (existing) {
      set({
        tabs: tabs.map((tab) =>
          tab.sessionId === sessionId
            ? {
                ...tab,
                title,
                ...(!(tab as Partial<Tab>).type ? { type } : {}),
              }
            : tab,
        ),
        activeTabId: sessionId,
      })
    } else {
      set({
        tabs: [...tabs, { sessionId, title, type, status: 'idle' }],
        activeTabId: sessionId,
      })
    }
    get().saveTabs()
  },

  openTerminalTab: (cwd, terminalRuntimeId) => {
    const { tabs } = get()
    const nextIndex = Math.max(
      0,
      ...tabs
        .filter((tab) => tab.type === 'terminal')
        .map((tab) => {
          const match = /^Terminal (\d+)$/.exec(tab.title)
          return match ? Number(match[1]) : 0
        }),
    ) + 1
    const sessionId = `${TERMINAL_TAB_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set({
      tabs: [...tabs, { sessionId, title: `Terminal ${nextIndex}`, type: 'terminal', status: 'idle', terminalCwd: cwd, terminalRuntimeId }],
      activeTabId: sessionId,
    })
    get().saveTabs()
    return sessionId
  },

  openWorkbenchTab: (sessionId, title = 'Workbench') => {
    const tabId = `${WORKBENCH_TAB_PREFIX}${sessionId}`
    const { tabs } = get()
    const existing = tabs.find((tab) => tab.sessionId === tabId)
    const tab: Tab = {
      sessionId: tabId,
      title,
      type: 'workbench',
      status: 'idle',
      workbenchSessionId: sessionId,
    }

    if (existing) {
      set({
        tabs: tabs.map((current) => current.sessionId === tabId ? tab : current),
        activeTabId: tabId,
      })
    } else {
      set({
        tabs: [...tabs, tab],
        activeTabId: tabId,
      })
    }
    get().saveTabs()
    return tabId
  },

  openNewProductTask: (workDir) => {
    const normalizedWorkDir = workDir?.trim() || undefined
    const requestId = ++nextNewProductTaskRequestId
    const { tabs } = get()
    const tab: Tab = {
      sessionId: NEW_PRODUCT_TASK_TAB_ID,
      title: '新建任务',
      type: 'new-product-task',
      status: 'idle',
      ...(normalizedWorkDir ? { newTaskWorkDir: normalizedWorkDir } : {}),
      newTaskRequestId: requestId,
    }
    const existing = tabs.some((current) => current.sessionId === NEW_PRODUCT_TASK_TAB_ID)
    set({
      tabs: existing
        ? tabs.map((current) => current.sessionId === NEW_PRODUCT_TASK_TAB_ID ? tab : current)
        : [...tabs, tab],
      activeTabId: NEW_PRODUCT_TASK_TAB_ID,
    })
    get().saveTabs()
  },

  openProductTaskTab: (taskId, title) => {
    const normalizedTaskId = taskId.trim()
    if (!normalizedTaskId) return ''

    const tabId = `${PRODUCT_TASK_TAB_PREFIX}${normalizedTaskId}`
    const { tabs } = get()
    const tab: Tab = {
      sessionId: tabId,
      title,
      type: 'product-task',
      status: 'idle',
      taskId: normalizedTaskId,
    }
    const existing = tabs.some((current) => current.sessionId === tabId)
    set({
      tabs: existing
        ? tabs.map((current) => current.sessionId === tabId ? tab : current)
        : [...tabs, tab],
      activeTabId: tabId,
    })
    get().saveTabs()
    return tabId
  },

  closeTab: (sessionId) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.sessionId === sessionId)
    if (index < 0) return

    const newTabs = tabs.filter((t) => t.sessionId !== sessionId)
    let newActiveId = activeTabId

    if (activeTabId === sessionId) {
      if (newTabs.length === 0) {
        newActiveId = null
      } else if (index >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1]!.sessionId
      } else {
        newActiveId = newTabs[index]!.sessionId
      }
    }

    set({ tabs: newTabs, activeTabId: newActiveId })
    get().saveTabs()
    const closedTab = tabs[index]
    if (closedTab?.type === 'terminal') {
      destroyTerminalRuntime(closedTab.terminalRuntimeId ?? closedTab.sessionId)
    }
    dropVirtualHeightSession(sessionId)
  },

  setActiveTab: (sessionId) => {
    set({ activeTabId: sessionId })
    get().saveTabs()
  },

  updateTabTitle: (sessionId, title) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, title } : t)),
    }))
    get().saveTabs()
  },

  updateTabStatus: (sessionId, status) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.sessionId === sessionId ? { ...t, status } : t)),
    }))
  },

  replaceTabSession: (oldSessionId, newSessionId) => {
    const { activeTabId } = get()
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === oldSessionId ? { ...t, sessionId: newSessionId } : t,
      ),
      activeTabId: activeTabId === oldSessionId ? newSessionId : activeTabId,
    }))
    get().saveTabs()
  },

  moveTab: (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return
    const { tabs } = get()
    if (fromIndex < 0 || fromIndex >= tabs.length || toIndex < 0 || toIndex >= tabs.length) return
    const newTabs = [...tabs]
    const [moved] = newTabs.splice(fromIndex, 1)
    newTabs.splice(toIndex, 0, moved!)
    set({ tabs: newTabs })
    get().saveTabs()
  },

  saveTabs: () => {
    const { tabs, activeTabId } = get()
    const persistableTabs = tabs.filter((tab) => (
      tab.type !== 'terminal'
      && tab.type !== 'workbench'
      && tab.type !== 'new-product-task'
    ))
    const data: TabPersistence = {
      openTabs: persistableTabs.map((t) => ({
        sessionId: t.sessionId,
        title: t.title,
        type: t.type,
        ...(t.taskId ? { taskId: t.taskId } : {}),
      })),
      activeTabId: activeTabId && persistableTabs.some((tab) => tab.sessionId === activeTabId)
        ? activeTabId
        : (persistableTabs[0]?.sessionId ?? null),
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(data))
    } catch { /* noop */ }
  },

  restoreTabs: async () => {
    try {
      const restoreStartedWith = get()
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      if (!raw) return

      const data = JSON.parse(raw) as TabPersistence
      if (!data.openTabs || data.openTabs.length === 0) {
        set({ tabs: [], activeTabId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const { sessions } = await sessionsApi.list({ limit: 200 })
      const current = get()
      if (
        current.tabs !== restoreStartedWith.tabs ||
        current.activeTabId !== restoreStartedWith.activeTabId
      ) {
        return
      }
      const existingIds = new Set(sessions.map((s) => s.id))

      const validTabs: Tab[] = data.openTabs
        .filter((tab) => !isRetiredTraceTab(tab))
        .filter((t) => {
          // Special tabs are always valid
          if (
            t.type === 'settings' ||
            t.type === 'scheduled' ||
            t.type === 'image-workbench' ||
            t.type === 'video-studio' ||
            t.type === 'product-tasks' ||
            (t.type === 'product-task' && typeof t.taskId === 'string' && t.taskId.trim().length > 0)
          ) return true
          if (t.type === 'terminal') return false
          // Session tabs must exist on server
          return existingIds.has(t.sessionId)
        })
        .map((t) => {
          if (
            t.type === 'settings' ||
            t.type === 'scheduled' ||
            t.type === 'image-workbench' ||
            t.type === 'video-studio' ||
            t.type === 'product-tasks'
          ) {
            return { sessionId: t.sessionId, title: t.title, type: t.type, status: 'idle' as const }
          }
          if (t.type === 'product-task' && typeof t.taskId === 'string' && t.taskId.trim()) {
            return {
              sessionId: t.sessionId,
              title: t.title,
              type: 'product-task' as const,
              status: 'idle' as const,
              taskId: t.taskId.trim(),
            }
          }
          return {
            sessionId: t.sessionId,
            title: sessions.find((s) => s.id === t.sessionId)?.title || t.title,
            type: 'session' as const,
            status: 'idle' as const,
          }
        })

      if (validTabs.length === 0) {
        set({ tabs: [], activeTabId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const activeId = data.activeTabId && validTabs.some((t) => t.sessionId === data.activeTabId)
        ? data.activeTabId
        : validTabs[0]!.sessionId

      set({ tabs: validTabs, activeTabId: activeId })
      get().saveTabs()
    } catch { /* noop */ }
  },
}))

function isRetiredTraceTab(tab: { sessionId: string; type?: string }): boolean {
  return tab.type === 'trace'
    || tab.type === 'traces'
    || tab.sessionId === '__traces__'
    || tab.sessionId.startsWith('__trace__')
}
