import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export interface PluginListItem {
  name: string
  enabled: boolean
  dir: string
  description: string
  components: {
    skills: number
    commands: number
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

function homeFrom(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || process.cwd()
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

export function defaultPluginRoots(env: Record<string, string | undefined> = process.env): string[] {
  if (env.DESKTOP_LOCAL === '1') {
    const base = env.DESKTOP_LIBRARY_DIR || join(homeFrom(env), '.billiards-desktop', 'library')
    return [join(base, 'plugins')]
  }
  return [
    join(homeFrom(env), '.claude', 'plugins'),
    join(process.cwd(), '.claude', 'plugins'),
    ...(env.DESKTOP_LIBRARY_DIR ? [join(env.DESKTOP_LIBRARY_DIR, 'plugins')] : []),
  ]
}

export function defaultPluginInstallDir(env: Record<string, string | undefined> = process.env): string {
  if (env.DESKTOP_LOCAL === '1') {
    const base = env.DESKTOP_LIBRARY_DIR || join(homeFrom(env), '.billiards-desktop', 'library')
    return join(base, 'plugins')
  }
  return join(homeFrom(env), '.claude', 'plugins')
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
        enabled: manifest.enabled !== false,
        dir,
        description: stringField(manifest.description),
        components: {
          skills: await countDirEntries(join(dir, 'skills')),
          commands: await countDirEntries(join(dir, 'commands')),
          'output-styles': await countDirEntries(join(dir, 'output-styles')),
          mcp: existsSync(join(dir, '.mcp.json')) || isRecord(manifest.mcpServers) ? 1 : 0,
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
}

/** 解析已启用插件的 skills/commands/.mcp.json 贡献,供会话构建时并入(plugin 运行时接入)。 */
export async function resolveEnabledPluginContributions(roots = defaultPluginRoots()): Promise<EnabledPluginContributions> {
  const plugins = await listPlugins(roots)
  const skillsDirs: string[] = []
  const commandsDirs: string[] = []
  const mcpConfigPaths: string[] = []
  for (const p of plugins) {
    if (!p.enabled) continue
    const skillsDir = join(p.dir, 'skills')
    if (existsSync(skillsDir)) skillsDirs.push(skillsDir)
    const commandsDir = join(p.dir, 'commands')
    if (existsSync(commandsDir)) commandsDirs.push(commandsDir)
    const mcpPath = join(p.dir, '.mcp.json')
    if (existsSync(mcpPath)) mcpConfigPaths.push(mcpPath)
  }
  return { skillsDirs, commandsDirs, mcpConfigPaths }
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

export async function installPluginFromGithub(
  repoValue: unknown,
  installDir = defaultPluginInstallDir(),
): Promise<{ ok: boolean; message: string }> {
  const repo = typeof repoValue === 'string' ? repoValue.trim() : ''
  if (!repo) return { ok: false, message: '没给 repo（owner/repo 或 https url）。' }
  let url = ''
  let name = ''
  if (/^https?:\/\//.test(repo)) {
    url = repo
    name = repo.replace(/\/$/, '').split('/').pop()?.replace(/\.git$/, '') ?? ''
  } else if (repo.includes('/') && !repo.startsWith('/') && !/\s/.test(repo)) {
    url = `https://github.com/${repo}.git`
    name = repo.split('/').pop() ?? ''
  }
  if (!url || !name) return { ok: false, message: '格式应为 owner/repo 或 https://... url。' }

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
    const detail = (stderr || stdout || '').trim().slice(0, 300)
    return { ok: false, message: `clone 失败${detail ? `：${detail}` : ''}` }
  }
  return { ok: true, message: `已安装插件：${name}。` }
}
