import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN,
  BILLIARDBUDDY_BROWSER_NATIVE_HOST,
  BILLIARDBUDDY_BROWSER_POINTER_FILE,
} from '../../../shared/product/browserNativeHost'
import { resolveSidecarExecutable } from './sidecarManager'
import { ElectronBrowserCapability } from './browserCapability'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('ElectronBrowserCapability', () => {
  it('installs a user-scoped fixed-origin native host and never exposes the UI capability', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-browser-install-'))
    roots.push(root)
    const desktopRoot = path.join(root, 'desktop')
    const resourcesPath = path.join(root, 'resources')
    const userDataPath = path.join(root, 'user-data')
    const configDir = path.join(userDataPath, 'config')
    const extensionPath = path.join(resourcesPath, 'browser-extension')
    await fs.mkdir(extensionPath, { recursive: true })
    await fs.writeFile(path.join(extensionPath, 'manifest.json'), '{}')
    const sidecar = resolveSidecarExecutable(desktopRoot)
    await fs.mkdir(path.dirname(sidecar), { recursive: true })
    await fs.writeFile(sidecar, '')
    const calls: Array<{ url: string; headers: Headers }> = []
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ state: 'waiting_for_extension', connected_sessions: 0, reason: 'EXTENSION_NOT_CONNECTED' })
    }
    const service = new ElectronBrowserCapability({
      desktopRoot,
      resourcesPath,
      isPackaged: true,
      userDataPath,
      configDir,
      homedir: root,
      platform: 'darwin',
      getServerUrl: async () => 'http://127.0.0.1:4567',
      uiCapability: 'ui-capability-secret',
      fetchFn: fetchFn as typeof fetch,
    })

    const status = await service.install()
    expect(status).toMatchObject({ native_host_installed: true, extension_available: true })
    const manifest = JSON.parse(await fs.readFile(service.nativeHostManifestPath(), 'utf8'))
    expect(manifest).toEqual({
      name: BILLIARDBUDDY_BROWSER_NATIVE_HOST,
      description: 'BilliardBuddy recruiting browser bridge',
      path: path.resolve(sidecar),
      type: 'stdio',
      allowed_origins: [BILLIARDBUDDY_BROWSER_EXTENSION_ORIGIN],
    })
    const pointer = JSON.parse(await fs.readFile(path.join(userDataPath, BILLIARDBUDDY_BROWSER_POINTER_FILE), 'utf8'))
    expect(pointer).toEqual({ version: 1, descriptor_path: path.join(configDir, 'billiardbuddy', 'browser', 'native-bridge.json') })
    expect(calls[0]?.headers.has('x-bb-browser-ui-capability')).toBe(false)
  })

  it('adds the Electron-only capability when reading or resolving task actions', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const service = new ElectronBrowserCapability({
      desktopRoot: '/app', resourcesPath: '/resources', isPackaged: true,
      userDataPath: '/data', configDir: '/data/config', homedir: '/home/example', platform: 'darwin',
      getServerUrl: async () => 'http://127.0.0.1:4567', uiCapability: 'ui-capability-secret',
      fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return Response.json(calls.length === 1 ? { actions: [] } : { action: { id: 'browser_action_1234' } })
      }) as typeof fetch,
    })
    await service.listActions('product_task_1234')
    await service.resolveAction('product_task_1234', 'browser_action_1234', 0, true)
    for (const call of calls) expect(new Headers(call.init?.headers).get('x-bb-browser-ui-capability')).toBe('ui-capability-secret')
  })
})
