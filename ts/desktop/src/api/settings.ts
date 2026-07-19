import { api } from './client'
import type {
  DesktopSettings,
  OutputStylesResponse,
  RuntimeSettings,
  UserSettings,
  UserSettingsUpdate,
} from '../types/settings'

export const settingsApi = {
  getUser() {
    return api.get<UserSettings>('/api/settings/user')
  },

  updateUser(settings: UserSettingsUpdate) {
    return api.put<{ ok: true }>('/api/settings/user', settings)
  },

  getRuntime() {
    return api.get<RuntimeSettings>('/api/settings/runtime')
  },

  updateRuntime(settings: Partial<RuntimeSettings>) {
    return api.put<{ ok: true }>('/api/settings/runtime', settings)
  },

  getDesktop() {
    return api.get<DesktopSettings>('/api/settings/desktop')
  },

  updateDesktop(settings: Partial<DesktopSettings>) {
    return api.put<{ ok: true }>('/api/settings/desktop', settings)
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
}
