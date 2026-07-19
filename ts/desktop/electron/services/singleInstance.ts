import type { App, BrowserWindow } from 'electron'
import { showMainWindow } from './windows'

export function acquireSingleInstanceLock(
  app: App,
  getMainWindow: () => BrowserWindow | null,
  env: NodeJS.ProcessEnv = process.env,
  onSecondInstance?: (commandLine: readonly string[]) => void,
): boolean {
  if (env.BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK === '1') {
    return true
  }

  const hasLock = app.requestSingleInstanceLock()
  if (!hasLock) {
    app.quit()
    return false
  }

  app.on('second-instance', (_event, commandLine) => {
    showMainWindow(getMainWindow(), app)
    onSecondInstance?.(commandLine)
  })

  return true
}
