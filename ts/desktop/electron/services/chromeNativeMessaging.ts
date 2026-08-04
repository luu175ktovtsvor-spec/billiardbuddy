import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { createConnection } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const BILLIARDBUDDY_CHROME_EXTENSION_ID = 'hkglcfbkjjaljnieaecddhihnleoocbb'
export const BILLIARDBUDDY_CHROME_NATIVE_HOST = 'com.billiardbuddy.chrome'

export type ChromeNativeMessagingRegistration = {
  platform: NodeJS.Platform
  /** The unpacked Electron app root, never a renderer supplied path. */
  desktopRoot: string
  /** Defaults to the real current user home and is injectable only for verification. */
  homeDirectory?: string
  /** Defaults to the real per-user AppData directory and is injectable only for verification. */
  appDataDirectory?: string
  /** Electron-owned user data root containing only short-lived Chrome bridge state. */
  userDataDirectory?: string
  /** Injectable only by service verification; Renderer never supplies this. */
  probeLiveExtension?: () => Promise<{ liveConnected: boolean, connectedTabCount?: number }>
}

type ChromeHostManifest = {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

export type ChromeNativeMessagingHostStatus = {
  supported: boolean
  /** Native Messaging registration only; this never implies the extension is installed. */
  installed: boolean
  manifestPath?: string
  extensionId?: string
  extensionPath?: string
  extensionAvailable?: boolean
  /** A successful authenticated status round-trip is the only live-install proof. */
  liveConnected?: boolean
  connectedTabCount?: number
}

type ChromeLiveStatus = { liveConnected: boolean, connectedTabCount?: number }

function extensionDirectory(registration: ChromeNativeMessagingRegistration): string {
  return path.join(
    registration.desktopRoot,
    'runtime-assets',
    'agent-marketplace',
    'plugins',
    'billiardbuddy-chrome',
    'chrome-extension',
  )
}

function defaultUserDataDirectory(registration: ChromeNativeMessagingRegistration): string | undefined {
  if (registration.userDataDirectory) return registration.userDataDirectory
  if (registration.platform === 'darwin') {
    return path.join(registration.homeDirectory ?? os.homedir(), 'Library', 'Application Support', 'BilliardBuddy')
  }
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'BilliardBuddy') : undefined
}

async function extensionAvailable(registration: ChromeNativeMessagingRegistration): Promise<boolean> {
  const directory = extensionDirectory(registration)
  const [manifest, background] = await Promise.all([
    fs.lstat(path.join(directory, 'manifest.json')).catch(() => undefined),
    fs.lstat(path.join(directory, 'background.js')).catch(() => undefined),
  ])
  return Boolean(
    manifest?.isFile() && !manifest.isSymbolicLink()
    && background?.isFile() && !background.isSymbolicLink(),
  )
}

async function probeLiveExtension(registration: ChromeNativeMessagingRegistration): Promise<ChromeLiveStatus> {
  const userData = defaultUserDataDirectory(registration)
  if (!userData) return { liveConnected: false }
  const statePath = path.join(userData, 'agent-runtime', 'chrome-control', 'bridge.json')
  const details = await fs.lstat(statePath).catch(() => undefined)
  if (!details?.isFile() || details.isSymbolicLink() || details.size > 4_096) return { liveConnected: false }
  let state: unknown
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')) } catch { return { liveConnected: false } }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { liveConnected: false }
  const { schemaVersion, port, token } = state as Record<string, unknown>
  if (
    schemaVersion !== 1
    || typeof port !== 'number'
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || typeof token !== 'string'
    || !/^[a-f0-9]{64}$/.test(token)
  ) return { liveConnected: false }

  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let response = ''
    let finished = false
    const done = (result: ChromeLiveStatus) => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(result)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(2_500, () => done({ liveConnected: false }))
    socket.on('error', () => done({ liveConnected: false }))
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, operation: 'status', arguments: {} })}\n`)
    })
    socket.on('data', chunk => {
      response += chunk
      if (response.length > 64 * 1024) return done({ liveConnected: false })
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        const parsed = JSON.parse(response.slice(0, newline)) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return done({ liveConnected: false })
        const record = parsed as Record<string, unknown>
        if (record.ok !== true || !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
          return done({ liveConnected: false })
        }
        const payload = record.payload as Record<string, unknown>
        const count = payload.connectedTabCount
        if (payload.connected !== true || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 10_000) {
          return done({ liveConnected: false })
        }
        done({ liveConnected: true, connectedTabCount: count })
      } catch {
        done({ liveConnected: false })
      }
    })
  })
}

function manifestFileName(): string {
  return `${BILLIARDBUDDY_CHROME_NATIVE_HOST}.json`
}

function windowsRegistryKey(): string {
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BILLIARDBUDDY_CHROME_NATIVE_HOST}`
}

export function chromeNativeHostExecutable(registration: ChromeNativeMessagingRegistration): string {
  const binary = registration.platform === 'win32'
    ? 'billiardbuddy-chrome-native-host.exe'
    : 'billiardbuddy-chrome-native-host'
  return path.join(registration.desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins', 'billiardbuddy-chrome', 'bin', binary)
}

export function chromeNativeHostManifest(executable: string): ChromeHostManifest {
  if (!path.isAbsolute(executable)) throw new Error('BILLIARDBUDDY_CHROME_HOST_PATH_INVALID')
  return {
    name: BILLIARDBUDDY_CHROME_NATIVE_HOST,
    description: 'BilliardBuddy Chrome native messaging host',
    path: executable,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${BILLIARDBUDDY_CHROME_EXTENSION_ID}/`],
  }
}

export function macosChromeNativeHostManifestPath(registration: ChromeNativeMessagingRegistration): string {
  const home = registration.homeDirectory ?? os.homedir()
  return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', manifestFileName())
}

export function windowsChromeNativeHostManifestPath(registration: ChromeNativeMessagingRegistration): string {
  const appData = registration.appDataDirectory ?? process.env.LOCALAPPDATA
  if (!appData) throw new Error('BILLIARDBUDDY_WINDOWS_LOCALAPPDATA_UNAVAILABLE')
  return path.join(appData, 'BilliardBuddy', 'chrome-native-hosts', manifestFileName())
}

async function writeManifest(file: string, manifest: ChromeHostManifest, platform: NodeJS.Platform): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (platform !== 'win32') await fs.chmod(file, 0o600)
}

function sameManifest(value: unknown, expected: ChromeHostManifest): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<ChromeHostManifest>
  return candidate.name === expected.name
    && candidate.description === expected.description
    && candidate.path === expected.path
    && candidate.type === expected.type
    && Array.isArray(candidate.allowed_origins)
    && candidate.allowed_origins.length === 1
    && candidate.allowed_origins[0] === expected.allowed_origins[0]
    && Object.keys(candidate).length === 5
}

export async function getChromeNativeMessagingHostStatus(
  registration: ChromeNativeMessagingRegistration,
): Promise<ChromeNativeMessagingHostStatus> {
  if (registration.platform !== 'darwin' && registration.platform !== 'win32') {
    return { supported: false, installed: false }
  }
  const extensionPath = extensionDirectory(registration)
  const [hasExtension, live] = await Promise.all([
    extensionAvailable(registration),
    registration.probeLiveExtension?.() ?? probeLiveExtension(registration),
  ])
  const extensionStatus = {
    extensionId: BILLIARDBUDDY_CHROME_EXTENSION_ID,
    extensionPath,
    extensionAvailable: hasExtension,
    ...live,
  }
  const executable = chromeNativeHostExecutable(registration)
  const executableDetails = await fs.lstat(executable).catch(() => undefined)
  if (!executableDetails?.isFile() || executableDetails.isSymbolicLink()) {
    return { supported: true, installed: false, ...extensionStatus }
  }
  const manifestPath = registration.platform === 'darwin'
    ? macosChromeNativeHostManifestPath(registration)
    : windowsChromeNativeHostManifestPath(registration)
  const raw = await fs.readFile(manifestPath, 'utf8').catch(() => undefined)
  if (!raw) return { supported: true, installed: false, manifestPath, ...extensionStatus }
  let manifestMatches = false
  try {
    manifestMatches = sameManifest(JSON.parse(raw), chromeNativeHostManifest(executable))
  } catch {
    manifestMatches = false
  }
  if (!manifestMatches) return { supported: true, installed: false, manifestPath, ...extensionStatus }
  if (registration.platform === 'win32') {
    const registry = await execFileAsync('reg.exe', ['query', windowsRegistryKey(), '/ve'], { windowsHide: true })
      .catch(() => undefined)
    if (!registry?.stdout.includes(manifestPath)) return { supported: true, installed: false, manifestPath, ...extensionStatus }
  }
  return { supported: true, installed: true, manifestPath, ...extensionStatus }
}

/**
 * Register only BilliardBuddy's fixed, signed Chrome extension ID. This is a
 * user-initiated setup operation; it is deliberately not run during app start.
 */
export async function installChromeNativeMessagingHost(registration: ChromeNativeMessagingRegistration): Promise<string> {
  const executable = chromeNativeHostExecutable(registration)
  const details = await fs.lstat(executable).catch(() => undefined)
  if (!details?.isFile() || details.isSymbolicLink()) throw new Error('BILLIARDBUDDY_CHROME_NATIVE_HOST_MISSING')
  const manifest = chromeNativeHostManifest(executable)
  if (registration.platform === 'darwin') {
    const file = macosChromeNativeHostManifestPath(registration)
    await writeManifest(file, manifest, registration.platform)
    return file
  }
  if (registration.platform === 'win32') {
    const file = windowsChromeNativeHostManifestPath(registration)
    await writeManifest(file, manifest, registration.platform)
    await execFileAsync('reg.exe', ['add', windowsRegistryKey(), '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { windowsHide: true })
    return file
  }
  throw new Error(`BILLIARDBUDDY_CHROME_PLATFORM_UNSUPPORTED:${registration.platform}`)
}

/** Remove only the manifest and HKCU key owned by BilliardBuddy Chrome. */
export async function uninstallChromeNativeMessagingHost(registration: ChromeNativeMessagingRegistration): Promise<void> {
  if (registration.platform === 'darwin') {
    await fs.rm(macosChromeNativeHostManifestPath(registration), { force: true })
    return
  }
  if (registration.platform === 'win32') {
    const file = windowsChromeNativeHostManifestPath(registration)
    await fs.rm(file, { force: true })
    await execFileAsync('reg.exe', ['delete', windowsRegistryKey(), '/f'], { windowsHide: true }).catch(() => undefined)
    return
  }
  throw new Error(`BILLIARDBUDDY_CHROME_PLATFORM_UNSUPPORTED:${registration.platform}`)
}
