/**
 * Renderer-independent Electron shell contracts. These belong to the desktop
 * host, not to any particular renderer implementation.
 */

export type AppMode = 'default' | 'portable'

export type AppModeConfig = {
  mode: AppMode
  portableDir: string | null
  defaultPortableDir: string | null
  activeConfigDir?: string | null
  configDirSource?: 'system' | 'environment' | 'portable'
}

export type AppModeSetInput = {
  mode: AppMode
  portableDir: string | null
}

export type DialogFileFilter = {
  name: string
  extensions: string[]
}

export type DialogOpenOptions = {
  directory?: boolean
  multiple?: boolean
  title?: string
  defaultPath?: string
  filters?: DialogFileFilter[]
}

export type DialogSaveOptions = {
  title?: string
  defaultPath?: string
  filters?: DialogFileFilter[]
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default'

export type DesktopNotificationOptions = {
  title: string
  body?: string
  icon?: string
  id?: number
  extra?: Record<string, unknown>
  target?: unknown
}

export type DesktopUpdateDownloadEvent =
  | { event: 'Started', data: { contentLength?: number | null } }
  | { event: 'Progress', data: { chunkLength: number } }
  | { event: 'Finished' }
