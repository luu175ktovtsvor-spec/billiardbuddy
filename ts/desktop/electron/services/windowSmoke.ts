import { appendFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'

export type WindowSmokeEnv = {
  BB_ELECTRON_WINDOW_SMOKE_LOG?: string
  BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS?: string
}

type WindowSmokeDetails = {
  error?: unknown
}

type WindowSmokeWindow = Pick<
  BrowserWindow,
  'getBounds' | 'getTitle' | 'isDestroyed' | 'isFocused' | 'isFullScreen' | 'isMaximized' | 'isMinimized' | 'isVisible'
> & {
  webContents?: Pick<BrowserWindow['webContents'], 'getURL' | 'isLoading'>
}

export function writeWindowSmokeSnapshot(
  window: WindowSmokeWindow | null,
  reason: string,
  env: WindowSmokeEnv = process.env,
  details: WindowSmokeDetails = {},
) {
  const logPath = env.BB_ELECTRON_WINDOW_SMOKE_LOG
  if (!logPath) return

  const payload = window
    ? {
        reason,
        destroyed: window.isDestroyed(),
        title: window.getTitle(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        minimized: window.isMinimized(),
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
        bounds: window.getBounds(),
        url: window.webContents?.getURL() ?? null,
        loading: window.webContents?.isLoading() ?? null,
      }
    : {
        reason,
        missingWindow: true,
      }

  appendFileSync(logPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    ...payload,
    ...(details.error === undefined ? {} : {
      error: serializeSmokeError(details.error, env),
    }),
  })}\n`)
}

function serializeSmokeError(error: unknown, env: WindowSmokeEnv) {
  const record = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {}
  const serialized: Record<string, unknown> = {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  }
  if (typeof record.code === 'string' || typeof record.code === 'number') {
    serialized.code = record.code
  }
  if (env.BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS === '1' && typeof record.smokeDiagnostic === 'string') {
    serialized.diagnostic = record.smokeDiagnostic.slice(0, 16_384)
  }
  return serialized
}
