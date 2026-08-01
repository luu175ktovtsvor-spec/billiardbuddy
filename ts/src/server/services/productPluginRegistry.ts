import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProductConfigDir } from '../product/productPaths.js'
import { parseProductMcpServerConfig, type ScopedProductMcpServerConfig } from '../agent-worker/productMcpConfig.js'
import { syncParentDirectory } from '../../utils/durableFile.js'
import { lock } from '../../utils/lockfile.js'

export type ProductPluginScope = 'user' | 'project'
export type ProductPluginManifest = {
  name: string
  version: string
  skills?: string
  commands?: string
  hooks?: string
  mcpServers?: Record<string, unknown>
  lspServers?: Record<string, ProductPluginLspServerConfig>
}
export type ProductPluginLspServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string>
  extensionToLanguage?: Record<string, string>
}
export type ProductPlugin = {
  id: string
  name: string
  scope: ProductPluginScope
  root: string
  enabled: boolean
  manifest: ProductPluginManifest
}

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_PLUGIN_FILES = 4_096
const MAX_PLUGIN_BYTES = 64 * 1024 * 1024
const MAX_STATE_BYTES = 4 * 1024 * 1024
const SAFE_NAME = /^[\p{L}\p{N}_-]{1,128}$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const LANGUAGE_ID = /^[A-Za-z0-9_+.-]{1,64}$/

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function manifest(value: unknown): ProductPluginManifest {
  const source = object(value)
  if (!source || typeof source.name !== 'string' || !SAFE_NAME.test(source.name) || typeof source.version !== 'string' || !source.version.trim()) throw new Error('PLUGIN_MANIFEST_INVALID')
  // A named-agent bundle used to create a second local model loop. Refuse it
  // at the manifest boundary until it has a durable Codex child-Run format.
  if (source.agents !== undefined) throw new Error('PLUGIN_MANIFEST_INVALID')
  for (const key of ['skills', 'commands', 'hooks'] as const) {
    if (source[key] !== undefined && (typeof source[key] !== 'string' || path.isAbsolute(source[key]) || source[key].split(/[\\/]/).includes('..'))) throw new Error('PLUGIN_MANIFEST_INVALID')
  }
  const rawMcp = source.mcpServers === undefined ? undefined : object(source.mcpServers)
  if (source.mcpServers !== undefined && !rawMcp) throw new Error('PLUGIN_MANIFEST_INVALID')
  const mcpServers = rawMcp ? Object.fromEntries(Object.entries(rawMcp).map(([name, config]) => {
    if (!SAFE_NAME.test(name)) throw new Error('PLUGIN_MANIFEST_INVALID')
    try { return [name, parseProductMcpServerConfig(config)] } catch { throw new Error('PLUGIN_MANIFEST_INVALID') }
  })) : undefined
  const rawLsp = source.lspServers === undefined ? undefined : object(source.lspServers)
  if (source.lspServers !== undefined && !rawLsp) throw new Error('PLUGIN_MANIFEST_INVALID')
  const lspServers = rawLsp ? Object.fromEntries(Object.entries(rawLsp).map(([name, value]) => {
    if (!SAFE_NAME.test(name)) throw new Error('PLUGIN_MANIFEST_INVALID')
    const config = object(value)
    if (!config || typeof config.command !== 'string' || !config.command.trim() || config.command.length > 8_192 || config.command.includes('\0')) throw new Error('PLUGIN_MANIFEST_INVALID')
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.length > 256 || config.args.some(item => typeof item !== 'string' || item.length > 8_192 || item.includes('\0')))) throw new Error('PLUGIN_MANIFEST_INVALID')
    const env = config.env === undefined ? undefined : object(config.env)
    if (config.env !== undefined && (!env || Object.entries(env).length > 128 || Object.entries(env).some(([key, item]) => !ENV_NAME.test(key) || typeof item !== 'string' || item.length > 65_536 || item.includes('\0')))) throw new Error('PLUGIN_MANIFEST_INVALID')
    const mapping = config.extensionToLanguage === undefined ? undefined : object(config.extensionToLanguage)
    if (config.extensionToLanguage !== undefined && (!mapping || Object.entries(mapping).length > 256 || Object.entries(mapping).some(([extension, language]) => !/^\.?[A-Za-z0-9_+-]{1,32}$/.test(extension) || typeof language !== 'string' || !LANGUAGE_ID.test(language)))) throw new Error('PLUGIN_MANIFEST_INVALID')
    return [name, {
      command: config.command.trim(),
      ...(Array.isArray(config.args) ? { args: config.args as string[] } : {}),
      ...(env ? { env: env as Record<string, string> } : {}),
      ...(mapping ? { extensionToLanguage: mapping as Record<string, string> } : {}),
    } satisfies ProductPluginLspServerConfig]
  })) : undefined
  return {
    name: source.name,
    version: source.version.trim(),
    ...Object.fromEntries((['skills', 'commands', 'hooks'] as const).flatMap(key => typeof source[key] === 'string' ? [[key, source[key]]] : [])),
    ...(mcpServers ? { mcpServers } : {}),
    ...(lspServers ? { lspServers } : {}),
  } as ProductPluginManifest
}

function pluginRoots(cwd: string): Array<{ scope: ProductPluginScope; root: string }> {
  return [
    { scope: 'user', root: path.join(getProductConfigDir(), 'plugins') },
    { scope: 'project', root: path.join(cwd, '.BilliardBuddy', 'plugins') },
  ]
}

function statePath(cwd: string, scope: ProductPluginScope): string {
  return scope === 'user'
    ? path.join(getProductConfigDir(), 'plugins-state.json')
    : path.join(cwd, '.BilliardBuddy', 'plugins-state.json')
}

function sourcesPath(cwd: string, scope: ProductPluginScope): string {
  return scope === 'user'
    ? path.join(getProductConfigDir(), 'plugins-sources.json')
    : path.join(cwd, '.BilliardBuddy', 'plugins-sources.json')
}

function stateRoot(cwd: string, scope: ProductPluginScope): string {
  return scope === 'user' ? getProductConfigDir() : cwd
}

function inside(root: string, candidate: string): boolean {
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
      suffix.push(path.basename(current)); current = parent
    }
  }
}

async function assertStatePath(file: string, cwd: string, scope: ProductPluginScope): Promise<void> {
  const [root, candidate] = await Promise.all([canonicalProjected(stateRoot(cwd, scope)), canonicalProjected(file)])
  if (!inside(root, candidate)) throw new Error('PLUGIN_STATE_INVALID')
}

async function readMap<T extends string | boolean>(
  file: string,
  cwd: string,
  scope: ProductPluginScope,
  validate: (value: unknown) => value is T,
  errorCode: string,
): Promise<Record<string, T>> {
  try {
    await assertStatePath(file, cwd, scope)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw new Error()
    const source = object(JSON.parse(await fs.readFile(file, 'utf8')))
    if (!source || Object.values(source).some(value => !validate(value))) throw new Error()
    return source as Record<string, T>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(errorCode)
  }
}

async function readSources(cwd: string, scope: ProductPluginScope): Promise<Record<string, string>> {
  return readMap(sourcesPath(cwd, scope), cwd, scope, (value): value is string => typeof value === 'string' && value.length <= 8_192 && !value.includes('\0'), 'PLUGIN_SOURCE_STATE_INVALID')
}

async function readState(cwd: string, scope: ProductPluginScope): Promise<Record<string, boolean>> {
  return readMap(statePath(cwd, scope), cwd, scope, (value): value is boolean => typeof value === 'boolean', 'PLUGIN_STATE_INVALID')
}

async function writeMap<T extends string | boolean>(filePath: string, cwd: string, scope: ProductPluginScope, state: Record<string, T>): Promise<void> {
  await assertStatePath(filePath, cwd, scope)
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await assertStatePath(filePath, cwd, scope)
  const existing = await fs.lstat(filePath).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(error))
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('PLUGIN_STATE_INVALID')
  const temporary = `${filePath}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', existing?.mode ?? 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally { await handle.close() }
  try {
    await fs.rename(temporary, filePath)
    await syncParentDirectory(filePath)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

async function mutateMap<T extends string | boolean>(input: {
  file: string
  cwd: string
  scope: ProductPluginScope
  read: () => Promise<Record<string, T>>
  update: (current: Record<string, T>) => Record<string, T>
}): Promise<void> {
  await assertStatePath(input.file, input.cwd, input.scope)
  await fs.mkdir(path.dirname(input.file), { recursive: true, mode: 0o700 })
  const guard = `${input.file}.guard`
  await fs.open(guard, 'a', 0o600).then(handle => handle.close())
  const release = await lock(guard, { stale: 30_000, retries: { retries: 100, minTimeout: 5, maxTimeout: 25 } })
  try { await writeMap(input.file, input.cwd, input.scope, input.update(await input.read())) } finally { await release() }
}

async function mutateState(cwd: string, scope: ProductPluginScope, update: (current: Record<string, boolean>) => Record<string, boolean>): Promise<void> {
  await mutateMap({ file: statePath(cwd, scope), cwd, scope, read: () => readState(cwd, scope), update })
}

async function mutateSources(cwd: string, scope: ProductPluginScope, update: (current: Record<string, string>) => Record<string, string>): Promise<void> {
  await mutateMap({ file: sourcesPath(cwd, scope), cwd, scope, read: () => readSources(cwd, scope), update })
}

function child(root: string, relative: string): string {
  const result = path.resolve(root, relative)
  const rel = path.relative(root, result)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('PLUGIN_MANIFEST_INVALID')
  return result
}

export async function listProductPlugins(cwd = process.cwd()): Promise<ProductPlugin[]> {
  const output: ProductPlugin[] = []
  for (const source of pluginRoots(cwd)) {
    const state = await readState(cwd, source.scope)
    const entries = await fs.readdir(source.root, { withFileTypes: true }).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(error))
    const base = await fs.realpath(source.root).catch(() => '')
    const allowed = await fs.realpath(stateRoot(cwd, source.scope)).catch(() => '')
    if (!base || !allowed || !inside(allowed, base)) continue
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) continue
      const candidate = path.join(source.root, entry.name)
      const root = await fs.realpath(candidate)
      const relative = path.relative(base, root)
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue
      const manifestPath = path.join(root, '.BilliardBuddy-plugin', 'plugin.json')
      const stat = await fs.lstat(manifestPath).catch(() => undefined)
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) continue
      try {
        const parsed = manifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')))
        const id = `${source.scope}:${entry.name}`
        output.push({ id, name: parsed.name, scope: source.scope, root, enabled: state[id] !== false, manifest: parsed })
      } catch { continue }
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id))
}

export async function setProductPluginEnabled(id: string, enabled: boolean, cwd = process.cwd()): Promise<void> {
  const plugin = (await listProductPlugins(cwd)).find(value => value.id === id)
  if (!plugin) throw new Error('PLUGIN_NOT_FOUND')
  await mutateState(cwd, plugin.scope, state => ({ ...state, [id]: enabled }))
}

export async function uninstallProductPlugin(id: string, cwd = process.cwd()): Promise<void> {
  const plugin = (await listProductPlugins(cwd)).find(value => value.id === id)
  if (!plugin) throw new Error('PLUGIN_NOT_FOUND')
  await fs.rm(plugin.root, { recursive: true, force: false })
  await mutateState(cwd, plugin.scope, state => { const next = { ...state }; delete next[id]; return next })
  await mutateSources(cwd, plugin.scope, sources => { const next = { ...sources }; delete next[id]; return next })
}

async function readManifestFromRoot(root: string): Promise<ProductPluginManifest> {
  const boundary = await fs.realpath(root)
  const file = path.join(boundary, '.BilliardBuddy-plugin', 'plugin.json')
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw new Error('PLUGIN_MANIFEST_INVALID')
  const canonical = await fs.realpath(file)
  const relative = path.relative(boundary, canonical)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PLUGIN_MANIFEST_INVALID')
  return manifest(JSON.parse(await fs.readFile(canonical, 'utf8')))
}

async function copyPluginTree(source: string, destination: string): Promise<void> {
  let files = 0
  let bytes = 0
  const copyDirectory = async (from: string, to: string): Promise<void> => {
    await fs.mkdir(to, { mode: 0o700 })
    const entries = await fs.readdir(from, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('PLUGIN_SOURCE_INVALID')
      const sourcePath = path.join(from, entry.name)
      const targetPath = path.join(to, entry.name)
      if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath)
      else if (entry.isFile()) {
        const stat = await fs.lstat(sourcePath)
        files += 1; bytes += stat.size
        if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) throw new Error('PLUGIN_SOURCE_TOO_LARGE')
        await fs.copyFile(sourcePath, targetPath)
        await fs.chmod(targetPath, stat.mode & 0o755).catch(() => undefined)
      } else throw new Error('PLUGIN_SOURCE_INVALID')
    }
  }
  await copyDirectory(source, destination)
}

async function validatedSource(sourcePath: string): Promise<{ root: string; manifest: ProductPluginManifest }> {
  if (!sourcePath || sourcePath.length > 8_192 || sourcePath.includes('\0')) throw new Error('PLUGIN_SOURCE_INVALID')
  const root = await fs.realpath(sourcePath)
  if (!(await fs.lstat(root)).isDirectory()) throw new Error('PLUGIN_SOURCE_INVALID')
  return { root, manifest: await readManifestFromRoot(root) }
}

export async function installProductPluginFromDirectory(sourcePath: string, scope: ProductPluginScope, cwd = process.cwd()): Promise<ProductPlugin> {
  const source = await validatedSource(sourcePath)
  const installRoot = pluginRoots(cwd).find(value => value.scope === scope)!.root
  await assertStatePath(path.join(installRoot, source.manifest.name), cwd, scope)
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 })
  await assertStatePath(path.join(installRoot, source.manifest.name), cwd, scope)
  const destination = path.join(installRoot, source.manifest.name)
  if (await fs.lstat(destination).then(() => true).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : Promise.reject(error))) throw new Error('PLUGIN_NAME_CONFLICT')
  const projected = path.relative(source.root, destination)
  if (projected === '' || (!projected.startsWith('..') && !path.isAbsolute(projected))) throw new Error('PLUGIN_SOURCE_INVALID')
  const staging = path.join(installRoot, `.install-${randomUUID()}`)
  try {
    await copyPluginTree(source.root, staging)
    await readManifestFromRoot(staging)
    await fs.rename(staging, destination)
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined) }
  const id = `${scope}:${source.manifest.name}`
  await mutateSources(cwd, scope, sources => ({ ...sources, [id]: source.root }))
  const plugin = (await listProductPlugins(cwd)).find(value => value.id === id)
  if (!plugin) throw new Error('PLUGIN_INSTALL_INVALID')
  return plugin
}

export async function hasProductPluginUpdateSource(id: string, scope: ProductPluginScope, cwd = process.cwd()): Promise<boolean> {
  return typeof (await readSources(cwd, scope))[id] === 'string'
}

export async function updateProductPluginFromSource(id: string, cwd = process.cwd()): Promise<void> {
  const plugin = (await listProductPlugins(cwd)).find(value => value.id === id)
  if (!plugin) throw new Error('PLUGIN_NOT_FOUND')
  const sourcePath = (await readSources(cwd, plugin.scope))[id]
  if (!sourcePath) throw new Error('PLUGIN_UPDATE_UNAVAILABLE')
  const source = await validatedSource(sourcePath)
  if (source.manifest.name !== plugin.manifest.name) throw new Error('PLUGIN_MANIFEST_INVALID')
  const installRoot = path.dirname(plugin.root)
  const staging = path.join(installRoot, `.update-${randomUUID()}`)
  const previous = path.join(installRoot, `.previous-${randomUUID()}`)
  let movedPrevious = false
  try {
    await copyPluginTree(source.root, staging)
    await readManifestFromRoot(staging)
    await fs.rename(plugin.root, previous); movedPrevious = true
    await fs.rename(staging, plugin.root)
    await fs.rm(previous, { recursive: true, force: true })
  } catch (error) {
    if (movedPrevious) {
      await fs.rm(plugin.root, { recursive: true, force: true }).catch(() => undefined)
      await fs.rename(previous, plugin.root).catch(() => undefined)
    }
    throw error
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function productPluginSkillRoots(plugin: ProductPlugin): string[] {
  if (!plugin.enabled) return []
  return plugin.manifest.skills ? [child(plugin.root, plugin.manifest.skills)] : []
}

export function productPluginCommandRoots(plugin: ProductPlugin): string[] {
  return plugin.enabled && plugin.manifest.commands ? [child(plugin.root, plugin.manifest.commands)] : []
}

export function productPluginHookFiles(plugin: ProductPlugin): string[] {
  return plugin.enabled && plugin.manifest.hooks ? [child(plugin.root, plugin.manifest.hooks)] : []
}

export function productPluginMcpServers(plugin: ProductPlugin): Record<string, ScopedProductMcpServerConfig> {
  if (!plugin.enabled || !plugin.manifest.mcpServers) return {}
  return Object.fromEntries(Object.entries(plugin.manifest.mcpServers).map(([name, raw]) => {
    const expanded = JSON.parse(JSON.stringify(raw).replaceAll('${BILLIARDBUDDY_PLUGIN_ROOT}', plugin.root))
    return [`plugin__${plugin.name}__${name}`, { ...parseProductMcpServerConfig(expanded), scope: plugin.scope }]
  }))
}

export function productPluginLspServers(plugin: ProductPlugin): Array<{ plugin: string; name: string; root: string; config: ProductPluginLspServerConfig }> {
  if (!plugin.enabled || !plugin.manifest.lspServers) return []
  return Object.entries(plugin.manifest.lspServers).map(([name, config]) => ({
    plugin: plugin.name,
    name,
    root: plugin.root,
    config: {
      ...config,
      command: config.command.replaceAll('${BILLIARDBUDDY_PLUGIN_ROOT}', plugin.root),
      ...(config.args ? { args: config.args.map(value => value.replaceAll('${BILLIARDBUDDY_PLUGIN_ROOT}', plugin.root)) } : {}),
      ...(config.env ? { env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, value.replaceAll('${BILLIARDBUDDY_PLUGIN_ROOT}', plugin.root)])) } : {}),
    },
  }))
}
