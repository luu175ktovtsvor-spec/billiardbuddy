import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { lock } from '../../utils/lockfile.js'
import { getProductConfigDir } from '../product/productPaths.js'

export type ProductMcpScope = 'user' | 'project' | 'local'
export type ProductMcpStdioConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
export type ProductMcpRemoteConfig = { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; headersHelper?: string; oauth?: { clientId?: string; callbackPort?: number } }
export type ProductMcpServerConfig = ProductMcpStdioConfig | ProductMcpRemoteConfig
export type ScopedProductMcpServerConfig = ProductMcpServerConfig & { scope: ProductMcpScope }
export type ProductMcpConfigSnapshot = { servers: Record<string, ScopedProductMcpServerConfig>; disabled: Set<string> }

const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const SERVER_NAME = /^[\p{L}\p{N}_-]{1,128}$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function canonicalProjected(candidate: string): Promise<string> {
  let current = path.resolve(candidate)
  const suffix: string[] = []
  while (true) {
    try { return path.join(await fs.realpath(current), ...suffix.reverse()) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.push(path.basename(current))
      current = parent
    }
  }
}

async function assertContained(filePath: string, allowedRoot: string): Promise<void> {
  const [root, candidate] = await Promise.all([canonicalProjected(allowedRoot), canonicalProjected(filePath)])
  if (!isInside(root, candidate)) throw new Error('MCP_CONFIGURATION_INVALID')
}

function stringMap(value: unknown, kind: 'environment' | 'headers'): Record<string, string> | undefined {
  const source = object(value)
  if (!source) return undefined
  const entries = Object.entries(source)
  if (entries.length > 128 || entries.some(([key, item]) => (
    !(kind === 'headers' ? HEADER_NAME : ENV_NAME).test(key)
    || typeof item !== 'string'
    || item.length > (kind === 'headers' ? 8_192 : 65_536)
    || /[\r\n\0]/.test(item)
  ))) throw new Error('MCP_CONFIGURATION_INVALID')
  return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined
}

export function parseProductMcpServerConfig(value: unknown): ProductMcpServerConfig {
  const source = object(value)
  if (!source) throw new Error('MCP_CONFIGURATION_INVALID')
  const type = source.type ?? 'stdio'
  if (type === 'stdio') {
    if (typeof source.command !== 'string' || !source.command.trim() || source.command.length > 8_192 || source.command.includes('\0')) throw new Error('MCP_CONFIGURATION_INVALID')
    if (source.args !== undefined && (!Array.isArray(source.args) || source.args.length > 256 || source.args.some(item => typeof item !== 'string' || item.length > 8_192 || item.includes('\0')))) throw new Error('MCP_CONFIGURATION_INVALID')
    return {
      type: 'stdio', command: source.command.trim(),
      ...(Array.isArray(source.args) ? { args: source.args as string[] } : {}),
      ...(stringMap(source.env, 'environment') ? { env: stringMap(source.env, 'environment') } : {}),
    }
  }
  if (type === 'http' || type === 'sse') {
    if (typeof source.url !== 'string' || source.url.length > 8_192) throw new Error('MCP_CONFIGURATION_INVALID')
    let url: URL
    try { url = new URL(source.url) } catch { throw new Error('MCP_CONFIGURATION_INVALID') }
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)))) throw new Error('MCP_CONFIGURATION_INVALID')
    const oauth = object(source.oauth)
    const headersHelper = source.headersHelper
    if (headersHelper !== undefined && (
      typeof headersHelper !== 'string'
      || !path.isAbsolute(headersHelper)
      || !headersHelper.trim()
      || headersHelper.length > 8_192
      || headersHelper.includes('\0')
    )) throw new Error('MCP_CONFIGURATION_INVALID')
    const callbackPort = oauth?.callbackPort
    if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || Number(callbackPort) < 1 || Number(callbackPort) > 65_535)) throw new Error('MCP_CONFIGURATION_INVALID')
    return {
      type, url: url.toString(),
      ...(stringMap(source.headers, 'headers') ? { headers: stringMap(source.headers, 'headers') } : {}),
      ...(typeof headersHelper === 'string' ? { headersHelper: path.resolve(headersHelper) } : {}),
      ...(oauth ? { oauth: {
        ...(typeof oauth.clientId === 'string' && oauth.clientId.trim() && oauth.clientId.length <= 1_024 ? { clientId: oauth.clientId.trim() } : {}),
        ...(callbackPort !== undefined ? { callbackPort: Number(callbackPort) } : {}),
      } } : {}),
    }
  }
  throw new Error('MCP_CONFIGURATION_INVALID')
}

async function readJson(filePath: string, allowedRoot: string): Promise<Record<string, unknown>> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>
  try { stat = await fs.lstat(filePath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('MCP_CONFIGURATION_INVALID')
  await assertContained(filePath, allowedRoot)
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!object(parsed)) throw new Error('MCP_CONFIGURATION_INVALID')
  return parsed as Record<string, unknown>
}

function serversFrom(value: Record<string, unknown>, scope: ProductMcpScope): Record<string, ScopedProductMcpServerConfig> {
  const raw = object(value.mcpServers)
  if (!raw) return {}
  return Object.fromEntries(Object.entries(raw).map(([name, config]) => {
    if (!SERVER_NAME.test(name)) throw new Error('MCP_CONFIGURATION_INVALID')
    return [name, { ...parseProductMcpServerConfig(config), scope }]
  }))
}

function disabledFrom(value: Record<string, unknown>): string[] {
  if (value.disabledMcpServers === undefined) return []
  if (!Array.isArray(value.disabledMcpServers) || value.disabledMcpServers.some(name => typeof name !== 'string' || !SERVER_NAME.test(name))) throw new Error('MCP_CONFIGURATION_INVALID')
  return value.disabledMcpServers as string[]
}

function paths(cwd: string) {
  return {
    user: path.join(getProductConfigDir(), 'settings.json'),
    project: path.join(cwd, '.BilliardBuddy', 'settings.json'),
    local: path.join(cwd, '.BilliardBuddy', 'settings.local.json'),
  }
}

export async function loadProductMcpConfigs(cwd = process.cwd()): Promise<ProductMcpConfigSnapshot> {
  const files = paths(cwd)
  const [user, project, local] = await Promise.all([
    readJson(files.user, getProductConfigDir()), readJson(files.project, cwd), readJson(files.local, cwd),
  ])
  return {
    servers: {
      ...serversFrom(user, 'user'),
      ...serversFrom(project, 'project'),
      ...serversFrom(local, 'local'),
    },
    disabled: new Set([...disabledFrom(user), ...disabledFrom(project), ...disabledFrom(local)]),
  }
}

async function writeJson(filePath: string, value: Record<string, unknown>, allowedRoot: string): Promise<void> {
  await assertContained(filePath, allowedRoot)
  const existing = await fs.lstat(filePath).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('MCP_CONFIGURATION_INVALID')
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await assertContained(filePath, allowedRoot)
  const temporary = `${filePath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', existing?.mode ?? 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, filePath)
    await fs.chmod(filePath, existing?.mode ?? 0o600)
    const directory = await fs.open(path.dirname(filePath), fsConstants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

async function withConfigLocks<T>(filePaths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const guards = [...new Set(filePaths.map(filePath => `${filePath}.guard`))].sort()
  const releases: Array<() => Promise<void>> = []
  try {
    for (const guard of guards) {
      await fs.mkdir(path.dirname(guard), { recursive: true, mode: 0o700 })
      const handle = await fs.open(guard, 'a', 0o600)
      await handle.close()
      releases.push(await lock(guard, {
        stale: 30_000,
        update: 10_000,
        retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
      }))
    }
    return await operation()
  } finally {
    for (const release of releases.reverse()) await release()
  }
}

async function mutateJson(
  filePath: string,
  allowedRoot: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await withConfigLocks([filePath], async () => {
    const current = await readJson(filePath, allowedRoot)
    await writeJson(filePath, update(current), allowedRoot)
  })
}

function scopePath(cwd: string, scope: ProductMcpScope): string {
  const files = paths(cwd)
  return scope === 'user' ? files.user : scope === 'project' ? files.project : files.local
}

function scopeRoot(cwd: string, scope: ProductMcpScope): string {
  return scope === 'user' ? getProductConfigDir() : cwd
}

export async function saveProductMcpServer(name: string, config: ProductMcpServerConfig, scope: ProductMcpScope, cwd = process.cwd()): Promise<void> {
  if (!SERVER_NAME.test(name)) throw new Error('MCP_CONFIGURATION_INVALID')
  const filePath = scopePath(cwd, scope)
  const parsed = parseProductMcpServerConfig(config)
  await mutateJson(filePath, scopeRoot(cwd, scope), current => {
    const servers = object(current.mcpServers) ?? {}
    if (Object.hasOwn(servers, name)) throw new Error('MCP_NAME_CONFLICT')
    return { ...current, mcpServers: { ...servers, [name]: parsed } }
  })
}

export async function replaceProductMcpServer(name: string, config: ProductMcpServerConfig, scope: ProductMcpScope, previousScope: ProductMcpScope, cwd = process.cwd()): Promise<void> {
  if (!SERVER_NAME.test(name)) throw new Error('MCP_CONFIGURATION_INVALID')
  const parsed = parseProductMcpServerConfig(config)
  const targetPath = scopePath(cwd, scope)
  const previousPath = scopePath(cwd, previousScope)
  await withConfigLocks([targetPath, previousPath], async () => {
    const targetRoot = scopeRoot(cwd, scope)
    const previousRoot = scopeRoot(cwd, previousScope)
    if (targetPath === previousPath) {
      const current = await readJson(targetPath, targetRoot)
      const servers = object(current.mcpServers) ?? {}
      if (!Object.hasOwn(servers, name)) throw new Error('MCP_SERVER_NOT_FOUND')
      await writeJson(targetPath, { ...current, mcpServers: { ...servers, [name]: parsed } }, targetRoot)
      return
    }
    const [target, previous] = await Promise.all([
      readJson(targetPath, targetRoot),
      readJson(previousPath, previousRoot),
    ])
    const targetServers = object(target.mcpServers) ?? {}
    const previousServers = object(previous.mcpServers) ?? {}
    if (Object.hasOwn(targetServers, name)) throw new Error('MCP_NAME_CONFLICT')
    if (!Object.hasOwn(previousServers, name)) throw new Error('MCP_SERVER_NOT_FOUND')
    const { [name]: _removed, ...remaining } = previousServers
    await writeJson(targetPath, { ...target, mcpServers: { ...targetServers, [name]: parsed } }, targetRoot)
    try {
      await writeJson(previousPath, {
        ...previous,
        mcpServers: remaining,
        disabledMcpServers: disabledFrom(previous).filter(value => value !== name),
      }, previousRoot)
    } catch (error) {
      await writeJson(targetPath, target, targetRoot).catch(() => undefined)
      throw error
    }
  })
}

export async function removeProductMcpServer(name: string, scope: ProductMcpScope, cwd = process.cwd()): Promise<void> {
  const filePath = scopePath(cwd, scope)
  await mutateJson(filePath, scopeRoot(cwd, scope), current => {
    const servers = object(current.mcpServers) ?? {}
    const { [name]: _removed, ...rest } = servers
    return { ...current, mcpServers: rest, disabledMcpServers: disabledFrom(current).filter(value => value !== name) }
  })
}

export async function setProductMcpEnabled(name: string, enabled: boolean, cwd = process.cwd()): Promise<void> {
  const filePath = paths(cwd).local
  await mutateJson(filePath, cwd, current => {
    const disabled = new Set(disabledFrom(current))
    enabled ? disabled.delete(name) : disabled.add(name)
    return { ...current, disabledMcpServers: [...disabled].sort() }
  })
}
