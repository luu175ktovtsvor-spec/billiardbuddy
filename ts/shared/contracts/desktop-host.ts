import { z } from 'zod'

export const DESKTOP_IPC = {
  getServerUrl: 'runtime:getServerUrl',
  pickWorkspace: 'desktop:pickWorkspace',
  pickVideoFiles: 'desktop:pickVideoFiles',
  pickPaths: 'desktop:pickPaths',
  openPath: 'desktop:openPath',
  revealPath: 'desktop:revealPath',
  menu: 'desktop:menu',
  preventSleepStart: 'desktop:preventSleep:start',
  preventSleepStop: 'desktop:preventSleep:stop',
} as const

export const desktopPickerOptionsSchema = z.object({
  defaultPath: z.string().max(4096).optional(),
}).strict()

export type DesktopPickerOptions = z.infer<typeof desktopPickerOptionsSchema>

export interface DesktopHost {
  isDesktop: boolean
  platform: string
  runtime: {
    getServerUrl: () => Promise<string>
  }
  pickWorkspace?: (options?: DesktopPickerOptions) => Promise<string | null>
  pickVideoFiles?: (options?: DesktopPickerOptions) => Promise<string[] | null>
  pickPaths?: (options?: DesktopPickerOptions) => Promise<string[] | null>
  openPath?: (path: string) => Promise<string>
  revealPath?: (path: string) => Promise<boolean>
  onMenu?: (cb: (action: string) => void) => void
  preventSleep?: {
    start: () => Promise<boolean>
    stop: () => Promise<boolean>
  }
}
