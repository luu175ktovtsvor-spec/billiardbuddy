import { api } from './client'
import type { OutputStylesResponse, PermissionMode, UserSettings } from '../types/settings'

export const settingsApi = {
  getUser() {
    return api.get<UserSettings>('/api/settings/user')
  },

  updateUser(settings: Partial<UserSettings>) {
    return api.put<{ ok: true }>('/api/settings/user', settings)
  },

  getOutputStyles(workDir?: string | null) {
    const query = workDir ? `?workDir=${encodeURIComponent(workDir)}` : ''
    return api.get<OutputStylesResponse>(`/api/settings/output-styles${query}`)
  },

  setOutputStyle(outputStyle: string, workDir?: string | null) {
    return api.put<{
      ok: true
      outputStyle: string
      scope: OutputStylesResponse['scope']
      workDir: string | null
    }>('/api/settings/output-style', {
      outputStyle,
      ...(workDir ? { workDir } : {}),
    })
  },

  getPermissionMode() {
    return api.get<{ mode: PermissionMode }>('/api/permissions/mode')
  },

  setPermissionMode(mode: PermissionMode) {
    return api.put<{ ok: true; mode: PermissionMode }>('/api/permissions/mode', { mode })
  },
}
