import { productApi } from './client'
import type {
  DesktopSettings,
  OutputStylesResponse,
  RuntimeSettings,
  UserSettings,
  UserSettingsUpdate,
} from '../../types/settings'

export const productSettingsApi = {
  getUser() {
    return productApi.get<UserSettings>('/api/product/settings/user')
  },

  updateUser(settings: UserSettingsUpdate) {
    return productApi.patch<{ ok: true }>('/api/product/settings/user', settings)
  },

  getRuntime() {
    return productApi.get<RuntimeSettings>('/api/product/settings/runtime')
  },

  updateRuntime(settings: Partial<RuntimeSettings>) {
    return productApi.patch<{ ok: true }>('/api/product/settings/runtime', settings)
  },

  getDesktop() {
    return productApi.get<DesktopSettings>('/api/product/settings/desktop')
  },

  updateDesktop(settings: Partial<DesktopSettings>) {
    return productApi.patch<{ ok: true }>('/api/product/settings/desktop', settings)
  },

  getOutputStyles(workDir?: string | null) {
    const query = workDir ? `?workDir=${encodeURIComponent(workDir)}` : ''
    return productApi.get<OutputStylesResponse>(`/api/product/settings/output-styles${query}`)
  },

  setOutputStyle(outputStyle: string, workDir?: string | null) {
    return productApi.patch<{
      ok: true
      outputStyle: string
      scope: OutputStylesResponse['scope']
      workDir: string | null
    }>('/api/product/settings/output-style', {
      outputStyle,
      ...(workDir ? { workDir } : {}),
    })
  },
}
