import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { test as base, expect } from '@playwright/test'
import { PNG } from 'pngjs'

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
    let imageServer: Server | null = null
    let squareRetryRequestCount = 0

    try {
      const candidatePng = (width: number, height: number, red: number, green: number, blue: number) => {
        const png = new PNG({ width, height })
        for (let i = 0; i < png.data.length; i += 4) {
          png.data[i] = red
          png.data[i + 1] = green
          png.data[i + 2] = blue
          png.data[i + 3] = 255
        }
        return PNG.sync.write(png).toString('base64')
      }
      const colors = [[24, 74, 58], [120, 46, 38], [42, 58, 104]] as const
      imageServer = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks).toString('utf8')
        let count = 1
        let width = 64
        let height = 64
        let imageSize = ''
        if (req.headers['content-type']?.includes('application/json')) {
          try {
            const parsed = JSON.parse(raw)
            count = Math.max(1, Math.min(4, Number(parsed.n ?? 1)))
            const match = typeof parsed.size === 'string' ? parsed.size.match(/^(\d+)x(\d+)$/) : null
            if (match) {
              imageSize = parsed.size
              width = Number(match[1])
              height = Number(match[2])
            }
          } catch { count = 1 }
        } else if (req.headers['content-type']?.includes('multipart/form-data')) {
          const countMatch = raw.match(/name="n"\r?\n\r?\n(\d+)/)
          const sizeMatch = raw.match(/name="size"\r?\n\r?\n(\d+)x(\d+)/)
          if (countMatch) count = Math.max(1, Math.min(4, Number(countMatch[1])))
          if (sizeMatch) {
            imageSize = `${sizeMatch[1]}x${sizeMatch[2]}`
            width = Number(sizeMatch[1])
            height = Number(sizeMatch[2])
          }
        }
        if (imageSize === '1216x3040') {
          await new Promise(resolve => setTimeout(resolve, 10_000))
        }
        if (imageSize === '1920x1920') {
          squareRetryRequestCount += 1
          if (squareRetryRequestCount <= 3) {
            res.writeHead(502, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'e2e transient image failure' }))
            return
          }
        }
        const body = JSON.stringify({ data: colors.slice(0, count).map(([red, green, blue], index) => ({ b64_json: candidatePng(width, height, red, green, blue), id: `e2e-image-${Date.now()}-${index}` })) })
        if (url.pathname.endsWith('/images/generations') || url.pathname.endsWith('/images/edits')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      })
      await new Promise<void>((resolve, reject) => imageServer!.listen(0, '127.0.0.1', resolve).once('error', reject))
      const imageBase = `http://127.0.0.1:${(imageServer.address() as AddressInfo).port}/v1`

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
            QF_GATEWAY_URL: imageBase,
            QF_GATEWAY_TOKEN: 'desktop-e2e-token',
            OPENAI_BASE_URL: imageBase,
            OPENAI_API_KEY: 'desktop-e2e-token',
            QF_GPT_IMAGE_ASYNC: '0',
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
      if (imageServer) await new Promise<void>(resolve => imageServer!.close(() => resolve()))
      rmSync(isolatedRoot, { recursive: true, force: true })
    }
  },
})

export { expect }
