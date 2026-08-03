import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type BrowserPolicyKind = 'browser-use' | 'chrome-control'

export type BrowserPolicyConfiguration = {
  allowedHosts: string[]
  blockedHosts: string[]
}

function configurationPath(userDataPath: string, kind: BrowserPolicyKind): string {
  return path.join(userDataPath, 'agent-runtime', kind, 'config.json')
}

function normalizeRules(values: readonly string[]): string[] {
  if (values.length > 256) throw new Error('BILLIARDBUDDY_BROWSER_POLICY_LIMIT')
  const output = new Set<string>()
  for (const raw of values) {
    if (typeof raw !== 'string') throw new Error('BILLIARDBUDDY_BROWSER_POLICY_HOST_INVALID')
    const value = raw.trim().toLowerCase().replace(/\.$/, '')
    const host = value.startsWith('*.') ? value.slice(2) : value
    if (
      !host
      || host.length > 253
      || !/^[a-z0-9.-]+$/.test(host)
      || host.startsWith('.')
      || host.endsWith('.')
      || host.includes('..')
    ) throw new Error('BILLIARDBUDDY_BROWSER_POLICY_HOST_INVALID')
    output.add(value)
  }
  return [...output].sort((left, right) => left.localeCompare(right))
}

function normalize(input: BrowserPolicyConfiguration): BrowserPolicyConfiguration {
  return {
    allowedHosts: normalizeRules(input.allowedHosts),
    blockedHosts: normalizeRules(input.blockedHosts),
  }
}

export async function readBrowserPolicyConfiguration(
  userDataPath: string,
  kind: BrowserPolicyKind,
): Promise<BrowserPolicyConfiguration> {
  const file = configurationPath(userDataPath, kind)
  const raw = await fs.readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!raw) return { allowedHosts: [], blockedHosts: [] }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(raw) as Record<string, unknown> } catch { throw new Error('BILLIARDBUDDY_BROWSER_POLICY_INVALID') }
  if (
    !Array.isArray(parsed.allowedHosts)
    || !parsed.allowedHosts.every(value => typeof value === 'string')
    || !Array.isArray(parsed.blockedHosts)
    || !parsed.blockedHosts.every(value => typeof value === 'string')
  ) throw new Error('BILLIARDBUDDY_BROWSER_POLICY_INVALID')
  return normalize({ allowedHosts: parsed.allowedHosts, blockedHosts: parsed.blockedHosts })
}

export async function writeBrowserPolicyConfiguration(
  userDataPath: string,
  kind: BrowserPolicyKind,
  input: BrowserPolicyConfiguration,
): Promise<BrowserPolicyConfiguration> {
  const configuration = normalize(input)
  const file = configurationPath(userDataPath, kind)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return configuration
}
