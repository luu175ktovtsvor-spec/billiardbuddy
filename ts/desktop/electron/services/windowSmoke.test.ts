import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { writeWindowSmokeSnapshot } from './windowSmoke'

describe('Electron window smoke diagnostics', () => {
  it('stays disabled unless a log path is configured', () => {
    expect(() => writeWindowSmokeSnapshot(null, 'disabled', {})).not.toThrow()
  })

  it('writes a focused visible window snapshot for packaged UI diagnostics', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'billiardbuddy-window-smoke-'))
    const logPath = join(tempDir, 'window-smoke.jsonl')
    try {
      writeWindowSmokeSnapshot({
        getBounds: () => ({ x: 10, y: 20, width: 1280, height: 820 }),
        getTitle: () => 'BilliardBuddy',
        isDestroyed: () => false,
        isFocused: () => true,
        isFullScreen: () => false,
        isMaximized: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        webContents: {
          getURL: () => 'file:///app.asar/dist/index.html',
          isLoading: vi.fn(() => false),
        },
      } as never, 'did-finish-load', {
        BB_ELECTRON_WINDOW_SMOKE_LOG: logPath,
      })

      expect(JSON.parse(readFileSync(logPath, 'utf8')).trim).toBeUndefined()
      const payload = JSON.parse(readFileSync(logPath, 'utf8'))
      expect(payload).toMatchObject({
        reason: 'did-finish-load',
        title: 'BilliardBuddy',
        visible: true,
        focused: true,
        minimized: false,
        url: 'file:///app.asar/dist/index.html',
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('only writes detailed startup diagnostics when acceptance explicitly enables them', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'billiardbuddy-window-smoke-error-'))
    const logPath = join(tempDir, 'window-smoke.jsonl')
    try {
      const error = Object.assign(new Error('BB_STARTUP_FAILED'), {
        code: 'BB_STARTUP_FAILED',
        smokeDiagnostic: 'sidecar exited with migration failure',
      })
      writeWindowSmokeSnapshot(null, 'backend-failed', {
        BB_ELECTRON_WINDOW_SMOKE_LOG: logPath,
      }, { error })
      writeWindowSmokeSnapshot(null, 'backend-failed', {
        BB_ELECTRON_WINDOW_SMOKE_LOG: logPath,
        BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS: '1',
      }, { error })

      const [safe, diagnostic] = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(safe.error).toEqual({
        name: 'Error',
        message: 'BB_STARTUP_FAILED',
        code: 'BB_STARTUP_FAILED',
      })
      expect(diagnostic.error.diagnostic).toBe('sidecar exited with migration failure')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
