import { create } from 'zustand'

const TAB_STORAGE_KEY = 'billiardbuddy-open-tabs'
let nextNewProductTaskRequestId = 0

export const SETTINGS_TAB_ID = '__settings__'
export const SCHEDULED_TAB_ID = '__scheduled__'
export const CREATION_TAB_ID = '__creation__'
export const OPERATIONS_TAB_ID = '__operations__'
export const IMAGE_WORKBENCH_TAB_ID = '__image_workbench__'
export const VIDEO_STUDIO_TAB_ID = '__video_studio__'
export const PRODUCT_TASKS_TAB_ID = '__product_tasks__'
export const NEW_PRODUCT_TASK_TAB_ID = '__new_product_task__'
export const PRODUCT_TASK_TAB_PREFIX = '__product_task__'

export type TabType =
  | 'settings'
  | 'scheduled'
  | 'creation'
  | 'operations'
  | 'image-workbench'
  | 'video-studio'
  | 'product-tasks'
  | 'new-product-task'
  | 'product-task'

/**
 * Fixed product surfaces may use the generic tab opener. Product tasks have a
 * dedicated constructor so their required metadata cannot be omitted.
 */
export type OpenTabType =
  | 'settings'
  | 'scheduled'
  | 'creation'
  | 'operations'
  | 'image-workbench'
  | 'video-studio'
  | 'product-tasks'

export type Tab = {
  sessionId: string
  title: string
  type: TabType
  newTaskWorkDir?: string
  newTaskRequestId?: number
  taskId?: string
}

type TabPersistence = {
  openTabs: Array<{ sessionId: string; title: string; type?: string; taskId?: string }>
  activeTabId: string | null
  lastActiveProductTaskId?: string
}

type TabStore = {
  tabs: Tab[]
  activeTabId: string | null
  /**
   * Public product context only. This is a product task id, never a renderer
   * tab id or a Core session id.
   */
  lastActiveProductTaskId: string | null

  openTab: (sessionId: string, title: string, type: OpenTabType) => void
  openNewProductTask: (workDir?: string) => void
  openProductTaskTab: (taskId: string, title: string) => string
  closeTab: (sessionId: string) => void
  setActiveTab: (sessionId: string) => void
  updateProductTaskTitle: (taskId: string, title: string) => void

  saveTabs: () => void
  restoreTabs: () => Promise<void>
}

function isOpenTabType(value: unknown): value is OpenTabType {
  return value === 'settings'
    || value === 'scheduled'
    || value === 'creation'
    || value === 'operations'
    || value === 'image-workbench'
    || value === 'video-studio'
    || value === 'product-tasks'
}

function normalizeProductTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() || null
}

function getProductTaskId(tab: Tab | undefined): string | null {
  if (tab?.type !== 'product-task') return null
  return normalizeProductTaskId(tab.taskId)
}

function getOpenProductTaskId(tabs: readonly Tab[], candidate: unknown): string | null {
  const taskId = normalizeProductTaskId(candidate)
  if (!taskId) return null
  return tabs.some((tab) => getProductTaskId(tab) === taskId) ? taskId : null
}

function getActiveProductTaskId(tabs: readonly Tab[], activeTabId: string | null): string | null {
  if (!activeTabId) return null
  return getProductTaskId(tabs.find((tab) => tab.sessionId === activeTabId))
}

function resolveLastActiveProductTaskId(
  tabs: readonly Tab[],
  activeTabId: string | null,
  lastActiveProductTaskId: unknown,
): string | null {
  return getActiveProductTaskId(tabs, activeTabId)
    ?? getOpenProductTaskId(tabs, lastActiveProductTaskId)
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  lastActiveProductTaskId: null,

  openTab: (sessionId, title, type) => {
    if (!isOpenTabType(type)) {
      get().openTab(PRODUCT_TASKS_TAB_ID, '任务中心', 'product-tasks')
      return
    }

    const { tabs, lastActiveProductTaskId } = get()
    const existing = tabs.find((t) => t.sessionId === sessionId)
    const nextTabs: Tab[] = existing
      ? tabs.map((tab) =>
        tab.sessionId === sessionId
          ? {
              ...tab,
              title,
              type,
            }
          : tab,
      )
      : [...tabs, { sessionId, title, type }]
    if (existing) {
      set({
        tabs: nextTabs,
        activeTabId: sessionId,
        lastActiveProductTaskId: resolveLastActiveProductTaskId(
          nextTabs,
          sessionId,
          lastActiveProductTaskId,
        ),
      })
    } else {
      set({
        tabs: nextTabs,
        activeTabId: sessionId,
        lastActiveProductTaskId: resolveLastActiveProductTaskId(
          nextTabs,
          sessionId,
          lastActiveProductTaskId,
        ),
      })
    }
    get().saveTabs()
  },

  openNewProductTask: (workDir) => {
    const normalizedWorkDir = workDir?.trim() || undefined
    const requestId = ++nextNewProductTaskRequestId
    const { tabs, lastActiveProductTaskId } = get()
    const tab: Tab = {
      sessionId: NEW_PRODUCT_TASK_TAB_ID,
      title: '新建任务',
      type: 'new-product-task',
      ...(normalizedWorkDir ? { newTaskWorkDir: normalizedWorkDir } : {}),
      newTaskRequestId: requestId,
    }
    const existing = tabs.some((current) => current.sessionId === NEW_PRODUCT_TASK_TAB_ID)
    set({
      tabs: existing
        ? tabs.map((current) => current.sessionId === NEW_PRODUCT_TASK_TAB_ID ? tab : current)
        : [...tabs, tab],
      activeTabId: NEW_PRODUCT_TASK_TAB_ID,
      lastActiveProductTaskId: getOpenProductTaskId(tabs, lastActiveProductTaskId),
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
      taskId: normalizedTaskId,
    }
    const existing = tabs.some((current) => current.sessionId === tabId)
    set({
      tabs: existing
        ? tabs.map((current) => current.sessionId === tabId ? tab : current)
        : [...tabs, tab],
      activeTabId: tabId,
      lastActiveProductTaskId: normalizedTaskId,
    })
    get().saveTabs()
    return tabId
  },

  closeTab: (sessionId) => {
    const { tabs, activeTabId, lastActiveProductTaskId } = get()
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

    set({
      tabs: newTabs,
      activeTabId: newActiveId,
      lastActiveProductTaskId: resolveLastActiveProductTaskId(
        newTabs,
        newActiveId,
        lastActiveProductTaskId,
      ),
    })
    get().saveTabs()
  },

  setActiveTab: (sessionId) => {
    const { tabs, lastActiveProductTaskId } = get()
    set({
      activeTabId: sessionId,
      lastActiveProductTaskId: resolveLastActiveProductTaskId(
        tabs,
        sessionId,
        lastActiveProductTaskId,
      ),
    })
    get().saveTabs()
  },

  updateProductTaskTitle: (taskId, title) => {
    const normalizedTaskId = taskId.trim()
    const normalizedTitle = title.trim()
    if (!normalizedTaskId || !normalizedTitle) return

    const hasChanged = get().tabs.some((tab) => (
      tab.type === 'product-task' &&
      tab.taskId === normalizedTaskId &&
      tab.title !== normalizedTitle
    ))
    if (!hasChanged) return

    set((state) => ({
      tabs: state.tabs.map((tab) => (
        tab.type === 'product-task' && tab.taskId === normalizedTaskId
          ? { ...tab, title: normalizedTitle }
          : tab
      )),
    }))
    get().saveTabs()
  },

  saveTabs: () => {
    const { tabs, activeTabId, lastActiveProductTaskId } = get()
    const persistableTabs = tabs.filter(isPersistableTab)
    const persistedLastActiveProductTaskId = resolveLastActiveProductTaskId(
      persistableTabs,
      activeTabId,
      lastActiveProductTaskId,
    )
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
      ...(persistedLastActiveProductTaskId
        ? { lastActiveProductTaskId: persistedLastActiveProductTaskId }
        : {}),
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(data))
    } catch { /* noop */ }
  },

  restoreTabs: async () => {
    try {
      const raw = localStorage.getItem(TAB_STORAGE_KEY)
      if (!raw) {
        set({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
        return
      }

      const data = JSON.parse(raw) as Partial<TabPersistence>
      if (!Array.isArray(data.openTabs) || data.openTabs.length === 0) {
        set({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const validTabs: Tab[] = data.openTabs
        .flatMap(toRestoredTab)

      if (validTabs.length === 0) {
        set({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
        localStorage.removeItem(TAB_STORAGE_KEY)
        return
      }

      const activeId = typeof data.activeTabId === 'string' && validTabs.some((t) => t.sessionId === data.activeTabId)
        ? data.activeTabId
        : validTabs[0]!.sessionId

      set({
        tabs: validTabs,
        activeTabId: activeId,
        lastActiveProductTaskId: resolveLastActiveProductTaskId(
          validTabs,
          activeId,
          data.lastActiveProductTaskId,
        ),
      })
      get().saveTabs()
    } catch { /* noop */ }
  },
}))

function isPersistableTab(tab: Tab): boolean {
  return (
    tab.type === 'settings'
    || tab.type === 'scheduled'
    || tab.type === 'creation'
    || tab.type === 'operations'
    || tab.type === 'image-workbench'
    || tab.type === 'video-studio'
    || tab.type === 'product-tasks'
    || (tab.type === 'product-task' && typeof tab.taskId === 'string' && tab.taskId.trim().length > 0)
  )
}

function toRestoredTab(tab: TabPersistence['openTabs'][number]): Tab[] {
  if (!tab || typeof tab.sessionId !== 'string' || typeof tab.title !== 'string') return []

  if (
    tab.type === 'settings'
    || tab.type === 'scheduled'
    || tab.type === 'creation'
    || tab.type === 'operations'
    || tab.type === 'image-workbench'
    || tab.type === 'video-studio'
    || tab.type === 'product-tasks'
  ) {
    return [{ sessionId: tab.sessionId, title: tab.title, type: tab.type }]
  }

  if (tab.type === 'product-task' && typeof tab.taskId === 'string' && tab.taskId.trim()) {
    return [{
      sessionId: tab.sessionId,
      title: tab.title,
      type: 'product-task',
      taskId: tab.taskId.trim(),
    }]
  }

  return []
}
