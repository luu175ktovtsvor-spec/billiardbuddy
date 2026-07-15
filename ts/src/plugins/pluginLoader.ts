import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { getUserConfigHomeDir, MEMORY_DOT_DIR } from '../harness/memoryNames'
import { LIBRARY_DIR_ENV, desktopLibraryBase, isLocalMode } from '../harness/desktopEnvNames'

export interface PluginListItem {
  name: string
  enabled: boolean
  dir: string
  description: string
  components: {
    skills: number
    commands: number
    hooks: number
    'output-styles': number
    mcp: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function countDirEntries(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => !entry.name.startsWith('.')).length
  } catch {
    return 0
  }
}

async function readManifest(pluginDir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(join(pluginDir, 'plugin.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function pluginChildPath(pluginDir: string, relativePath: string): string | undefined {
  const root = resolve(pluginDir)
  const candidate = resolve(root, relativePath)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined
  if (!existsSync(candidate)) return candidate
  try {
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${sep}`) ? candidate : undefined
  } catch {
    return undefined
  }
}

function pluginHookConfigPaths(pluginDir: string, manifest: Record<string, unknown>): string[] {
  const candidates = [join(pluginDir, 'hooks', 'hooks.json')]
  const declared = stringField(manifest.hooks)
  if (declared) {
    const safePath = pluginChildPath(pluginDir, declared)
    if (safePath) candidates.push(safePath)
  }
  return [...new Set(candidates)].filter(existsSync)
}

export function defaultPluginRoots(env: Record<string, string | undefined> = process.env): string[] {
  if (isLocalMode(env)) {
    return [join(desktopLibraryBase(env), 'plugins')]
  }
  const libraryDir = env[LIBRARY_DIR_ENV]
  return [
    // 白标:用户全局插件根走 memoryNames.getUserConfigHomeDir()(~/.billiardbuddy,env
    // BILLIARDBUDDY_CONFIG_DIR 可覆盖),绝不读 ~/.claude;项目级用 MEMORY_DOT_DIR(.billiardbuddy)。
    join(getUserConfigHomeDir(), 'plugins'),
    join(process.cwd(), MEMORY_DOT_DIR, 'plugins'),
    ...(libraryDir ? [join(libraryDir, 'plugins')] : []),
  ]
}

export function defaultPluginInstallDir(env: Record<string, string | undefined> = process.env): string {
  if (isLocalMode(env)) {
    return join(desktopLibraryBase(env), 'plugins')
  }
  return join(getUserConfigHomeDir(), 'plugins')
}

export async function listPlugins(roots = defaultPluginRoots()): Promise<PluginListItem[]> {
  const found = new Set<string>()
  const out: PluginListItem[] = []
  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.')) continue
      const dir = join(root, entry)
      if (!existsSync(dir)) continue
      const manifest = await readManifest(dir)
      const name = stringField(manifest.name) || entry
      if (!name || found.has(name)) continue
      found.add(name)
      out.push({
        name,
        enabled: manifest.enabled === true,
        dir,
        description: stringField(manifest.description),
        components: {
          skills: await countDirEntries(join(dir, 'skills')),
          commands: await countDirEntries(join(dir, 'commands')),
          hooks: pluginHookConfigPaths(dir, manifest).length,
          'output-styles': await countDirEntries(join(dir, 'output-styles')),
          mcp: existsSync(join(dir, '.mcp.json')) ? 1 : 0,
        },
      })
    }
  }
  return out
}

export interface EnabledPluginContributions {
  /** 启用插件各自的 skills 目录(存在才收) */
  skillsDirs: string[]
  /** 启用插件各自的 commands 目录 */
  commandsDirs: string[]
  /** 启用插件各自的 .mcp.json(app 级可信,直接加载不走工作区信任闸) */
  mcpConfigPaths: string[]
  /** 启用插件的标准 hooks/hooks.json 和 manifest.hooks 安全相对路径 */
  hookConfigPaths: string[]
}

/** 解析已启用插件的 skills/commands/.mcp.json 贡献,供会话构建时并入(plugin 运行时接入)。 */
export async function resolveEnabledPluginContributions(roots = defaultPluginRoots()): Promise<EnabledPluginContributions> {
  const plugins = await listPlugins(roots)
  const skillsDirs: string[] = []
  const commandsDirs: string[] = []
  const mcpConfigPaths: string[] = []
  const hookConfigPaths: string[] = []
  for (const p of plugins) {
    if (!p.enabled) continue
    const skillsDir = join(p.dir, 'skills')
    if (existsSync(skillsDir)) skillsDirs.push(skillsDir)
    const commandsDir = join(p.dir, 'commands')
    if (existsSync(commandsDir)) commandsDirs.push(commandsDir)
    const mcpPath = join(p.dir, '.mcp.json')
    if (existsSync(mcpPath)) mcpConfigPaths.push(mcpPath)
    const manifest = await readManifest(p.dir)
    hookConfigPaths.push(...pluginHookConfigPaths(p.dir, manifest))
  }
  return { skillsDirs, commandsDirs, mcpConfigPaths, hookConfigPaths }
}

/**
 * 解析已启用插件的 hooks 配置文件绝对路径(供会话构建时经 loadPluginHookRegistry 并入 hook 注册表)。
 *
 * 对齐 cc(pluginLoader.ts:1620-1662):标准位置 `<plugin>/hooks/hooks.json` 自动加载,外加 manifest.hooks
 * 显式声明的附加文件(相对插件根)。这里收全存在的候选、去重,交给 loadPluginHookRegistry 归一+合并。
 * 只收显式 `enabled:true` 的插件;同名插件按 roots 顺序首见者胜(与 listPlugins 一致)。
 */
export async function resolveEnabledPluginHookConfigPaths(roots = defaultPluginRoots()): Promise<string[]> {
  return (await resolveEnabledPluginContributions(roots)).hookConfigPaths
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
  const tmp = `${filePath}.tmp`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, filePath)
}

export async function setPluginEnabled(
  name: unknown,
  enabled: unknown,
  roots = defaultPluginRoots(),
): Promise<{ ok: boolean; message: string }> {
  const pluginName = typeof name === 'string' ? name.trim() : ''
  if (!pluginName) return { ok: false, message: '没说要操作哪个插件。' }
  for (const plugin of await listPlugins(roots)) {
    if (plugin.name !== pluginName) continue
    const manifestPath = join(plugin.dir, 'plugin.json')
    const manifest = await readManifest(plugin.dir)
    manifest.name = manifest.name || pluginName
    manifest.enabled = enabled === true
    await atomicWriteJson(manifestPath, manifest)
    return { ok: true, message: enabled === true ? `已启用「${pluginName}」。` : `已停用「${pluginName}」。` }
  }
  return { ok: false, message: `没找到插件「${pluginName}」。` }
}

const GITHUB_REPOSITORY_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/

export function parseGithubRepository(value: unknown): { name: string; url: string } | null {
  const input = typeof value === 'string' ? value.trim() : ''
  if (!input) return null

  let owner = ''
  let repository = ''
  if (!input.includes('://')) {
    const parts = input.split('/')
    if (parts.length !== 2) return null
    owner = parts[0] ?? ''
    repository = parts[1] ?? ''
  } else {
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      return null
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== 'github.com' ||
      parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
    ) return null
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length !== 2) return null
    owner = parts[0] ?? ''
    repository = parts[1] ?? ''
  }

  repository = repository.replace(/\.git$/i, '')
  if (
    !GITHUB_REPOSITORY_PART_RE.test(owner) ||
    !GITHUB_REPOSITORY_PART_RE.test(repository) ||
    owner === '.' || owner === '..' || repository === '.' || repository === '..'
  ) return null
  return { name: repository, url: `https://github.com/${owner}/${repository}.git` }
}

export async function installPluginFromGithub(
  repoValue: unknown,
  installDir = defaultPluginInstallDir(),
): Promise<{ ok: boolean; message: string }> {
  const repository = parseGithubRepository(repoValue)
  if (!repository) return { ok: false, message: '仅支持 owner/repo 或 https://github.com/owner/repo。' }
  const { name, url } = repository

  const dest = join(installDir, name)
  if (existsSync(dest)) return { ok: false, message: `插件目录已存在：${name}。` }
  await mkdir(installDir, { recursive: true })
  const proc = Bun.spawn(['git', 'clone', '--depth', '1', url, dest], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ''),
    new Response(proc.stderr).text().catch(() => ''),
  ])
  if (code !== 0) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined)
    const detail = (stderr || stdout || '').trim().slice(0, 300)
    return { ok: false, message: `clone 失败${detail ? `：${detail}` : ''}` }
  }
  if (!existsSync(join(dest, 'plugin.json'))) {
    await rm(dest, { recursive: true, force: true })
    return { ok: false, message: '仓库根目录缺少 plugin.json，未安装。' }
  }
  const manifest = await readManifest(dest)
  if (Object.keys(manifest).length === 0) {
    await rm(dest, { recursive: true, force: true })
    return { ok: false, message: 'plugin.json 格式不正确，未安装。' }
  }
  manifest.name = stringField(manifest.name) || name
  manifest.enabled = false
  await atomicWriteJson(join(dest, 'plugin.json'), manifest)
  return { ok: true, message: `已安装插件：${name}。启用前请先确认来源可信。` }
}
