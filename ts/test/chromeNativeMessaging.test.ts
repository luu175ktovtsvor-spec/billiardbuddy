import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  BILLIARDBUDDY_CHROME_EXTENSION_ID,
  getChromeNativeMessagingHostStatus,
  installChromeNativeMessagingHost,
} from '../desktop/electron/services/chromeNativeMessaging'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('Chrome Native Messaging host status', () => {
  test('区分 Host 注册、随包扩展和真实在线连接', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-chrome-status-'))
    roots.push(root)
    const desktopRoot = path.join(root, 'desktop')
    const homeDirectory = path.join(root, 'home')
    const userDataDirectory = path.join(root, 'user-data')
    const plugin = path.join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins', 'billiardbuddy-chrome')
    await fs.mkdir(path.join(plugin, 'bin'), { recursive: true })
    await fs.mkdir(path.join(plugin, 'chrome-extension'), { recursive: true })
    await fs.writeFile(path.join(plugin, 'bin', 'billiardbuddy-chrome-native-host'), 'host')
    await fs.writeFile(path.join(plugin, 'chrome-extension', 'manifest.json'), '{}')
    await fs.writeFile(path.join(plugin, 'chrome-extension', 'background.js'), '// extension')

    let liveConnected = false
    const registration = {
      platform: 'darwin' as const,
      desktopRoot,
      homeDirectory,
      userDataDirectory,
      probeLiveExtension: async () => liveConnected
        ? { liveConnected: true, connectedTabCount: 2 }
        : { liveConnected: false },
    }
    await installChromeNativeMessagingHost(registration)

    const offline = await getChromeNativeMessagingHostStatus(registration)
    expect(offline).toMatchObject({
      supported: true,
      installed: true,
      extensionId: BILLIARDBUDDY_CHROME_EXTENSION_ID,
      extensionAvailable: true,
      liveConnected: false,
    })
    expect(offline.extensionPath).toBe(path.join(plugin, 'chrome-extension'))

    liveConnected = true
    await expect(getChromeNativeMessagingHostStatus(registration)).resolves.toMatchObject({
      installed: true,
      liveConnected: true,
      connectedTabCount: 2,
    })
  })
})
