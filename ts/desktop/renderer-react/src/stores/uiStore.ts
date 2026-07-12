// UI/主题 store(对齐 cc uiStore:主题写到 <html data-theme>,localStorage 持久化,默认跟随系统)。
import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'

const THEME_KEY = 'qf-theme'

function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const v = window.localStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

function resolveEffective(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark'
  return 'light'
}

/** 把有效主题写到 <html data-theme>;'system' 时不写 data-theme,交给 CSS 的 prefers-color-scheme 兜。 */
function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

/** main.tsx 启动即调:先套上主题防闪。 */
export function initializeTheme() {
  applyTheme(readStoredTheme())
}

/** 主区当前视图(照 Codex 左栏:对话 / 生图 / 剪视频 / 已安排 / 插件 / 设置全页 各占主区)。默认对话。 */
export type MainNav = 'chat' | 'creation' | 'video' | 'scheduled' | 'plugins' | 'settings'

interface UiState {
  theme: ThemeMode
  effectiveTheme: 'light' | 'dark'
  sidebarCollapsed: boolean
  terminalOpen: boolean
  paletteOpen: boolean
  nav: MainNav
  setTheme: (mode: ThemeMode) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  toggleTerminal: () => void
  setPaletteOpen: (open: boolean) => void
  setNav: (nav: MainNav) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStoredTheme(),
  effectiveTheme: resolveEffective(readStoredTheme()),
  sidebarCollapsed: false,
  terminalOpen: false,
  paletteOpen: false,
  nav: 'chat',
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setNav: (nav) => set({ nav }),
  setTheme: (mode) => {
    applyTheme(mode)
    if (typeof window !== 'undefined') window.localStorage.setItem(THEME_KEY, mode)
    set({ theme: mode, effectiveTheme: resolveEffective(mode) })
  },
  toggleTheme: () => {
    const next: ThemeMode = get().effectiveTheme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
}))
