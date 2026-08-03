import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type ComputerUseConfiguration = {
  allowedAppIds: string[]
}

function configurationPath(userDataPath: string): string {
  return path.join(userDataPath, 'agent-runtime', 'computer-use', 'config.json')
}

function validateMacBundleId(value: string): boolean {
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) && value.length <= 255
}

function validateWindowsExecutable(value: string): boolean {
  return path.isAbsolute(value) && /\.exe$/i.test(value) && value.length <= 32_767 && !/[\u0000\r\n]/.test(value)
}

function normalize(platform: NodeJS.Platform, appIds: readonly string[]): string[] {
  if (appIds.length > 64) throw new Error('BILLIARDBUDDY_COMPUTER_USE_APP_LIMIT')
  const output = new Set<string>()
  for (const raw of appIds) {
    if (typeof raw !== 'string') throw new Error('BILLIARDBUDDY_COMPUTER_USE_APP_INVALID')
    const value = raw.trim()
    const valid = platform === 'darwin'
      ? validateMacBundleId(value)
      : platform === 'win32'
        ? validateWindowsExecutable(value)
        : false
    if (!valid) throw new Error('BILLIARDBUDDY_COMPUTER_USE_APP_INVALID')
    output.add(platform === 'win32' ? path.normalize(value) : value)
  }
  return [...output].sort((left, right) => left.localeCompare(right))
}

export async function readComputerUseConfiguration(
  platform: NodeJS.Platform,
  userDataPath: string,
): Promise<ComputerUseConfiguration> {
  if (platform !== 'darwin' && platform !== 'win32') return { allowedAppIds: [] }
  const file = configurationPath(userDataPath)
  const raw = await fs.readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!raw) return { allowedAppIds: [] }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { throw new Error('BILLIARDBUDDY_COMPUTER_USE_CONFIGURATION_INVALID') }
  const configured = platform === 'darwin' ? parsed.allowedBundleIds : parsed.allowedExecutablePaths
  if (!Array.isArray(configured) || !configured.every(value => typeof value === 'string')) {
    throw new Error('BILLIARDBUDDY_COMPUTER_USE_CONFIGURATION_INVALID')
  }
  return { allowedAppIds: normalize(platform, configured) }
}

/** Write the one native adapter configuration consumed by Computer Use. */
export async function writeComputerUseConfiguration(
  platform: NodeJS.Platform,
  userDataPath: string,
  input: ComputerUseConfiguration,
): Promise<ComputerUseConfiguration> {
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('BILLIARDBUDDY_COMPUTER_USE_PLATFORM_UNSUPPORTED')
  const allowedAppIds = normalize(platform, input.allowedAppIds)
  const file = configurationPath(userDataPath)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const data = platform === 'darwin'
    ? { allowedBundleIds: allowedAppIds }
    : { allowedExecutablePaths: allowedAppIds }
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, file)
  return { allowedAppIds }
}
