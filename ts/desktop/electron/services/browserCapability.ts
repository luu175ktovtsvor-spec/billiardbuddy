import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  BrowserCapabilityStatus,
  PublicRecruitingAction,
  RecruitingBrowserSetupStatus,
} from '../../../shared/product/browserCapability'
import {
  BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN,
  BILLIARDBUDDY_BROWSER_NATIVE_HOST,
  BILLIARDBUDDY_BROWSER_POINTER_FILE,
} from '../../../shared/product/browserNativeHost'
import { resolveSidecarExecutable } from './sidecarManager'

export type { RecruitingBrowserSetupStatus } from '../../../shared/product/browserCapability'

type BrowserCapabilityOptions = {
  desktopRoot: string
  resourcesPath: string
  isPackaged: boolean
  userDataPath: string
  configDir: string
  homedir?: string
  platform?: NodeJS.Platform
  getServerUrl(): Promise<string>
  uiCapability: string
  spawnSyncFn?: typeof spawnSync
  fetchFn?: typeof fetch
}

export class ElectronBrowserCapability {
  private readonly platform: NodeJS.Platform
  private readonly homedir: string
  private readonly spawnSyncFn: typeof spawnSync
  private readonly fetchFn: typeof fetch

  constructor(private readonly options: BrowserCapabilityOptions) {
    this.platform = options.platform ?? process.platform
    this.homedir = options.homedir ?? process.env.HOME ?? options.userDataPath
    this.spawnSyncFn = options.spawnSyncFn ?? spawnSync
    this.fetchFn = options.fetchFn ?? fetch
  }

  extensionPath(): string {
    return this.options.isPackaged
      ? path.join(this.options.resourcesPath, 'browser-extension')
      : path.join(this.options.desktopRoot, 'browser-extension')
  }

  nativeHostManifestPath(): string {
    if (this.platform === 'darwin') {
      return path.join(this.homedir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${BILLIARDBUDDY_BROWSER_NATIVE_HOST}.json`)
    }
    if (this.platform === 'win32') {
      return path.join(this.options.userDataPath, 'browser', `${BILLIARDBUDDY_BROWSER_NATIVE_HOST}.json`)
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(this.homedir, '.config'), 'google-chrome', 'NativeMessagingHosts', `${BILLIARDBUDDY_BROWSER_NATIVE_HOST}.json`)
  }

  async install(): Promise<RecruitingBrowserSetupStatus> {
    const extensionPath = this.extensionPath()
    if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) throw new Error('BROWSER_EXTENSION_MISSING')
    const executable = resolveSidecarExecutable(this.options.desktopRoot)
    if (!fs.existsSync(executable)) throw new Error('BROWSER_NATIVE_HOST_MISSING')
    const descriptorPath = path.join(this.options.configDir, 'billiardbuddy', 'browser', 'native-bridge.json')
    const pointerPath = path.join(this.options.userDataPath, BILLIARDBUDDY_BROWSER_POINTER_FILE)
    const manifestPath = this.nativeHostManifestPath()
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true })
    fs.writeFileSync(pointerPath, `${JSON.stringify({ version: 1, descriptor_path: descriptorPath })}\n`, { mode: 0o600 })
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      name: BILLIARDBUDDY_BROWSER_NATIVE_HOST,
      description: 'BilliardBuddy recruiting browser bridge',
      path: path.resolve(executable),
      type: 'stdio',
      allowed_origins: [BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN],
    })}\n`, { mode: 0o600 })
    if (this.platform === 'win32') {
      const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BILLIARDBUDDY_BROWSER_NATIVE_HOST}`
      const result = this.spawnSyncFn('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true, stdio: 'ignore' })
      if (result.status !== 0) throw new Error('BROWSER_NATIVE_HOST_REGISTRATION_FAILED')
    }
    return await this.status()
  }

  async status(): Promise<RecruitingBrowserSetupStatus> {
    const extensionPath = this.extensionPath()
    const nativeInstalled = fs.existsSync(this.nativeHostManifestPath())
    const extensionAvailable = fs.existsSync(path.join(extensionPath, 'manifest.json'))
    let bridge: BrowserCapabilityStatus = { state: 'not_configured', connected_sessions: 0, reason: 'BRIDGE_NOT_CONFIGURED' }
    try {
      const response = await this.fetchFn(`${await this.options.getServerUrl()}/api/browser/status`, { redirect: 'error' })
      if (response.ok) bridge = await response.json() as BrowserCapabilityStatus
    } catch {
      bridge = { state: 'degraded', connected_sessions: 0, reason: 'BRIDGE_DESCRIPTOR_FAILED' }
    }
    return { ...bridge, native_host_installed: nativeInstalled, extension_available: extensionAvailable, extension_path: extensionPath }
  }

  async listActions(taskId: string): Promise<PublicRecruitingAction[]> {
    const response = await this.request(`/api/browser/tasks/${encodeURIComponent(taskId)}/actions`)
    const body = await response.json() as { actions?: PublicRecruitingAction[] }
    if (!response.ok || !Array.isArray(body.actions)) throw new Error('BROWSER_ACTION_LIST_FAILED')
    return body.actions
  }

  async resolveAction(taskId: string, actionId: string, expectedRevision: number, approved: boolean): Promise<PublicRecruitingAction> {
    const response = await this.request(`/api/browser/tasks/${encodeURIComponent(taskId)}/actions/${encodeURIComponent(actionId)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: expectedRevision, approved }),
    })
    const body = await response.json() as { action?: PublicRecruitingAction; error?: string }
    if (!response.ok || !body.action) throw new Error(body.error || 'BROWSER_ACTION_RESOLVE_FAILED')
    return body.action
  }

  private async request(apiPath: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('x-bb-browser-ui-capability', this.options.uiCapability)
    return await this.fetchFn(`${await this.options.getServerUrl()}${apiPath}`, { ...init, headers, redirect: 'error' })
  }
}
