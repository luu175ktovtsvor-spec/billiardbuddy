import { ApiError, api } from './client'
import type {
  PluginAction,
  PluginDetail,
  PluginListResponse,
  PluginReloadResponse,
  PluginRequestErrorCode,
  PluginScope,
  PluginTaskReloadSummary,
} from '../types/plugin'

type PluginActionPayload = {
  id: string
  scope?: PluginScope
  keepData?: boolean
  cwd?: string
}

const PLUGIN_REQUEST_ERROR_CODES = new Set<PluginRequestErrorCode>([
  'PLUGIN_ACTION_FAILED',
  'PLUGIN_ACTION_INVALID',
  'PLUGIN_NOT_FOUND',
  'PRODUCT_TASK_UNAVAILABLE',
  'PLUGIN_REQUEST_FAILED',
])

const PLUGIN_ERROR_TRANSLATION_KEYS: Record<PluginRequestErrorCode, string> = {
  PLUGIN_ACTION_FAILED: 'settings.plugins.error.actionFailed',
  PLUGIN_ACTION_INVALID: 'settings.plugins.error.actionInvalid',
  PLUGIN_NOT_FOUND: 'settings.plugins.error.notFound',
  PRODUCT_TASK_UNAVAILABLE: 'settings.plugins.error.taskUnavailable',
  PLUGIN_REQUEST_FAILED: 'settings.plugins.error.requestFailed',
}

const PLUGIN_ACTION_TRANSLATION_KEYS: Record<PluginAction, string> = {
  enabled: 'settings.plugins.action.enabled',
  disabled: 'settings.plugins.action.disabled',
  installed: 'settings.plugins.action.installed',
  updated: 'settings.plugins.action.updated',
  uninstalled: 'settings.plugins.action.uninstalled',
}

export function getPluginRequestErrorCode(error: unknown): PluginRequestErrorCode {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const code = 'error' in error.body ? error.body.error : undefined
    if (typeof code === 'string' && PLUGIN_REQUEST_ERROR_CODES.has(code as PluginRequestErrorCode)) {
      return code as PluginRequestErrorCode
    }
  }

  return 'PLUGIN_REQUEST_FAILED'
}

export function pluginErrorTranslationKey(code: PluginRequestErrorCode) {
  return PLUGIN_ERROR_TRANSLATION_KEYS[code] as
    | 'settings.plugins.error.actionFailed'
    | 'settings.plugins.error.actionInvalid'
    | 'settings.plugins.error.notFound'
    | 'settings.plugins.error.taskUnavailable'
    | 'settings.plugins.error.requestFailed'
}

export function pluginActionTranslationKey(action: PluginAction) {
  return PLUGIN_ACTION_TRANSLATION_KEYS[action] as
    | 'settings.plugins.action.enabled'
    | 'settings.plugins.action.disabled'
    | 'settings.plugins.action.installed'
    | 'settings.plugins.action.updated'
    | 'settings.plugins.action.uninstalled'
}

export function pluginTaskSyncTranslationKey(task?: PluginTaskReloadSummary) {
  if (!task || task.applied) return undefined

  return task.reason === 'next_turn'
    ? 'settings.plugins.taskSync.nextRun'
    : 'settings.plugins.taskSync.failed'
}

export const pluginsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<PluginListResponse>(`/api/plugins${query}`)
  },

  detail: (id: string, cwd?: string) => {
    const query = new URLSearchParams({ id })
    if (cwd) query.set('cwd', cwd)
    return api.get<{ detail: PluginDetail }>(`/api/plugins/detail?${query.toString()}`)
  },

  enable: (payload: PluginActionPayload) =>
    api.post<{ ok: true; action: PluginAction }>('/api/plugins/enable', payload),

  disable: (payload: PluginActionPayload) =>
    api.post<{ ok: true; action: PluginAction }>('/api/plugins/disable', payload),

  update: (payload: PluginActionPayload) =>
    api.post<{ ok: true; action: PluginAction }>('/api/plugins/update', payload),

  uninstall: (payload: PluginActionPayload) =>
    api.post<{ ok: true; action: PluginAction }>('/api/plugins/uninstall', payload),

  install: (payload: { sourcePath: string; scope: 'user' | 'project'; cwd?: string }) =>
    api.post<{ ok: true; action: PluginAction }>('/api/plugins/install', payload),

  reload: (cwd?: string, taskId?: string) => {
    const query = new URLSearchParams()
    if (cwd) query.set('cwd', cwd)
    if (taskId) query.set('taskId', taskId)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return api.post<PluginReloadResponse>(
      `/api/plugins/reload${suffix}`,
      undefined,
      { timeout: 120_000 },
    )
  },
}
