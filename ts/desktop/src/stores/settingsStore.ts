import { create } from 'zustand'
import { productSettingsApi } from '../product/api/settings'
import {
  DESKTOP_LOCALES,
  isThemeMode,
  type AppMode,
  type AppModeConfig,
  type ChatSendBehavior,
  type DesktopTerminalSettings,
  type DesktopTerminalStartupShell,
  type NetworkSettings,
  type OutputStyleOption,
  type OutputStylesResponse,
  type ThemeMode,
  type UpdateProxyMode,
  type UpdateProxySettings,
  type WebSearchSettings,
} from '../types/settings'
import { getDesktopHost } from '../lib/desktopHost'
import type { Locale } from '../i18n'
import {
  APP_ZOOM_CONTROL_STEP,
  DEFAULT_APP_ZOOM,
  MAX_APP_ZOOM,
  MIN_APP_ZOOM,
  applyAppZoomLevel,
  normalizeAppZoomLevel,
  readStoredAppZoomLevel,
} from '../lib/appZoom'
import { useUIStore } from './uiStore'

const LOCALE_STORAGE_KEY = 'billiardbuddy-locale'
export const UI_ZOOM_MIN = MIN_APP_ZOOM
export const UI_ZOOM_MAX = MAX_APP_ZOOM
export const UI_ZOOM_STEP = APP_ZOOM_CONTROL_STEP
export const UI_ZOOM_DEFAULT = DEFAULT_APP_ZOOM
let desktopNotificationsSaveQueue: Promise<void> = Promise.resolve()

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored && (DESKTOP_LOCALES as readonly string[]).includes(stored)) return stored as Locale
  } catch { /* localStorage unavailable */ }
  return 'zh'
}

type SettingsStore = {
  thinkingEnabled: boolean
  autoDreamEnabled: boolean
  locale: Locale
  theme: ThemeMode
  chatSendBehavior: ChatSendBehavior
  outputStyle: string
  outputStyles: OutputStyleOption[]
  outputStyleScope: OutputStylesResponse['scope']
  outputStyleWorkDir: string | null
  outputStylesLoading: boolean
  outputStyleError: string | null
  skipWebFetchPreflight: boolean
  desktopNotificationsEnabled: boolean
  desktopTerminal: DesktopTerminalSettings
  webSearch: WebSearchSettings
  updateProxy: UpdateProxySettings
  network: NetworkSettings
  responseLanguage: string
  uiZoom: number
  isLoading: boolean
  error: string | null

  appMode: AppModeConfig
  appModeRequiresRestart: boolean

  fetchAll: () => Promise<void>
  setThinkingEnabled: (enabled: boolean) => Promise<void>
  setAutoDreamEnabled: (enabled: boolean) => Promise<void>
  setLocale: (locale: Locale) => void
  setTheme: (theme: ThemeMode) => Promise<void>
  setChatSendBehavior: (behavior: ChatSendBehavior) => Promise<void>
  fetchOutputStyles: (workDir?: string | null) => Promise<void>
  setOutputStyle: (outputStyle: string, workDir?: string | null) => Promise<void>
  setSkipWebFetchPreflight: (enabled: boolean) => Promise<void>
  setDesktopNotificationsEnabled: (enabled: boolean) => Promise<void>
  setDesktopTerminal: (settings: DesktopTerminalSettings) => Promise<void>
  setWebSearch: (settings: WebSearchSettings) => Promise<void>
  setUpdateProxy: (settings: UpdateProxySettings) => Promise<void>
  setNetwork: (settings: NetworkSettings) => Promise<void>
  setResponseLanguage: (language: string) => Promise<void>
  fetchAppMode: () => Promise<void>
  setAppMode: (mode: AppMode, portableDir?: string | null) => Promise<void>
  setUiZoom: (zoom: number) => void
}

type NetworkSettingsInput = Partial<Omit<NetworkSettings, 'proxy'>> & {
  proxy?: Partial<NetworkSettings['proxy']>
}

const DEFAULT_DESKTOP_TERMINAL_SETTINGS: DesktopTerminalSettings = {
  startupShell: 'system',
  customShellPath: '',
}

const DEFAULT_UPDATE_PROXY_SETTINGS: UpdateProxySettings = {
  mode: 'system',
  url: '',
}

const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  aiRequestTimeoutMs: 600_000,
  proxy: {
    mode: 'direct',
    url: '',
  },
}

const DEFAULT_OUTPUT_STYLE = 'default'
const DEFAULT_OUTPUT_STYLE_OPTIONS: OutputStyleOption[] = [
  {
    value: DEFAULT_OUTPUT_STYLE,
    label: 'Default',
    description: 'The Agent completes coding tasks efficiently and provides concise responses',
    source: 'built-in',
  },
]

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  thinkingEnabled: true,
  autoDreamEnabled: false,
  locale: getStoredLocale(),
  theme: useUIStore.getState().theme,
  chatSendBehavior: 'enter',
  outputStyle: DEFAULT_OUTPUT_STYLE,
  outputStyles: DEFAULT_OUTPUT_STYLE_OPTIONS,
  outputStyleScope: 'userSettings',
  outputStyleWorkDir: null,
  outputStylesLoading: false,
  outputStyleError: null,
  skipWebFetchPreflight: true,
  desktopNotificationsEnabled: false,
  desktopTerminal: DEFAULT_DESKTOP_TERMINAL_SETTINGS,
  webSearch: { enabled: true },
  updateProxy: DEFAULT_UPDATE_PROXY_SETTINGS,
  network: DEFAULT_NETWORK_SETTINGS,
  responseLanguage: '',
  uiZoom: readStoredAppZoomLevel(),
  isLoading: false,
  error: null,

  appMode: {
    mode: 'default',
    portableDir: null,
    defaultPortableDir: null,
    activeConfigDir: null,
    configDirSource: 'system',
  },
  appModeRequiresRestart: false,
  setUiZoom: (zoom: number) => {
    const level = normalizeAppZoomLevel(zoom)
    set({ uiZoom: level })
    void applyAppZoomLevel(level)
  },

  fetchAll: async () => {
    set({ isLoading: true, error: null })
    try {
      const [userSettings, runtimeSettings, desktopSettings] = await Promise.all([
        productSettingsApi.getUser(),
        productSettingsApi.getRuntime(),
        productSettingsApi.getDesktop(),
      ])
      // 旧数据可能存的是已下线的 'white'（isThemeMode 现在只认 light/dark/system）→ 回退跟随系统。
      const theme = isThemeMode(userSettings.theme) ? userSettings.theme : 'system'
      useUIStore.getState().setTheme(theme)
      set({
        thinkingEnabled: runtimeSettings.alwaysThinkingEnabled !== false,
        autoDreamEnabled: userSettings.autoDreamEnabled === true,
        theme,
        chatSendBehavior: normalizeChatSendBehavior(userSettings.chatSendBehavior),
        skipWebFetchPreflight: runtimeSettings.skipWebFetchPreflight !== false,
        desktopNotificationsEnabled: userSettings.desktopNotificationsEnabled === true,
        desktopTerminal: normalizeDesktopTerminalSettings(desktopSettings.desktopTerminal),
        webSearch: normalizeWebSearchSettings(userSettings.webSearch),
        updateProxy: normalizeUpdateProxySettings(desktopSettings.updateProxy),
        network: normalizeNetworkSettings(runtimeSettings.network),
        responseLanguage: typeof userSettings.language === 'string' ? userSettings.language : '',
        isLoading: false,
        error: null,
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load desktop settings'
      set({ isLoading: false, error: message })
      throw error
    }
  },

  setThinkingEnabled: async (enabled) => {
    const prev = get().thinkingEnabled
    set({ thinkingEnabled: enabled })
    try {
      await productSettingsApi.updateRuntime({ alwaysThinkingEnabled: enabled })
    } catch {
      set({ thinkingEnabled: prev })
    }
  },

  setAutoDreamEnabled: async (enabled) => {
    const prev = get().autoDreamEnabled
    set({ autoDreamEnabled: enabled })
    try {
      await productSettingsApi.updateUser({ autoDreamEnabled: enabled })
    } catch (error) {
      set({ autoDreamEnabled: prev })
      throw error
    }
  },

  setLocale: (locale) => {
    set({ locale })
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale) } catch { /* noop */ }
  },

  setTheme: async (theme) => {
    const prev = get().theme
    set({ theme })
    useUIStore.getState().setTheme(theme)
    try {
      await productSettingsApi.updateUser({ theme })
    } catch {
      set({ theme: prev })
      useUIStore.getState().setTheme(prev)
    }
  },

  setChatSendBehavior: async (behavior) => {
    const prev = get().chatSendBehavior
    const next = normalizeChatSendBehavior(behavior)
    set({ chatSendBehavior: next })
    try {
      await productSettingsApi.updateUser({ chatSendBehavior: next })
    } catch (error) {
      set({ chatSendBehavior: prev })
      throw error
    }
  },

  fetchOutputStyles: async (workDir) => {
    set({ outputStylesLoading: true, outputStyleError: null })
    try {
      const response = await productSettingsApi.getOutputStyles(workDir)
      set({
        outputStyle: normalizeOutputStyle(response.outputStyle),
        outputStyles: normalizeOutputStyleOptions(response.styles),
        outputStyleScope: response.scope,
        outputStyleWorkDir: response.workDir,
        outputStylesLoading: false,
        outputStyleError: null,
      })
    } catch (error) {
      set({
        outputStylesLoading: false,
        outputStyleError: getErrorMessage(error, 'Failed to load output styles.'),
      })
      throw error
    }
  },

  setOutputStyle: async (outputStyle, workDir) => {
    const prev = {
      outputStyle: get().outputStyle,
      outputStyleScope: get().outputStyleScope,
      outputStyleWorkDir: get().outputStyleWorkDir,
      outputStyleError: get().outputStyleError,
    }
    set({
      outputStyle,
      outputStyleError: null,
    })
    try {
      const result = await productSettingsApi.setOutputStyle(outputStyle, workDir)
      set({
        outputStyle: normalizeOutputStyle(result.outputStyle),
        outputStyleScope: result.scope,
        outputStyleWorkDir: result.workDir,
        outputStyleError: null,
      })
    } catch (error) {
      set({
        outputStyle: prev.outputStyle,
        outputStyleScope: prev.outputStyleScope,
        outputStyleWorkDir: prev.outputStyleWorkDir,
        outputStyleError: getErrorMessage(error, 'Failed to save output style.'),
      })
      throw error
    }
  },

  setSkipWebFetchPreflight: async (enabled) => {
    const prev = get().skipWebFetchPreflight
    set({ skipWebFetchPreflight: enabled })
    try {
      await productSettingsApi.updateRuntime({ skipWebFetchPreflight: enabled })
    } catch {
      set({ skipWebFetchPreflight: prev })
    }
  },

  setDesktopNotificationsEnabled: async (enabled) => {
    const prev = get().desktopNotificationsEnabled
    set({ desktopNotificationsEnabled: enabled })
    const save = desktopNotificationsSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (get().desktopNotificationsEnabled !== enabled) return
        await productSettingsApi.updateUser({ desktopNotificationsEnabled: enabled })
      })

    desktopNotificationsSaveQueue = save

    try {
      await save
    } catch {
      if (get().desktopNotificationsEnabled === enabled) {
        set({ desktopNotificationsEnabled: prev })
      }
    }
  },

  setDesktopTerminal: async (settings) => {
    const prev = get().desktopTerminal
    const next = normalizeDesktopTerminalSettings(settings)
    set({ desktopTerminal: next })
    try {
      await productSettingsApi.updateDesktop({ desktopTerminal: next })
    } catch (error) {
      set({ desktopTerminal: prev })
      throw error
    }
  },

  setWebSearch: async (webSearch) => {
    const prev = get().webSearch
    const next = normalizeWebSearchSettings(webSearch)
    set({ webSearch: next })
    try {
      await productSettingsApi.updateUser({ webSearch: next })
    } catch {
      set({ webSearch: prev })
    }
  },

  setUpdateProxy: async (settings) => {
    const prev = get().updateProxy
    const next = normalizeUpdateProxySettings(settings)
    set({ updateProxy: next })
    try {
      await productSettingsApi.updateDesktop({ updateProxy: next })
    } catch (error) {
      set({ updateProxy: prev })
      throw error
    }
  },

  setNetwork: async (settings) => {
    const prev = get().network
    const next = normalizeNetworkSettings(settings)
    set({ network: next })
    try {
      await productSettingsApi.updateRuntime({ network: next })
    } catch (error) {
      set({ network: prev })
      throw error
    }
  },

  setResponseLanguage: async (language) => {
    const prev = get().responseLanguage
    set({ responseLanguage: language })
    try {
      await productSettingsApi.updateUser({ language: language || null })
    } catch {
      set({ responseLanguage: prev })
    }
  },

  fetchAppMode: async () => {
    const host = getDesktopHost()
    if (!host.isDesktop) return
    try {
      const result: AppModeConfig = await host.appMode.get()
      set({ appMode: result })
    } catch { /* silently ignore when the desktop command is unavailable */ }
  },

  setAppMode: async (mode, portableDir) => {
    const host = getDesktopHost()
    if (!host.isDesktop) return
    const prev = get().appMode
    const newMode: AppModeConfig = {
      ...prev,
      mode,
      portableDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
      activeConfigDir: mode === 'portable'
        ? portableDir ?? prev.defaultPortableDir ?? prev.portableDir
        : null,
      configDirSource: mode === 'portable' ? 'portable' : 'system',
    }
    set({ appMode: newMode, appModeRequiresRestart: true })
    try {
      await host.appMode.set({
        mode,
        portableDir: newMode.portableDir || null,
      })
    } catch {
      set({ appMode: prev, appModeRequiresRestart: false })
    }
  },
}))

function normalizeWebSearchSettings(settings: WebSearchSettings | undefined): WebSearchSettings {
  return {
    enabled: settings?.enabled !== false,
  }
}

function normalizeChatSendBehavior(value: unknown): ChatSendBehavior {
  return value === 'modifierEnter' ? 'modifierEnter' : 'enter'
}

function normalizeOutputStyle(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : DEFAULT_OUTPUT_STYLE
}

function normalizeOutputStyleOptions(styles: OutputStyleOption[] | undefined): OutputStyleOption[] {
  if (!Array.isArray(styles) || styles.length === 0) return DEFAULT_OUTPUT_STYLE_OPTIONS
  const normalized = styles
    .filter((style): style is OutputStyleOption =>
      typeof style?.value === 'string' &&
      style.value.trim().length > 0 &&
      typeof style.label === 'string' &&
      typeof style.description === 'string',
    )
    .map(style => ({
      ...style,
      value: style.value.trim(),
      label: style.label.trim() || style.value.trim(),
      description: style.description.trim(),
    }))
  return normalized.length > 0 ? normalized : DEFAULT_OUTPUT_STYLE_OPTIONS
}

function isUpdateProxyMode(value: unknown): value is UpdateProxyMode {
  return value === 'system' || value === 'manual'
}

function normalizeUpdateProxySettings(
  settings: Partial<UpdateProxySettings> | undefined,
): UpdateProxySettings {
  const mode = isUpdateProxyMode(settings?.mode)
    ? settings.mode
    : DEFAULT_UPDATE_PROXY_SETTINGS.mode
  return {
    mode,
    url: typeof settings?.url === 'string' ? settings.url.trim() : '',
  }
}

function normalizeNetworkSettings(
  settings: NetworkSettingsInput | undefined,
): NetworkSettings {
  const timeout = typeof settings?.aiRequestTimeoutMs === 'number' && Number.isFinite(settings.aiRequestTimeoutMs)
    ? Math.min(Math.max(Math.round(settings.aiRequestTimeoutMs), 30_000), 1_800_000)
    : DEFAULT_NETWORK_SETTINGS.aiRequestTimeoutMs
  const proxyMode = settings?.proxy?.mode === 'manual'
    ? 'manual'
    : settings?.proxy?.mode === 'system'
      ? 'system'
      : 'direct'

  return {
    aiRequestTimeoutMs: timeout,
    proxy: {
      mode: proxyMode,
      url: proxyMode === 'manual' && typeof settings?.proxy?.url === 'string'
        ? settings.proxy.url.trim()
        : '',
    },
  }
}

function normalizeDesktopTerminalSettings(
  settings: Partial<DesktopTerminalSettings> | undefined,
): DesktopTerminalSettings {
  const startupShell = isDesktopTerminalStartupShell(settings?.startupShell)
    ? settings.startupShell
    : DEFAULT_DESKTOP_TERMINAL_SETTINGS.startupShell

  return {
    startupShell,
    customShellPath: typeof settings?.customShellPath === 'string'
      ? settings.customShellPath
      : DEFAULT_DESKTOP_TERMINAL_SETTINGS.customShellPath,
  }
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}

function isDesktopTerminalStartupShell(value: unknown): value is DesktopTerminalStartupShell {
  return value === 'system'
    || value === 'pwsh'
    || value === 'powershell'
    || value === 'cmd'
    || value === 'custom'
}
