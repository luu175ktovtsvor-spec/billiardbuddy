import { create } from 'zustand'
import { isThemeMode, THEME_MODES, type ThemeMode } from '../types/settings'

const THEME_STORAGE_KEY = 'billiardbuddy-theme'
const ACTIVE_SETTINGS_TAB_STORAGE_KEY = 'billiardbuddy-active-settings-tab'

const SETTINGS_TABS = [
  'providers',
  'activity',
  'general',
  'h5Access',
  'terminal',
  'mcp',
  'agents',
  'skills',
  'memory',
  'plugins',
  'computerUse',
  'trace',
  'diagnostics',
  'about',
] as const

function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (isThemeMode(stored)) return stored
  } catch { /* localStorage unavailable */ }
  return 'system'
}

/** 系统是否处于深色。matchMedia 不可用时按浅色兜底。 */
function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

/** 把主题模式解析成实际生效的明暗:system → 跟随系统偏好。 */
export function resolveEffectiveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'dark') return 'dark'
  if (theme === 'light') return 'light'
  return systemPrefersDark() ? 'dark' : 'light'
}

function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value)
}

function getStoredSettingsTab(): SettingsTab {
  try {
    const stored = localStorage.getItem(ACTIVE_SETTINGS_TAB_STORAGE_KEY)
    if (isSettingsTab(stored) && stored !== 'providers') return stored
  } catch { /* localStorage unavailable */ }
  return 'general'
}

export function applyTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  // data-theme 写实际生效的明暗(system 解析后 = light/dark),CSS 只需 [data-theme="light"|"dark"] 两套。
  const effective = resolveEffectiveTheme(theme)
  document.documentElement.setAttribute('data-theme', effective)
  document.documentElement.style.colorScheme = effective
}

let systemThemeBound = false
/** 绑定系统主题变化监听:当前是「跟随系统」时,OS 明暗切换即时重刷生效主题。全局只绑一次。 */
function bindSystemThemeListener() {
  if (systemThemeBound || typeof window === 'undefined' || !window.matchMedia) return
  systemThemeBound = true
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (useUIStore.getState().theme === 'system') applyTheme('system')
  })
}

export function initializeTheme() {
  applyTheme(getStoredTheme())
  bindSystemThemeListener()
}

export type Toast = {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration?: number
}

export type SettingsTab =
  | 'providers'
  | 'activity'
  | 'general'
  | 'h5Access'
  | 'terminal'
  | 'mcp'
  | 'agents'
  | 'skills'
  | 'memory'
  | 'plugins'
  | 'computerUse'
  | 'trace'
  | 'diagnostics'
  | 'about'

type ActiveView = 'code' | 'scheduled' | 'terminal' | 'history' | 'settings'

type UIStore = {
  theme: ThemeMode
  sidebarOpen: boolean
  activeView: ActiveView
  activeSettingsTab: SettingsTab
  pendingSettingsTab: SettingsTab | null
  pendingMemoryPath: string | null
  activeModal: string | null
  toasts: Toast[]

  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setActiveView: (view: ActiveView) => void
  setActiveSettingsTab: (tab: SettingsTab) => void
  setPendingSettingsTab: (tab: SettingsTab | null) => void
  setPendingMemoryPath: (path: string | null) => void
  openModal: (id: string) => void
  closeModal: () => void
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

let toastCounter = 0

export const useUIStore = create<UIStore>((set) => ({
  theme: getStoredTheme(),
  sidebarOpen: true,
  activeView: 'code',
  activeSettingsTab: getStoredSettingsTab(),
  pendingSettingsTab: null,
  pendingMemoryPath: null,
  activeModal: null,
  toasts: [],

  setTheme: (theme) => {
    applyTheme(theme)
    try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* noop */ }
    set({ theme })
  },

  toggleTheme: () => {
    set((state) => {
      const currentIndex = THEME_MODES.indexOf(state.theme)
      const next = THEME_MODES[(currentIndex + 1) % THEME_MODES.length] ?? 'system'
      applyTheme(next)
      try { localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* noop */ }
      return { theme: next }
    })
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setActiveView: (view) => set({ activeView: view }),
  setActiveSettingsTab: (tab) => {
    try { localStorage.setItem(ACTIVE_SETTINGS_TAB_STORAGE_KEY, tab) } catch { /* noop */ }
    set({ activeSettingsTab: tab })
  },
  setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  setPendingMemoryPath: (path) => set({ pendingMemoryPath: path }),
  openModal: (id) => set({ activeModal: id }),
  closeModal: () => set({ activeModal: null }),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}`
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    // Auto-remove after duration
    const duration = toast.duration ?? 4000
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
