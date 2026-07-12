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
  stateRoot: string
  api<T = unknown>(pathname: string, init?: RequestInit): Promise<T>
  restart(): Promise<DesktopSession>
}

type DesktopFixtures = {
  onboarded: boolean
  desktop: DesktopSession
}

export const test = base.extend<DesktopFixtures>({
  onboarded: [true, { option: true }],

  desktop: async ({ onboarded }, use, testInfo) => {
    const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'billiardbuddy-desktop-e2e-'))
    const stateRoot = path.join(isolatedRoot, 'state')
    const logPath = path.join(isolatedRoot, 'electron.log')
    const emptyBundledEnv = path.join(isolatedRoot, 'empty-bundled.env')
    writeFileSync(logPath, '')
    writeFileSync(emptyBundledEnv, '')
    let app: ElectronApplication | null = null
    let appProcess: ReturnType<ElectronApplication['process']> | null = null
    let window: Page | null = null
    let tracing = false

    try {
      const closeCurrent = async () => {
        if (window && tracing) {
          await window.context().tracing.stop().catch(() => {})
          tracing = false
        }
        if (app) {
          await Promise.race([
            app.close().catch(() => {}),
            new Promise(resolve => setTimeout(resolve, 5_000)),
          ])
          if (appProcess?.exitCode === null) appProcess.kill('SIGKILL')
        }
        app = null
        appProcess = null
        window = null
      }

      const launch = async (): Promise<DesktopSession> => {
        app = await _electron.launch({
          args: [mainEntry, `--user-data-dir=${path.join(isolatedRoot, 'electron')}`],
          env: {
            ...process.env,
            NODE_ENV: 'test',
            QF_UI_REACT: '1',
            QF_BUNDLED_ENV: emptyBundledEnv,
            QF_CONFIG_DIR: path.join(isolatedRoot, 'config'),
            BILLIARDBUDDY_STATE_DIR: stateRoot,
            BILLIARDBUDDY_WORKSPACE_DIR: path.join(isolatedRoot, 'workspace'),
            BILLIARDBUDDY_LIBRARY_DIR: path.join(isolatedRoot, 'library'),
            QF_ASSETS_AUTOSTART: '0',
            QF_SCHEDULER: '0',
            MEDIA_BACKEND_URL: '',
            PYTHON_BACKEND_URL: '',
            QF_MEDIA_BACKEND_URL: '',
            QF_GATEWAY_URL: '',
            QF_GATEWAY_TOKEN: '',
            OPENAI_BASE_URL: '',
            OPENAI_API_KEY: '',
            ARK_BASE_URL: '',
            ARK_API_KEY: '',
            SEEDREAM_BASE_URL: '',
            IMAGE_MODEL_NAME: '',
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
        return makeSession(app, window, sidecarBase)
      }

      const makeSession = (sessionApp: ElectronApplication, sessionWindow: Page, sidecarBase: string): DesktopSession => ({
        app: sessionApp,
        window: sessionWindow,
        sidecarBase,
        stateRoot,
        async api<T>(pathname: string, init?: RequestInit): Promise<T> {
          const response = await fetch(`${sidecarBase}${pathname}`, init)
          if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`)
          return await response.json() as T
        },
        async restart(): Promise<DesktopSession> {
          await closeCurrent()
          return await launch()
        },
      })

      const session = await launch()

      await use(session)
    } finally {
      const finalWindow = window as Page | null
      const finalApp = app as ElectronApplication | null
      const finalProcess = appProcess as ReturnType<ElectronApplication['process']> | null
      if (finalWindow && !finalWindow.isClosed()) {
        const screenshot = await finalWindow.screenshot().catch(() => null)
        if (screenshot) await testInfo.attach('desktop-final', { body: screenshot, contentType: 'image/png' })
      }

      if (finalWindow && tracing) {
        if (testInfo.status !== testInfo.expectedStatus) {
          const tracePath = testInfo.outputPath('trace.zip')
          await finalWindow.context().tracing.stop({ path: tracePath }).catch(() => {})
          await testInfo.attach('trace', { path: tracePath, contentType: 'application/zip' }).catch(() => {})
        } else {
          await finalWindow.context().tracing.stop().catch(() => {})
        }
      }

      const logs = readFileSync(logPath)
      if (logs.length > 0) await testInfo.attach('electron-sidecar-log', { body: logs, contentType: 'text/plain' })

      if (finalApp) {
        await Promise.race([
          finalApp.close().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 5_000)),
        ])
        if (finalProcess?.exitCode === null) finalProcess.kill('SIGKILL')
      }
      rmSync(isolatedRoot, { recursive: true, force: true })
    }
  },
})

export { expect }
