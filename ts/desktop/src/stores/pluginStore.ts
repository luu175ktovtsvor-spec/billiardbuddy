import { create } from 'zustand'
import { getPluginRequestErrorCode, pluginsApi } from '../api/plugins'
import type {
  PluginAction,
  PluginDetail,
  PluginListResponse,
  PluginReloadSummary,
  PluginRequestErrorCode,
  PluginScope,
  PluginSummary,
} from '../types/plugin'

type PluginStore = {
  plugins: PluginSummary[]
  summary: PluginListResponse['summary'] | null
  selectedPlugin: PluginDetail | null
  lastReloadSummary: PluginReloadSummary | null
  isLoading: boolean
  isDetailLoading: boolean
  isApplying: boolean
  error: PluginRequestErrorCode | null
  fetchPlugins: (cwd?: string) => Promise<void>
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>
  reloadPlugins: (cwd?: string, taskId?: string) => Promise<PluginReloadSummary>
  enablePlugin: (id: string, scope?: PluginScope, cwd?: string, taskId?: string) => Promise<PluginAction>
  disablePlugin: (id: string, scope?: PluginScope, cwd?: string, taskId?: string) => Promise<PluginAction>
  bulkEnablePlugins: (plugins: PluginActionTarget[], cwd?: string, taskId?: string) => Promise<number>
  bulkDisablePlugins: (plugins: PluginActionTarget[], cwd?: string, taskId?: string) => Promise<number>
  updatePlugin: (id: string, scope?: PluginScope, cwd?: string, taskId?: string) => Promise<PluginAction>
  uninstallPlugin: (id: string, scope?: PluginScope, keepData?: boolean, cwd?: string, taskId?: string) => Promise<PluginAction>
  clearSelection: () => void
}

export type PluginActionTarget = {
  id: string
  scope?: PluginScope
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  summary: null,
  selectedPlugin: null,
  lastReloadSummary: null,
  isLoading: false,
  isDetailLoading: false,
  isApplying: false,
  error: null,

  fetchPlugins: async (cwd) => {
    set({ isLoading: true, error: null })
    try {
      const data = await pluginsApi.list(cwd)
      set({
        plugins: data.plugins,
        summary: data.summary,
        isLoading: false,
      })
    } catch (err) {
      set({
        isLoading: false,
        error: getPluginRequestErrorCode(err),
      })
    }
  },

  fetchPluginDetail: async (id, cwd) => {
    set({ isDetailLoading: true, error: null })
    try {
      const { detail } = await pluginsApi.detail(id, cwd)
      set({ selectedPlugin: detail, isDetailLoading: false })
    } catch (err) {
      set({
        isDetailLoading: false,
        selectedPlugin: null,
        error: getPluginRequestErrorCode(err),
      })
    }
  },

  reloadPlugins: async (cwd, taskId) => {
    set({ isApplying: true, error: null })
    try {
      const { summary } = await pluginsApi.reload(cwd, taskId)
      await get().fetchPlugins(cwd)
      const selected = get().selectedPlugin
      if (selected) {
        await get().fetchPluginDetail(selected.id, cwd)
      }
      set({ isApplying: false, lastReloadSummary: summary })
      return summary
    } catch (err) {
      set({ isApplying: false, error: getPluginRequestErrorCode(err) })
      throw err
    }
  },

  enablePlugin: async (id, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.enable({ id, scope }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  disablePlugin: async (id, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.disable({ id, scope }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  bulkEnablePlugins: async (plugins, cwd, taskId) => {
    return runBulkAction(
      plugins,
      (plugin) => pluginsApi.enable(plugin),
      set,
      get,
      cwd,
      taskId,
    )
  },

  bulkDisablePlugins: async (plugins, cwd, taskId) => {
    return runBulkAction(
      plugins,
      (plugin) => pluginsApi.disable(plugin),
      set,
      get,
      cwd,
      taskId,
    )
  },

  updatePlugin: async (id, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.update({ id, scope }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  uninstallPlugin: async (id, scope, keepData = false, cwd, taskId) => {
    return runAction(
      () => pluginsApi.uninstall({ id, scope, keepData }),
      set,
      get,
      cwd,
      taskId,
      true,
    )
  },

  clearSelection: () => set({ selectedPlugin: null }),
}))

async function runAction(
  action: () => Promise<{ ok: true; action: PluginAction }>,
  set: (updater: Partial<PluginStore>) => void,
  get: () => PluginStore,
  cwd?: string,
  taskId?: string,
  clearSelection = false,
): Promise<PluginAction> {
  set({ isApplying: true, error: null })
  try {
    const { action: completedAction } = await action()
    const { summary } = await pluginsApi.reload(cwd, taskId)
    await get().fetchPlugins(cwd)
    const selected = get().selectedPlugin
    if (clearSelection) {
      set({ selectedPlugin: null })
    } else if (selected) {
      await get().fetchPluginDetail(selected.id, cwd)
    }
    set({ isApplying: false, lastReloadSummary: summary })
    return completedAction
  } catch (err) {
    set({
      isApplying: false,
      error: getPluginRequestErrorCode(err),
    })
    throw err
  }
}

async function runBulkAction(
  plugins: PluginActionTarget[],
  action: (plugin: PluginActionTarget) => Promise<{ ok: true; action: PluginAction }>,
  set: (updater: Partial<PluginStore>) => void,
  get: () => PluginStore,
  cwd?: string,
  taskId?: string,
): Promise<number> {
  if (plugins.length === 0) return 0

  set({ isApplying: true, error: null })
  try {
    for (const plugin of plugins) {
      await action(plugin)
    }

    const { summary } = await pluginsApi.reload(cwd, taskId)
    await get().fetchPlugins(cwd)
    const selected = get().selectedPlugin
    if (selected) {
      await get().fetchPluginDetail(selected.id, cwd)
    }
    set({ isApplying: false, lastReloadSummary: summary })
    return plugins.length
  } catch (err) {
    set({
      isApplying: false,
      error: getPluginRequestErrorCode(err),
    })
    throw err
  }
}
