import { productApi } from './client'
import type {
  DesktopSettings,
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
}
