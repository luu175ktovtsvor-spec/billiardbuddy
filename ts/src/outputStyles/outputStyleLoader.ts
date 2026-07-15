import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { extractDescription, parseMarkdownDocument, stringField } from '../commands/frontmatter'
import { getUserConfigHomeDir } from '../harness/memoryNames'
import { LIBRARY_DIR_ENV, isLocalMode } from '../harness/desktopEnvNames'

export interface OutputStyle {
  name: string
  description: string
  prompt: string
  source: string
  filePath: string
}

/** buildSystemPrompt 消费的风格配置:选了风格才非空。 */
export interface OutputStyleConfig {
  prompt: string
}

export interface OutputStyleLibrary {
  styles: OutputStyle[]
  byName: Map<string, OutputStyle>
}

function safeName(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

async function loadStyleFile(filePath: string, source: string): Promise<OutputStyle | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const doc = parseMarkdownDocument(raw)
    const name = safeName(stringField(doc.frontmatter, 'name') ?? basename(filePath, '.md'))
    if (!name) return null
    const description = stringField(doc.frontmatter, 'description') ?? extractDescription(doc.body) ?? name
    return { name, description, prompt: doc.body.trim(), source, filePath }
  } catch {
    return null
  }
}

async function loadStylesDir(rootDir: string, source: string): Promise<OutputStyle[]> {
  let entries: string[] = []
  try {
    entries = await readdir(rootDir)
  } catch {
    return []
  }
  const out: OutputStyle[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || !entry.toLowerCase().endsWith('.md')) continue
    const filePath = join(rootDir, entry)
    try {
      const s = await stat(filePath)
      if (!s.isFile()) continue
      const style = await loadStyleFile(filePath, source)
      if (style) out.push(style)
    } catch {
      continue
    }
  }
  return out
}

export function defaultOutputStyleDirs(_cwd = process.cwd(), env: Record<string, string | undefined> = process.env): Array<{ source: string; dir: string }> {
  const dirs: Array<{ source: string; dir: string }> = []
  // 白标:用户全局输出风格走 getUserConfigHomeDir()(~/.billiardbuddy,BILLIARDBUDDY_CONFIG_DIR 可覆盖),绝不读 ~/.claude。
  if (!isLocalMode(env)) {
    dirs.push({ source: 'user', dir: join(getUserConfigHomeDir(), 'output-styles') })
  }
  const libraryDir = env[LIBRARY_DIR_ENV]
  if (libraryDir) {
    dirs.push({ source: 'project', dir: join(libraryDir, 'output-styles') })
  }
  return dirs
}

export async function loadOutputStyles(dirs = defaultOutputStyleDirs()): Promise<OutputStyleLibrary> {
  const byName = new Map<string, OutputStyle>()
  for (const { source, dir } of dirs) {
    for (const style of await loadStylesDir(dir, source)) {
      byName.set(style.name, style)
    }
  }
  return { styles: [...byName.values()], byName }
}

export function publicOutputStyle(style: OutputStyle) {
  return {
    name: style.name,
    description: style.description,
    source: style.source,
  }
}

export function renderOutputStylePrompt(library: OutputStyleLibrary, name: string | undefined): string {
  if (!name) return ''
  const style = library.byName.get(safeName(name))
  if (!style?.prompt) return ''
  return `【输出风格 · ${style.name}】\n${style.prompt}`
}

/**
 * 解析选中的风格为 buildSystemPrompt 消费的配置:未选/未命中 → null;命中 → { prompt }。
 * 编码工具节奏与改后验证已迁到按需加载的 code-change-workflow skill,不再由输出风格门控。
 */
export function resolveOutputStyleConfig(library: OutputStyleLibrary, name: string | undefined): OutputStyleConfig | null {
  if (!name) return null
  const style = library.byName.get(safeName(name))
  if (!style?.prompt) return null
  return { prompt: `【输出风格 · ${style.name}】\n${style.prompt}` }
}

export function styleRootOf(style: OutputStyle): string {
  return dirname(style.filePath)
}
