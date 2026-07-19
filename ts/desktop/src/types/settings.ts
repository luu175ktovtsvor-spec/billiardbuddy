// Source: src/server/api/settings.ts

export const THEME_MODES = ['light', 'dark', 'system'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

/** Supported product interface languages kept in desktop-local persistence. */
export const DESKTOP_LOCALES = ['en', 'zh', 'zh-TW', 'jp', 'kr'] as const
export type DesktopLocale = (typeof DESKTOP_LOCALES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

export type ChatSendBehavior = 'enter' | 'modifierEnter'

export type OutputStyleSource =
  | 'built-in'
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'plugin'

export type OutputStyleOption = {
  value: string
  label: string
  description: string
  source: OutputStyleSource
}

export type OutputStylesResponse = {
  outputStyle: string
  styles: OutputStyleOption[]
  scope: 'userSettings' | 'localSettings'
  workDir: string | null
}

export type WebSearchSettings = {
  /**
   * Product-facing preference only.  Backend selection and credentials stay
   * inside the managed gateway rather than in the desktop settings surface.
   */
  enabled?: boolean
}

export type UpdateProxyMode = 'system' | 'manual'

export type UpdateProxySettings = {
  mode: UpdateProxyMode
  url: string
}

export type NetworkProxyMode = 'direct' | 'system' | 'manual'

export type NetworkProxySettings = {
  mode: NetworkProxyMode
  url: string
}

export type NetworkSettings = {
  aiRequestTimeoutMs: number
  proxy: NetworkProxySettings
}

export type DesktopTerminalStartupShell =
  | 'system'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'custom'

export type DesktopTerminalSettings = {
  startupShell: DesktopTerminalStartupShell
  customShellPath: string
}

export type UserSettings = {
  autoDreamEnabled?: boolean
  theme?: ThemeMode
  chatSendBehavior?: ChatSendBehavior
  desktopNotificationsEnabled?: boolean
  webSearch?: WebSearchSettings
  language?: string
}

export type UserSettingsUpdate = Partial<Omit<UserSettings, 'language'>> & {
  /** Null explicitly clears the persisted language preference. */
  language?: string | null
}

export type RuntimeSettings = {
  alwaysThinkingEnabled?: boolean
  skipWebFetchPreflight?: boolean
  network?: {
    aiRequestTimeoutMs?: number
    proxy?: Partial<NetworkProxySettings>
  }
}

export type DesktopSettings = {
  desktopTerminal?: Partial<DesktopTerminalSettings>
  updateProxy?: Partial<UpdateProxySettings>
}

export type AppMode = 'default' | 'portable'

export type AppModeConfig = {
  mode: AppMode
  portableDir: string | null
  defaultPortableDir: string | null
  activeConfigDir?: string | null
  configDirSource?: 'system' | 'environment' | 'portable'
}
