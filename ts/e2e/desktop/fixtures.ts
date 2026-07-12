import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { test as base, expect } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))
const tsRoot = path.resolve(here, '../..')
const mainEntry = path.join(tsRoot, 'desktop/electron/main.mjs')

export interface DesktopSession {
  app: ElectronApplication
  window: Page
  sidecarBase: string
  api<T = unknown>(pathname: string, init?: RequestInit): Promise<T>
}

type DesktopFixtures = {
  onboarded: boolean
  desktop: DesktopSession
}

export const test = base.extend<DesktopFixtures>({
  onboarded: [true, { option: true }],

  desktop: async ({ onboarded }, use, testInfo) => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'billiardbuddy-desktop-e2e-'))
    const logPath = path.join(isolatedRoot, 'electron.log')
    writeFileSync(logPath, '')
    let app: ElectronApplication | null = null
    let appProcess: ReturnType<ElectronApplication['process']> | null = null
    let window: Page | null = null
    let tracing = false

    try {
      app = await _electron.launch({
        args: [mainEntry, `--user-data-dir=${path.join(isolatedRoot, 'electron')}`],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          QF_UI_REACT: '1',
          QF_CONFIG_DIR: path.join(isolatedRoot, 'config'),
          BILLIARDBUDDY_STATE_DIR: path.join(isolatedRoot, 'state'),
          BILLIARDBUDDY_WORKSPACE_DIR: path.join(isolatedRoot, 'workspace'),
          BILLIARDBUDDY_LIBRARY_DIR: path.join(isolatedRoot, 'library'),
          QF_ASSETS_AUTOSTART: '0',
          QF_SCHEDULER: '0',
        },
      })
      appProcess = app.process()
      appProcess.stdout?.on('data', chunk => appendFileSync(logPath, `[stdout] ${chunk}`))
      appProcess.stderr?.on('data', chunk => appendFileSync(logPath, `[stderr] ${chunk}`))

      window = await app.firstWindow()
      await window.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
      tracing = true
      await window.waitForLoadState('domcontentloaded')

      if (onboarded) {
        await window.evaluate(() => localStorage.setItem('qf.onboarding.done', '1'))
        await window.reload()
        await expect(window.getByTestId('chat-input')).toBeVisible()
      } else {
        await expect(window.getByTestId('onboarding')).toBeVisible()
      }

      const sidecarBase = await window.evaluate(() => {
        const host = (globalThis as unknown as { desktopHost?: { runtime?: { getServerUrl?: () => Promise<string> } } }).desktopHost
        return host?.runtime?.getServerUrl?.() ?? null
      })
      if (!sidecarBase) throw new Error('preload 未返回 sidecar 地址')

      await use({
        app,
        window,
        sidecarBase,
        async api<T>(pathname: string, init?: RequestInit): Promise<T> {
          const response = await fetch(`${sidecarBase}${pathname}`, init)
          if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`)
          return await response.json() as T
        },
      })
    } finally {
      if (window && !window.isClosed()) {
        const screenshot = await window.screenshot().catch(() => null)
        if (screenshot) await testInfo.attach('desktop-final', { body: screenshot, contentType: 'image/png' })
      }

      if (window && tracing) {
        if (testInfo.status !== testInfo.expectedStatus) {
          const tracePath = testInfo.outputPath('trace.zip')
          await window.context().tracing.stop({ path: tracePath }).catch(() => {})
          await testInfo.attach('trace', { path: tracePath, contentType: 'application/zip' }).catch(() => {})
        } else {
          await window.context().tracing.stop().catch(() => {})
        }
      }

      const logs = readFileSync(logPath)
      if (logs.length > 0) await testInfo.attach('electron-sidecar-log', { body: logs, contentType: 'text/plain' })

      if (app) {
        await Promise.race([
          app.close().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ])
        if (appProcess?.exitCode === null) appProcess.kill('SIGKILL')
      }
      rmSync(isolatedRoot, { recursive: true, force: true })
    }
  },
})

export { expect }
