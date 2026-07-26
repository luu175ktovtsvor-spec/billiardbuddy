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
  PluginTaskReloadSummary,
} from '../types/plugin'

export type PluginReloadResult = {
  summary: PluginReloadSummary
  task?: PluginTaskReloadSummary
}

export type PluginActionResult = {
  action: PluginAction
  task?: PluginTaskReloadSummary
}

export type PluginBulkActionResult = {
  changed: number
  task?: PluginTaskReloadSummary
}

type PluginStore = {
  plugins: PluginSummary[]
  summary: PluginListResponse['summary'] | null
  selectedPlugin: PluginDetail | null
  lastReloadSummary: PluginReloadSummary | null
  lastTaskReloadSummary: PluginTaskReloadSummary | null
  isLoading: boolean
  isDetailLoading: boolean
  isApplying: boolean
  error: PluginRequestErrorCode | null
  fetchPlugins: (cwd?: string) => Promise<void>
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>
  reloadPlugins: (cwd?: string, taskId?: string) => Promise<PluginReloadResult>
  enablePlugin: (id: string, scope?: PluginScope, cwd?: string, taskId?: string) => Promise<PluginActionResult>
  disablePlugin: (id: string, scope?: PluginScope, cwd?: string, taskId?: string) => Promise<PluginActionResult>
  bulkEnablePlugins: (plugins: PluginActionTarget[], cwd?: string, taskId?: string) => Promise<PluginBulkActionResult>
  bulkDisablePlugins: (plugins: PluginActionTarget[], cwd?: string, taskId?: string) => Promise<PluginBulkActionResult>
  updatePlugin: (id: string, scope?: PluginScope, cwd?: string, taskId?: string) => Promise<PluginActionResult>
  installPlugin: (sourcePath: string, scope: 'user' | 'project', cwd?: string, taskId?: string) => Promise<PluginActionResult>
  uninstallPlugin: (id: string, scope?: PluginScope, keepData?: boolean, cwd?: string, taskId?: string) => Promise<PluginActionResult>
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
  lastTaskReloadSummary: null,
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
    set({ isApplying: true, error: null, lastTaskReloadSummary: null })
    try {
      const { summary, task } = await pluginsApi.reload(cwd, taskId)
      await get().fetchPlugins(cwd)
      const selected = get().selectedPlugin
      if (selected) {
        await get().fetchPluginDetail(selected.id, cwd)
      }
      set({
        isApplying: false,
        lastReloadSummary: summary,
        lastTaskReloadSummary: task ?? null,
      })
      return {
        summary,
        ...(task ? { task } : {}),
      }
    } catch (err) {
      set({ isApplying: false, error: getPluginRequestErrorCode(err) })
      throw err
    }
  },

  enablePlugin: async (id, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.enable({ id, scope, cwd }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  disablePlugin: async (id, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.disable({ id, scope, cwd }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  bulkEnablePlugins: async (plugins, cwd, taskId) => {
    return runBulkAction(
      plugins,
      (plugin) => pluginsApi.enable({ ...plugin, cwd }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  bulkDisablePlugins: async (plugins, cwd, taskId) => {
    return runBulkAction(
      plugins,
      (plugin) => pluginsApi.disable({ ...plugin, cwd }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  updatePlugin: async (id, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.update({ id, scope, cwd }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  installPlugin: async (sourcePath, scope, cwd, taskId) => {
    return runAction(
      () => pluginsApi.install({ sourcePath, scope, cwd }),
      set,
      get,
      cwd,
      taskId,
    )
  },

  uninstallPlugin: async (id, scope, keepData = false, cwd, taskId) => {
    return runAction(
      () => pluginsApi.uninstall({ id, scope, keepData, cwd }),
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
): Promise<PluginActionResult> {
  set({ isApplying: true, error: null, lastTaskReloadSummary: null })
  try {
    const { action: completedAction } = await action()
    const { summary, task } = await pluginsApi.reload(cwd, taskId)
    await get().fetchPlugins(cwd)
    const selected = get().selectedPlugin
    if (clearSelection) {
      set({ selectedPlugin: null })
    } else if (selected) {
      await get().fetchPluginDetail(selected.id, cwd)
    }
    set({
      isApplying: false,
      lastReloadSummary: summary,
      lastTaskReloadSummary: task ?? null,
    })
    return {
      action: completedAction,
      ...(task ? { task } : {}),
    }
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
): Promise<PluginBulkActionResult> {
  if (plugins.length === 0) return { changed: 0 }

  set({ isApplying: true, error: null, lastTaskReloadSummary: null })
  try {
    for (const plugin of plugins) {
      await action(plugin)
    }

    const { summary, task } = await pluginsApi.reload(cwd, taskId)
    await get().fetchPlugins(cwd)
    const selected = get().selectedPlugin
    if (selected) {
      await get().fetchPluginDetail(selected.id, cwd)
    }
    set({
      isApplying: false,
      lastReloadSummary: summary,
      lastTaskReloadSummary: task ?? null,
    })
    return {
      changed: plugins.length,
      ...(task ? { task } : {}),
    }
  } catch (err) {
    set({
      isApplying: false,
      error: getPluginRequestErrorCode(err),
    })
    throw err
  }
}
