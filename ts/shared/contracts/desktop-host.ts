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

export interface DesktopHost {
  isDesktop: boolean
  platform: string
  runtime: {
    getServerUrl: () => Promise<string>
  }
  pickWorkspace?: () => Promise<string | null>
  pickVideoFiles?: () => Promise<string[] | null>
  pickPaths?: () => Promise<string[] | null>
  openPath?: (path: string) => Promise<string>
  revealPath?: (path: string) => Promise<boolean>
  onMenu?: (cb: (action: string) => void) => void
  preventSleep?: {
    start: () => Promise<boolean>
    stop: () => Promise<boolean>
  }
}
