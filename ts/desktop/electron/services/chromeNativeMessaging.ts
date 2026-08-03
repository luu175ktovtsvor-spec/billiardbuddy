import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
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
  installed: boolean
  manifestPath?: string
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
  const executable = chromeNativeHostExecutable(registration)
  const executableDetails = await fs.lstat(executable).catch(() => undefined)
  if (!executableDetails?.isFile() || executableDetails.isSymbolicLink()) {
    return { supported: true, installed: false }
  }
  const manifestPath = registration.platform === 'darwin'
    ? macosChromeNativeHostManifestPath(registration)
    : windowsChromeNativeHostManifestPath(registration)
  const raw = await fs.readFile(manifestPath, 'utf8').catch(() => undefined)
  if (!raw) return { supported: true, installed: false, manifestPath }
  let manifestMatches = false
  try {
    manifestMatches = sameManifest(JSON.parse(raw), chromeNativeHostManifest(executable))
  } catch {
    manifestMatches = false
  }
  if (!manifestMatches) return { supported: true, installed: false, manifestPath }
  if (registration.platform === 'win32') {
    const registry = await execFileAsync('reg.exe', ['query', windowsRegistryKey(), '/ve'], { windowsHide: true })
      .catch(() => undefined)
    if (!registry?.stdout.includes(manifestPath)) return { supported: true, installed: false, manifestPath }
  }
  return { supported: true, installed: true, manifestPath }
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
